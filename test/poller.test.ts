import { afterEach, describe, expect, it, vi } from "vitest";
import { OneClickError } from "../src/oneclick/client.js";
import type { StatusQuery, StatusResponse, SwapDetails, SwapStatus } from "../src/oneclick/types.js";
import { createPoller } from "../src/watcher/poller.js";
import { USDC_BASE, makeWorld, quoteResponseFor, statusResponseFor, REFUND_ADDRESS } from "./helpers/world.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const input = { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS };

type Answer = { status: SwapStatus; details?: SwapDetails } | Error;

/** A poller wired to a world, with a scripted /v0/status keyed by deposit address. */
function setup() {
  const w = makeWorld();
  const answers = new Map<string, Answer>();
  const queries: StatusQuery[] = [];
  const quotes = new Map<string, ReturnType<typeof quoteResponseFor>>();
  const client = {
    status: vi.fn<(q: StatusQuery) => Promise<StatusResponse>>(async (q) => {
      queries.push(q);
      const answer = answers.get(q.depositAddress) ?? { status: "PENDING_DEPOSIT" as const };
      if (answer instanceof Error) throw answer;
      const quote = quotes.get(q.depositAddress);
      if (!quote) throw new Error(`no quote scripted for ${q.depositAddress}`);
      return statusResponseFor(quote, answer.status, answer.details);
    }),
  };
  const log = { error: vi.fn<(message: string, error: unknown) => void>() };
  const poller = createPoller({ service: w.service, client, log, now: w.clock.now });
  const newAttempt = async (options: { invoiceId?: string; memo?: string } = {}) => {
    const id = options.invoiceId ?? w.service.createInvoice({ amount: "5" }).id;
    if (options.memo) {
      w.client.quote.mockImplementationOnce(async (req) => quoteResponseFor(req, 900, { depositMemo: options.memo }));
    }
    const att = await w.service.createAttempt(id, input);
    quotes.set(att.depositAddress, att.quote);
    return att;
  };
  return { ...w, poller, client, queries, answers, log, newAttempt };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pollOnce", () => {
  it("asks 1Click about a live attempt by deposit address and applies the answer", async () => {
    const { poller, newAttempt, answers, service, queries } = setup();
    const att = await newAttempt();
    answers.set(att.depositAddress, { status: "PROCESSING" });

    const result = await poller.pollOnce();

    expect(queries).toEqual([{ depositAddress: att.depositAddress }]);
    expect(service.getAttempt(att.id).status).toBe("confirming");
    expect(result).toEqual({ polled: 1, failed: 0, expired: 0 });
  });

  it("includes the deposit memo when the quote had one", async () => {
    const { poller, newAttempt, queries } = setup();
    const att = await newAttempt({ memo: "987654" });

    await poller.pollOnce();

    expect(queries).toEqual([{ depositAddress: att.depositAddress, depositMemo: "987654" }]);
  });

  it("does not poll attempts in a terminal state", async () => {
    const { poller, newAttempt, answers, queries } = setup();
    const att = await newAttempt();
    answers.set(att.depositAddress, { status: "FAILED" });
    await poller.pollOnce();
    queries.length = 0;

    await poller.pollOnce();

    expect(queries).toEqual([]);
  });

  it("keeps polling superseded attempts, because the payer may still pay the first address", async () => {
    const { poller, newAttempt, queries, service } = setup();
    const first = await newAttempt();
    const inv = service.getAttempt(first.id).invoiceId;
    const second = await newAttempt({ invoiceId: inv });

    await poller.pollOnce();

    expect(queries.map((q) => q.depositAddress).toSorted()).toEqual(
      [first.depositAddress, second.depositAddress].toSorted(),
    );
  });

  it("carries on with the other attempts when one poll fails, and logs the failure", async () => {
    const { poller, newAttempt, answers, service, log } = setup();
    const broken = await newAttempt();
    const healthy = await newAttempt();
    answers.set(broken.depositAddress, new OneClickError(0, "1Click GET /v0/status failed: fetch failed"));
    answers.set(healthy.depositAddress, { status: "PROCESSING" });

    const result = await poller.pollOnce();

    expect(result).toMatchObject({ polled: 1, failed: 1 });
    expect(service.getAttempt(healthy.id).status).toBe("confirming");
    expect(service.getAttempt(broken.id).status).toBe("awaiting");
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]![0])).toContain(broken.id);
  });

  it("marks due invoices expired after polling, so a just-finished payment wins", async () => {
    const { poller, newAttempt, answers, service, clock, events } = setup();
    const att = await newAttempt();
    answers.set(att.depositAddress, { status: "SUCCESS", details: { amountOut: "5000000" } });
    clock.advance(61 * MINUTE);

    const result = await poller.pollOnce();

    expect(service.getInvoice(att.invoiceId).status).toBe("paid");
    expect(result.expired).toBe(0);
    expect(events().map((e) => e.type)).toEqual(["invoice.paid"]);
  });

  it("expires an invoice nobody paid and reports it", async () => {
    const { poller, service, clock, events } = setup();
    const inv = service.createInvoice({ amount: "5" });
    clock.advance(61 * MINUTE);

    expect(await poller.pollOnce()).toMatchObject({ polled: 0, expired: 1 });

    expect(service.getInvoice(inv.id).status).toBe("expired");
    expect(events().map((e) => e.type)).toEqual(["invoice.expired"]);
  });
});

describe("late payments", () => {
  it("polls an attempt nobody has paid every 5 minutes once its deadline has passed, instead of every 30 seconds", async () => {
    const { poller, newAttempt, client, clock } = setup();
    const att = await newAttempt();
    clock.advance(Date.parse(att.deadline) - clock.now().getTime() + 1);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(1);

    clock.advance(4 * MINUTE + 59 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(1);

    clock.advance(1 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("sees a payment that arrives after the deadline and refunds it in full", async () => {
    const { poller, newAttempt, answers, service, clock, events } = setup();
    const att = await newAttempt();
    clock.advance(Date.parse(att.deadline) - clock.now().getTime() + 3 * 60 * MINUTE); // three hours late: past the old 2 hour limit
    service.expireInvoices();
    answers.set(att.depositAddress, { status: "SUCCESS", details: { amountOut: "5000000" } });

    await poller.pollOnce();

    expect(service.getInvoiceDetail(att.invoiceId).refunds).toMatchObject([
      { reason: "overpayment_auto", amount: "5000000", status: "awaiting_approval" },
    ]);
    expect(events().map((e) => e.type)).toEqual(
      expect.arrayContaining(["payment.duplicate", "refund.awaiting_approval"]),
    );
  });

  it("keeps the 30 second cadence for an attempt with money on it, even past its deadline", async () => {
    const { poller, newAttempt, answers, client, clock } = setup();
    const att = await newAttempt();
    answers.set(att.depositAddress, { status: "PROCESSING" });
    await poller.pollOnce();
    clock.advance(Date.parse(att.deadline) - clock.now().getTime() + 1);
    await poller.pollOnce();
    client.status.mockClear();

    clock.advance(30 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(1);
  });
});

describe("polling cadence (PLAN section 8)", () => {
  it("polls a young attempt every 10 seconds", async () => {
    const { poller, newAttempt, client, clock } = setup();
    await newAttempt();

    await poller.pollOnce();
    clock.advance(9 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(1);

    clock.advance(1 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("backs off to every 30 seconds once the attempt is 10 minutes old", async () => {
    const { poller, newAttempt, client, clock } = setup();
    await newAttempt();
    clock.advance(10 * MINUTE);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(1);

    clock.advance(29 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(1);

    clock.advance(1 * SECOND);
    await poller.pollOnce();
    expect(client.status).toHaveBeenCalledTimes(2);
  });

  it("retries a failed poll on the next tick instead of waiting out the interval", async () => {
    const { poller, newAttempt, answers, client } = setup();
    const att = await newAttempt();
    answers.set(att.depositAddress, new OneClickError(0, "network down"));
    await poller.pollOnce();

    await poller.pollOnce();

    expect(client.status).toHaveBeenCalledTimes(2);
  });
});

describe("start and stop", () => {
  it("ticks on a timer until stopped, never overlapping", async () => {
    vi.useFakeTimers();
    const { poller, newAttempt, client, clock } = setup();
    await newAttempt();

    poller.start({ tickMs: 1000 });
    for (let i = 0; i < 3; i++) {
      clock.advance(10 * SECOND);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await poller.stop();
    const callsAtStop = client.status.mock.calls.length;
    expect(callsAtStop).toBeGreaterThanOrEqual(3);

    clock.advance(10 * SECOND);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.status.mock.calls.length).toBe(callsAtStop);
  });
});

describe("stopping while 1Click hangs", () => {
  it("returns at once, aborts the request in flight, and starts no more", async () => {
    const { poller, newAttempt, client } = setup();
    await newAttempt();
    await newAttempt();
    const signals: (AbortSignal | undefined)[] = [];
    client.status.mockImplementation(
      (_query: StatusQuery, options?: { signal?: AbortSignal }) =>
        new Promise<StatusResponse>((_resolve, reject) => {
          signals.push(options?.signal);
          options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    poller.start({ tickMs: 10 });
    await vi.waitFor(() => expect(client.status).toHaveBeenCalledTimes(1));
    const started = Date.now();
    await poller.stop();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(signals[0]?.aborted).toBe(true);
    expect(client.status).toHaveBeenCalledTimes(1);
  });

  it("does not report the aborted request as a failed poll", async () => {
    const { poller, newAttempt, client, log } = setup();
    await newAttempt();
    client.status.mockImplementation(
      (_query: StatusQuery, options?: { signal?: AbortSignal }) =>
        new Promise<StatusResponse>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    poller.start({ tickMs: 10 });
    await vi.waitFor(() => expect(client.status).toHaveBeenCalledTimes(1));
    await poller.stop();
    expect(log.error).not.toHaveBeenCalled();
  });
});
