import type { InvoiceService } from "../invoices/service.js";
import type { StatusQuery, StatusResponse } from "../oneclick/types.js";
import type { RefundService } from "../refunds/service.js";

/** PLAN section 8: every 10 seconds, backing off to every 30 seconds once an attempt is 10 minutes old. */
const FAST_MS = 10_000;
const SLOW_MS = 30_000;
const BACKOFF_AFTER_MS = 10 * 60_000;
/** An attempt past its deadline that nobody has paid can only be paid late: look rarely. */
const LATE_MS = 5 * 60_000;
const DEFAULT_TICK_MS = 5_000;

export interface PollerDeps {
  service: Pick<InvoiceService, "listPollableAttempts" | "applyStatus" | "expireInvoices">;
  /** When given, refunds are watched too, the same way. */
  refunds?: Pick<RefundService, "listPollableRefunds" | "applyRefundStatus">;
  client: { status(query: StatusQuery, options?: { signal?: AbortSignal }): Promise<StatusResponse> };
  log?: { error(message: string, error: unknown): void };
  now?: () => Date;
}

export interface PollResult {
  polled: number;
  failed: number;
  expired: number;
}

/**
 * Watches live attempts and, when given a refund service, refunds through 1Click's /v0/status (1Click has no webhooks) and lets the service fold each answer
 * into our records. A failed poll leaves the attempt untouched and is retried on the next tick.
 */
export function createPoller(deps: PollerDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? { error: (message: string, error: unknown) => console.error(message, error) };
  const lastPolled = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;
  /** Aborted by `stop()`, so a hung 1Click request cannot hold shutdown up. */
  let abort = new AbortController();

  /** One pass: poll every attempt that is due, then expire invoices past their time. */
  async function pollOnce(): Promise<PollResult> {
    const nowMs = now().getTime();
    const attempts = deps.service.listPollableAttempts();
    const refunds = deps.refunds?.listPollableRefunds() ?? [];
    const live = new Set([...attempts.map((a) => a.id), ...refunds.map((r) => r.id)]);
    for (const id of lastPolled.keys()) if (!live.has(id)) lastPolled.delete(id);

    let polled = 0;
    let failed = 0;
    /** Poll one thing if it is due. `key` is unique across attempts and refunds. */
    const watch = async (
      key: string,
      createdAt: string,
      what: string,
      query: StatusQuery,
      apply: (response: StatusResponse) => unknown,
      late = false,
    ) => {
      const interval = late ? LATE_MS : nowMs - Date.parse(createdAt) < BACKOFF_AFTER_MS ? FAST_MS : SLOW_MS;
      const last = lastPolled.get(key);
      if (last !== undefined && nowMs - last < interval) return;
      try {
        apply(await deps.client.status(query, { signal: abort.signal }));
        lastPolled.set(key, nowMs);
        polled++;
      } catch (error) {
        if (abort.signal.aborted) return; // stopping, not failing
        failed++;
        log.error(`Polling ${what} ${key} failed`, error);
      }
    };

    for (const attempt of attempts) {
      if (abort.signal.aborted) break;
      await watch(
        attempt.id,
        attempt.createdAt,
        "attempt",
        {
          depositAddress: attempt.depositAddress,
          ...(attempt.depositMemo ? { depositMemo: attempt.depositMemo } : {}),
        },
        (response) => deps.service.applyStatus(attempt.id, response),
        (attempt.status === "awaiting" || attempt.status === "superseded") && nowMs > Date.parse(attempt.deadline),
      );
    }
    for (const refund of refunds) {
      if (abort.signal.aborted) break;
      await watch(refund.id, refund.createdAt, "refund", { depositAddress: refund.depositAddress! }, (response) =>
        deps.refunds!.applyRefundStatus(refund.id, response),
      );
    }
    // Each stage on its own: one that fails (a locked database, a bug) is logged and must not stop the others.
    const stage = async <T>(what: string, run: () => T | Promise<T>, fallback: T): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        failed++;
        log.error(`${what} failed`, error);
        return fallback;
      }
    };
    // After polling, so a payment that just completed marks its invoice paid before the expiry check.
    const expired = await stage("Expiring invoices", () => deps.service.expireInvoices(), 0);
    return { polled, failed, expired };
  }

  return {
    pollOnce,

    /** Tick until stopped. Ticks never overlap: the next one is scheduled after the current one finishes. */
    start(options: { tickMs?: number } = {}) {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
      const loop = async () => {
        try {
          running = pollOnce();
          await running;
        } catch (error) {
          log.error("Poller tick failed", error);
        }
        if (!stopped) timer = setTimeout(loop, tickMs);
      };
      timer = setTimeout(loop, 0);
    },

    /** Stop ticking and wait for a tick that is already running. */
    async stop() {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      await running?.catch(() => undefined);
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
