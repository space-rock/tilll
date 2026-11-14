import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { enqueueEvent } from "../src/events.js";
import { createDispatcher } from "../src/webhooks/dispatcher.js";
import { verifySignature } from "../src/webhooks/signature.js";
import { fakeFetch, type RecordedCall } from "./helpers/fakeFetch.js";

const HOOK_URL = "https://merchant.example/hooks/tilll";
const SECRET = "whsec_test";
const START = new Date("2026-11-05T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Row {
  id: string;
  attempts: number;
  next_try_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  payload_json: string;
}

function setup(
  respond: (call: RecordedCall) => { status?: number; body?: unknown } = () => ({ status: 200 }),
  extra = {},
) {
  const db: Db = openDb(":memory:");
  let time = START.getTime();
  const clock = { now: () => new Date(time), advance: (ms: number) => void (time += ms) };
  const { fetch, calls } = fakeFetch(respond);
  const log = { error: vi.fn<(message: string, error: unknown) => void>() };
  const dispatcher = createDispatcher({ db, url: HOOK_URL, secret: SECRET, fetch, now: clock.now, log, ...extra });
  const enqueue = (type: "invoice.paid" | "ping" = "invoice.paid") =>
    enqueueEvent(db, { type, data: { invoice: { id: "inv_1" }, note: "café ☕" } }, clock.now());
  const row = (id: string) => db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as Row;
  return { db, clock, calls, log, dispatcher, enqueue, row, fetch };
}

describe("deliverDue", () => {
  it("POSTs a due event with the id and a signature over the exact body, and marks it delivered", async () => {
    const { dispatcher, enqueue, row, calls, clock } = setup();
    const id = enqueue();
    clock.advance(7 * 1000);

    const result = await dispatcher.deliverDue();

    expect(result).toEqual({ delivered: 1, failed: 0, gaveUp: 0 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(HOOK_URL);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("tilll-event-id")).toBe(id);
    expect(call.headers.get("user-agent")).toMatch(/^Tilll-Webhooks\//);
    expect(call.rawBody).toBe(row(id).payload_json);

    const verified = verifySignature({
      secret: SECRET,
      header: call.headers.get("tilll-signature") ?? "",
      rawBody: call.rawBody!,
      now: clock.now,
    });
    expect(verified).toEqual({ ok: true, timestamp: Math.floor(clock.now().getTime() / 1000) });

    expect(row(id)).toMatchObject({
      attempts: 1,
      delivered_at: clock.now().toISOString(),
      next_try_at: null,
      last_error: null,
    });
  });

  it("asks where to send each time when given a function, so a new webhook URL applies to the next event", async () => {
    let url = HOOK_URL;
    const { dispatcher, enqueue, calls } = setup(undefined, { url: () => url });
    enqueue();
    await dispatcher.deliverDue();
    url = "https://other.example/hook";
    enqueue();
    await dispatcher.deliverDue();
    expect(calls.map((c) => c.url)).toEqual([HOOK_URL, "https://other.example/hook"]);
  });

  it("sends the stored payload byte for byte, including non-ASCII", async () => {
    const { dispatcher, enqueue, calls, row } = setup();
    const id = enqueue();
    await dispatcher.deliverDue();
    expect(calls[0]!.rawBody).toContain("café ☕");
    expect(JSON.parse(calls[0]!.rawBody!)).toMatchObject({ id, type: "invoice.paid" });
    expect(calls[0]!.rawBody).toBe(row(id).payload_json);
  });

  it.each([200, 201, 204, 299])("counts HTTP %i as delivered", async (status) => {
    const { dispatcher, enqueue, row } = setup(() => ({ status }));
    const id = enqueue();
    await dispatcher.deliverDue();
    expect(row(id).delivered_at).not.toBeNull();
  });

  it("never re-sends a delivered event, one that is not yet due, or one that was given up on", async () => {
    const { dispatcher, enqueue, calls, db, clock } = setup();
    const delivered = enqueue();
    await dispatcher.deliverDue();
    const notDue = enqueue();
    db.prepare("UPDATE webhook_deliveries SET next_try_at = ? WHERE id = ?").run(
      new Date(clock.now().getTime() + HOUR).toISOString(),
      notDue,
    );
    const gaveUp = enqueue();
    db.prepare("UPDATE webhook_deliveries SET next_try_at = NULL, attempts = 6 WHERE id = ?").run(gaveUp);
    calls.length = 0;

    await dispatcher.deliverDue();

    expect(calls).toEqual([]);
    expect(delivered).toBeDefined();
  });

  it("does not follow redirects, so a signed body is never forwarded elsewhere", async () => {
    const { dispatcher, enqueue, calls, row } = setup(() => ({ status: 302 }));
    const id = enqueue();
    await dispatcher.deliverDue();
    expect(calls[0]!.redirect).toBe("manual");
    expect(row(id).delivered_at).toBeNull();
    expect(row(id).last_error).toBe("HTTP 302");
  });
});

const stamp = (c: RecordedCall) => Number(/t=(\d+)/.exec(c.headers.get("tilll-signature") ?? "")![1]);

const hang: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

describe("failures and retries (PLAN section 13)", () => {
  it.each([500, 404, 401, 300])("treats HTTP %i as a failure and retries in 1 minute", async (status) => {
    const { dispatcher, enqueue, row, clock } = setup(() => ({ status }));
    const id = enqueue();

    expect(await dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 1, gaveUp: 0 });

    expect(row(id)).toMatchObject({
      attempts: 1,
      delivered_at: null,
      last_error: `HTTP ${status}`,
      next_try_at: new Date(clock.now().getTime() + MINUTE).toISOString(),
    });
  });

  it("backs off at 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then gives up", async () => {
    const { dispatcher, enqueue, row, clock, calls } = setup(() => ({ status: 503 }));
    const id = enqueue();
    const gaps: number[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      await dispatcher.deliverDue();
      const due = Date.parse(row(id).next_try_at!);
      gaps.push(due - clock.now().getTime());
      clock.advance(due - clock.now().getTime() - 1);
      await dispatcher.deliverDue(); // one millisecond early: nothing is sent
      expect(calls).toHaveLength(attempt);
      clock.advance(1);
    }
    expect(gaps).toEqual([MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR]);

    const last = await dispatcher.deliverDue();
    expect(last).toEqual({ delivered: 0, failed: 0, gaveUp: 1 });
    expect(row(id)).toMatchObject({ attempts: 6, next_try_at: null, delivered_at: null, last_error: "HTTP 503" });

    clock.advance(365 * 24 * HOUR);
    await dispatcher.deliverDue();
    expect(calls).toHaveLength(6);
  });

  it("delivers after earlier failures and clears the error", async () => {
    let status = 500;
    const { dispatcher, enqueue, row, clock } = setup(() => ({ status }));
    const id = enqueue();
    await dispatcher.deliverDue();
    expect(row(id).last_error).toBe("HTTP 500");

    status = 200;
    clock.advance(MINUTE);
    await dispatcher.deliverDue();

    expect(row(id)).toMatchObject({
      attempts: 2,
      last_error: null,
      next_try_at: null,
      delivered_at: clock.now().toISOString(),
    });
  });

  it("signs each retry with a fresh timestamp", async () => {
    const { dispatcher, enqueue, clock, calls } = setup(() => ({ status: 500 }));
    enqueue();
    await dispatcher.deliverDue();
    clock.advance(MINUTE);
    await dispatcher.deliverDue();

    expect(stamp(calls[1]!) - stamp(calls[0]!)).toBe(60);
  });

  it("records a network error, truncated, and logs it", async () => {
    const { dispatcher, enqueue, row, log } = setup(() => {
      throw new TypeError(`connect ECONNREFUSED ${"x".repeat(1000)}`);
    });
    const id = enqueue();

    await dispatcher.deliverDue();

    expect(row(id).last_error!.length).toBeLessThanOrEqual(300);
    expect(row(id).last_error).toContain("ECONNREFUSED");
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("gives up on a server that hangs, after the timeout", async () => {
    const { db, clock } = setup();
    const dispatcher = createDispatcher({
      db,
      url: HOOK_URL,
      secret: SECRET,
      fetch: hang,
      now: clock.now,
      timeoutMs: 25,
      log: { error: () => undefined },
    });
    const id = enqueueEvent(db, { type: "ping", data: {} }, clock.now());

    const started = Date.now();
    expect(await dispatcher.deliverDue()).toMatchObject({ failed: 1 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect((db.prepare("SELECT last_error FROM webhook_deliveries WHERE id = ?").get(id) as Row).last_error).toMatch(
      /timed out|timeout|abort/i,
    );
  });

  it("keeps delivering the other events when one fails, oldest first", async () => {
    let failing = "";
    const { dispatcher, enqueue, calls, row } = setup((call) => ({
      status: call.headers.get("tilll-event-id") === failing ? 500 : 200,
    }));
    const first = enqueue();
    const second = enqueue();
    const third = enqueue();
    failing = second;

    expect(await dispatcher.deliverDue()).toEqual({ delivered: 2, failed: 1, gaveUp: 0 });

    expect(calls.map((c) => c.headers.get("tilll-event-id"))).toEqual([first, second, third]);
    expect(row(first).delivered_at).not.toBeNull();
    expect(row(second).delivered_at).toBeNull();
    expect(row(third).delivered_at).not.toBeNull();
  });

  it("sends at most one batch per pass", async () => {
    const { dispatcher, enqueue, calls } = setup(() => ({ status: 200 }), { batchSize: 2 });
    enqueue();
    enqueue();
    enqueue();

    await dispatcher.deliverDue();
    expect(calls).toHaveLength(2);
    await dispatcher.deliverDue();
    expect(calls).toHaveLength(3);
  });
});

describe("deliver (one event now)", () => {
  it("sends that event immediately and reports what happened", async () => {
    const { dispatcher, enqueue } = setup(() => ({ status: 200 }));
    const id = enqueue("ping");
    expect(await dispatcher.deliver(id)).toEqual({
      id,
      delivered: true,
      status: 200,
      error: null,
      attempts: 1,
      gaveUp: false,
    });
  });

  it("reports a failure without throwing, so a merchant can see why their endpoint is unhappy", async () => {
    const { dispatcher, enqueue } = setup(() => ({ status: 500 }));
    const id = enqueue("ping");
    expect(await dispatcher.deliver(id)).toEqual({
      id,
      delivered: false,
      status: 500,
      error: "HTTP 500",
      attempts: 1,
      gaveUp: false,
    });
  });

  it("does not send an already delivered event again unless forced", async () => {
    const { dispatcher, enqueue, calls } = setup();
    const id = enqueue();
    await dispatcher.deliver(id);
    expect((await dispatcher.deliver(id)).delivered).toBe(true);
    expect(calls).toHaveLength(1);
    await dispatcher.deliver(id, { force: true });
    expect(calls).toHaveLength(2);
  });

  it("rejects an unknown event id", async () => {
    const { dispatcher } = setup();
    await expect(dispatcher.deliver("evt_nope")).rejects.toThrow(/No webhook event/);
  });
});

describe("sendPing (POST /v1/webhooks/test)", () => {
  it("queues a ping event and sends it straight away, returning how the endpoint answered", async () => {
    const { dispatcher, calls, row } = setup(() => ({ status: 200 }));

    const result = await dispatcher.sendPing();

    expect(result).toMatchObject({ delivered: true, status: 200, error: null, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.rawBody!)).toMatchObject({
      id: result.id,
      type: "ping",
      data: { message: expect.any(String) },
    });
    expect(row(result.id).delivered_at).not.toBeNull();
  });

  it("does not put a failed test ping on the retry schedule, because a person is watching it", async () => {
    const { dispatcher, calls, row, clock } = setup(() => ({ status: 500 }));

    const result = await dispatcher.sendPing();

    expect(result).toMatchObject({ delivered: false, status: 500, error: "HTTP 500" });
    expect(row(result.id)).toMatchObject({ next_try_at: null, delivered_at: null, last_error: "HTTP 500" });
    clock.advance(24 * HOUR);
    await dispatcher.deliverDue();
    expect(calls).toHaveLength(1);
  });
});

describe("start and stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers events as they appear and stops when told to", async () => {
    const { dispatcher, enqueue, calls } = setup();
    dispatcher.start({ tickMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(0);

    enqueue();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);

    await dispatcher.stop();
    enqueue();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
  });

  it("never runs two passes at once, even when delivery is slow", async () => {
    let active = 0;
    let peak = 0;
    const slow: typeof fetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3000));
      active--;
      return new Response("", { status: 200 });
    };
    const { db, clock } = setup();
    const dispatcher = createDispatcher({ db, url: HOOK_URL, secret: SECRET, fetch: slow, now: clock.now });
    enqueueEvent(db, { type: "ping", data: {} }, clock.now());
    enqueueEvent(db, { type: "ping", data: {} }, clock.now());

    dispatcher.start({ tickMs: 500 });
    await vi.advanceTimersByTimeAsync(20_000);
    await dispatcher.stop();

    expect(peak).toBe(1);
  });
});

/** A fetch that answers only when the test says so, and notices when it is aborted. */
function controllableFetch() {
  const open: { resolve: (r: Response) => void; signal: AbortSignal | undefined }[] = [];
  const fetchMock = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        open.push({ resolve, signal: init?.signal ?? undefined });
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  return {
    fetch: fetchMock,
    open,
    answer: (i: number, status: number) => open[i]!.resolve(new Response(null, { status })),
  };
}

const withControlled = () => {
  const db: Db = openDb(":memory:");
  const controlled = controllableFetch();
  const dispatcher = createDispatcher({
    db,
    url: HOOK_URL,
    secret: SECRET,
    fetch: controlled.fetch,
    log: { error: () => undefined },
  });
  return { db, controlled, dispatcher };
};

describe("two senders for one event", () => {
  it("sends a test ping once, even when the background pass runs while it is in flight", async () => {
    const { controlled, dispatcher } = withControlled();
    const ping = dispatcher.sendPing();
    await vi.waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));

    expect(await dispatcher.deliverDue()).toEqual({ delivered: 0, failed: 0, gaveUp: 0 });
    controlled.answer(0, 200);

    expect(await ping).toMatchObject({ delivered: true });
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed test ping off the retry schedule, even when the background pass ran meanwhile", async () => {
    const { db, controlled, dispatcher } = withControlled();
    const ping = dispatcher.sendPing();
    await vi.waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));
    await dispatcher.deliverDue();

    controlled.answer(0, 500);
    const result = await ping;

    expect(result).toMatchObject({ delivered: false, status: 500 });
    const [row] = db.prepare("SELECT next_try_at, attempts FROM webhook_deliveries").all() as {
      next_try_at: string | null;
      attempts: number;
    }[];
    expect(row).toEqual({ next_try_at: null, attempts: 1 });
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a resend once, even when the background pass runs while it is in flight", async () => {
    const { db, controlled, dispatcher } = withControlled();
    const id = enqueueEvent(db, { type: "invoice.paid", data: {} }, new Date());
    const resend = dispatcher.deliver(id, { force: true });
    await vi.waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));

    await dispatcher.deliverDue();
    controlled.answer(0, 200);

    expect(await resend).toMatchObject({ delivered: true });
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("stopping while an endpoint hangs", () => {
  it("returns at once, aborts the request in flight, leaves the event due, and does not start the others", async () => {
    const db: Db = openDb(":memory:");
    const controlled = controllableFetch();
    const dispatcher = createDispatcher({
      db,
      url: HOOK_URL,
      secret: SECRET,
      fetch: controlled.fetch,
      log: { error: () => undefined },
    });
    const ids = [1, 2, 3].map(() => enqueueEvent(db, { type: "invoice.paid", data: {} }, new Date()));

    dispatcher.start({ tickMs: 10 });
    await vi.waitFor(() => expect(controlled.fetch).toHaveBeenCalledTimes(1));
    const started = Date.now();
    await dispatcher.stop();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(controlled.open[0]!.signal?.aborted).toBe(true);
    expect(controlled.fetch).toHaveBeenCalledTimes(1);
    const rows = db
      .prepare("SELECT id, attempts, next_try_at, delivered_at FROM webhook_deliveries ORDER BY rowid")
      .all() as {
      id: string;
      attempts: number;
      next_try_at: string | null;
      delivered_at: string | null;
    }[];
    expect(rows.map((r) => r.id)).toEqual(ids);
    for (const row of rows) {
      expect(row.delivered_at).toBeNull();
      expect(row.attempts).toBe(0); // being stopped is not a failed delivery
      expect(row.next_try_at).not.toBeNull();
    }
    // and after a restart the interrupted event is due again at once
    expect(Date.parse(rows[0]!.next_try_at!)).toBeLessThanOrEqual(Date.now());
  });
});
