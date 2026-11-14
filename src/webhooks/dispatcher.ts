import type { Db } from "../db/index.js";
import { enqueueEvent } from "../events.js";
import { signPayload } from "./signature.js";

/** PLAN section 13: retry after 1 min, 5 min, 30 min, 2 h and 6 h, then give up (6 attempts in all). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
const MAX_ERROR_LENGTH = 300;
const DEFAULT_TICK_MS = 2_000;
/** While a send is in flight its event is not due, so no other sender picks it up. This is slack on top of the timeout. */
const CLAIM_SLACK_MS = 5_000;

export interface DispatcherDeps {
  db: Db;
  /** Where events go: WEBHOOK_URL, or what was saved in the dashboard. A function is asked on every send, so a change applies at once. */
  url: string | (() => string);
  /** WEBHOOK_SECRET. Used to sign; never logged, never sent. */
  secret: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
  log?: { error(message: string, error: unknown): void };
  /** Per request. PLAN section 13: 10 seconds. */
  timeoutMs?: number;
  /** Events sent per pass. */
  batchSize?: number;
}

export interface DeliveryResult {
  id: string;
  delivered: boolean;
  /** The HTTP status, or null if no response arrived. */
  status: number | null;
  error: string | null;
  attempts: number;
  /** This was the last attempt and it failed. */
  gaveUp: boolean;
}

interface DeliveryRow {
  id: string;
  payload_json: string;
  attempts: number;
  delivered_at: string | null;
}

const describeError = (error: unknown, timeoutMs: number) => {
  if (error instanceof Error && error.name === "TimeoutError") return `timed out after ${timeoutMs} ms`;
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
};

/**
 * Delivers the events queued in `webhook_deliveries` to the merchant's WEBHOOK_URL, signed with HMAC-SHA256.
 * Delivery is at least once: a crash between a successful send and the database update causes a repeat, so
 * receivers dedupe on the Tilll-Event-Id header.
 */
export function createDispatcher(deps: DispatcherDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const batchSize = deps.batchSize ?? 50;
  const log = deps.log ?? { error: (message: string, error: unknown) => console.error(message, error) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;
  /** Aborted by `stop()`, so a hung endpoint cannot hold shutdown up. */
  let abort = new AbortController();

  async function send(row: DeliveryRow): Promise<DeliveryResult> {
    const at = now();
    // Claim the event: until this send ends it is not due, so the background pass and a manual send cannot both send it.
    const { next_try_at: before } = db
      .prepare("SELECT next_try_at FROM webhook_deliveries WHERE id = ?")
      .get(row.id) as {
      next_try_at: string | null;
    };
    db.prepare("UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?").run(
      new Date(at.getTime() + timeoutMs + CLAIM_SLACK_MS).toISOString(),
      row.id,
    );
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), abort.signal]);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const response = await doFetch(typeof deps.url === "function" ? deps.url() : deps.url, {
        method: "POST",
        // A redirect would forward a signed body to a host the merchant never named.
        redirect: "manual",
        signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Tilll-Webhooks/1",
          "Tilll-Event-Id": row.id,
          // A fresh timestamp on every attempt, so a retry is not rejected as a replay.
          "Tilll-Signature": signPayload(deps.secret, Math.floor(at.getTime() / 1000), row.payload_json),
        },
        body: row.payload_json,
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (status < 200 || status > 299) error = `HTTP ${status}`;
    } catch (e) {
      if (abort.signal.aborted) {
        // Being stopped is not a failed delivery: put the event back as it was, due as before.
        db.prepare("UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?").run(before, row.id);
        return { id: row.id, delivered: false, status: null, error: "stopped", attempts: row.attempts, gaveUp: false };
      }
      error = describeError(e, timeoutMs);
      log.error(`Webhook ${row.id} could not be delivered`, e);
    }

    const attempts = row.attempts + 1;
    let gaveUp = false;
    if (error === null) {
      db.prepare(
        "UPDATE webhook_deliveries SET attempts = ?, delivered_at = ?, next_try_at = NULL, last_error = NULL WHERE id = ?",
      ).run(attempts, at.toISOString(), row.id);
    } else {
      const delay = RETRY_DELAYS_MS[attempts - 1];
      gaveUp = delay === undefined;
      db.prepare("UPDATE webhook_deliveries SET attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?").run(
        attempts,
        gaveUp ? null : new Date(at.getTime() + delay!).toISOString(),
        error,
        row.id,
      );
    }
    return { id: row.id, delivered: error === null, status, error, attempts, gaveUp };
  }

  /** One pass: send every event that is due, oldest first, up to the batch size. */
  async function deliverDue() {
    const due = db
      .prepare(
        `SELECT id, payload_json, attempts, delivered_at FROM webhook_deliveries
         WHERE delivered_at IS NULL AND next_try_at IS NOT NULL AND next_try_at <= ?
         ORDER BY rowid LIMIT ?`,
      )
      .all(now().toISOString(), batchSize) as DeliveryRow[];
    const totals = { delivered: 0, failed: 0, gaveUp: 0 };
    for (const row of due) {
      if (abort.signal.aborted) break;
      const result = await send(row);
      if (result.error === "stopped") break;
      if (result.delivered) totals.delivered++;
      else if (result.gaveUp) totals.gaveUp++;
      else totals.failed++;
    }
    return totals;
  }

  /** Send one event now, whatever its schedule. An already delivered event is not sent again unless forced. */
  async function deliver(id: string, options: { force?: boolean } = {}): Promise<DeliveryResult> {
    const row = db
      .prepare("SELECT id, payload_json, attempts, delivered_at FROM webhook_deliveries WHERE id = ?")
      .get(id) as DeliveryRow | undefined;
    if (!row) throw new Error(`No webhook event ${id}`);
    if (row.delivered_at && !options.force) {
      return { id, delivered: true, status: null, error: null, attempts: row.attempts, gaveUp: false };
    }
    return send(row);
  }

  return {
    deliverDue,

    deliver,

    /**
     * Queue a `ping` and send it now, for POST /v1/webhooks/test. A failed ping is not retried: a person is
     * watching it and will fix the endpoint and ping again.
     */
    async sendPing(): Promise<DeliveryResult> {
      const id = enqueueEvent(db, { type: "ping", data: { message: "Test event from Tilll." } }, now());
      const result = await deliver(id);
      if (!result.delivered) db.prepare("UPDATE webhook_deliveries SET next_try_at = NULL WHERE id = ?").run(id);
      return result;
    },

    /** Tick until stopped. Passes never overlap: the next is scheduled after the current one finishes. */
    start(options: { tickMs?: number } = {}) {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
      const loop = async () => {
        try {
          running = deliverDue();
          await running;
        } catch (error) {
          log.error("Webhook dispatcher pass failed", error);
        }
        if (!stopped) timer = setTimeout(loop, tickMs);
      };
      timer = setTimeout(loop, 0);
    },

    async stop() {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      await running?.catch(() => undefined);
    },
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
