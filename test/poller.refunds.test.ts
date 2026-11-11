import { describe, expect, it, vi } from "vitest";
import { insertRefund } from "../src/invoices/repo.js";
import { OneClickError } from "../src/oneclick/client.js";
import type { QuoteResponse, StatusQuery, StatusResponse, SwapStatus } from "../src/oneclick/types.js";
import { createPoller } from "../src/watcher/poller.js";
import { makeRefundWorld } from "./helpers/refundWorld.js";
import { REFUND_ADDRESS, USDC_BASE, statusResponseFor } from "./helpers/world.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A poller that also watches refunds, over a scripted /v0/status. */
async function setup() {
  const w = makeRefundWorld();
  const answers = new Map<string, SwapStatus | Error>();
  const queries: StatusQuery[] = [];
  /** Quotes of payment attempts, which the refund world does not track. */
  const attemptQuotes = new Map<string, QuoteResponse>();
  const client = {
    status: vi.fn<(q: StatusQuery) => Promise<StatusResponse>>(async (q) => {
      queries.push(q);
      const answer = answers.get(q.depositAddress) ?? "PENDING_DEPOSIT";
      if (answer instanceof Error) throw answer;
      return statusResponseFor(
        (w.quoteByAddress.get(q.depositAddress) ?? attemptQuotes.get(q.depositAddress))!,
        answer,
      );
    }),
  };
  const log = { error: vi.fn<(message: string, error: unknown) => void>() };
  const poller = createPoller({ service: w.service, refunds: w.refunds, client, log, now: w.clock.now });
  const { invoice } = await w.paidInvoice();
  const { refund } = await w.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "2.00" });
  return { ...w, poller, statusClient: client, queries, answers, attemptQuotes, log, refund, invoice };
}

describe("watching refunds", () => {
  it("asks 1Click about a refund's own deposit address and applies the answer", async () => {
    const s = await setup();
    s.answers.set(s.refund.depositAddress!, "SUCCESS");

    const result = await s.poller.pollOnce();

    expect(s.queries).toEqual([{ depositAddress: s.refund.depositAddress }]);
    expect(s.refunds.get(s.refund.id).status).toBe("succeeded");
    expect(s.service.getInvoice(s.invoice.id).refundedAmount).toBe("2000000");
    expect(result).toMatchObject({ polled: 1, failed: 0 });
  });

  it("keeps the refund as it was when the poll fails, says so, and tries again on the next pass", async () => {
    const s = await setup();
    s.answers.set(s.refund.depositAddress!, new OneClickError(0, "network down"));

    const result = await s.poller.pollOnce();

    expect(result).toMatchObject({ polled: 0, failed: 1 });
    expect(s.log.error).toHaveBeenCalledWith(expect.stringContaining(s.refund.id), expect.any(OneClickError));
    expect(s.refunds.get(s.refund.id).status).toBe("submitted");

    s.answers.set(s.refund.depositAddress!, "SUCCESS");
    s.clock.advance(11 * SECOND);
    await s.poller.pollOnce();
    expect(s.refunds.get(s.refund.id).status).toBe("succeeded");
  });

  it("polls every 10 seconds at first and every 30 seconds once the refund is 10 minutes old", async () => {
    const s = await setup();
    await s.poller.pollOnce();
    s.clock.advance(5 * SECOND);
    await s.poller.pollOnce();
    expect(s.queries).toHaveLength(1);
    s.clock.advance(6 * SECOND);
    await s.poller.pollOnce();
    expect(s.queries).toHaveLength(2);

    s.clock.advance(10 * MINUTE);
    await s.poller.pollOnce();
    const before = s.queries.length;
    s.clock.advance(20 * SECOND);
    await s.poller.pollOnce();
    expect(s.queries).toHaveLength(before);
    s.clock.advance(11 * SECOND);
    await s.poller.pollOnce();
    expect(s.queries).toHaveLength(before + 1);
  });

  it("stops asking once the refund has ended", async () => {
    const s = await setup();
    s.answers.set(s.refund.depositAddress!, "FAILED");
    await s.poller.pollOnce();
    s.clock.advance(MINUTE);
    await s.poller.pollOnce();
    expect(s.queries).toHaveLength(1);
  });

  it("gives up on a refund that was cut short before it was signed", async () => {
    const s = await setup();
    const stuck = await s.paidInvoice();
    const at = s.clock.now().toISOString();
    insertRefund(s.db, {
      id: "ref_stuck",
      invoiceId: stuck.invoice.id,
      attemptId: stuck.attempt.id,
      amount: "1000000",
      reason: "merchant_request",
      depositAddress: null,
      intentHash: null,
      status: "pending",
      idempotencyKey: "stuck",
      error: null,
      intentDeadline: null,
      quote: null,
      statusResponse: null,
      tries: 0,
      nextTryAt: null,
      createdAt: at,
      updatedAt: at,
    });
    s.clock.advance(11 * MINUTE);

    await s.poller.pollOnce();

    expect(s.refunds.get("ref_stuck")).toMatchObject({ status: "failed" });
    expect(s.events().at(-1)).toMatchObject({ type: "refund.failed" });
  });

  it("keeps watching payment attempts alongside", async () => {
    const s = await setup();
    const invoice = s.service.createInvoice({ amount: "5" });
    const attempt = await s.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    s.attemptQuotes.set(attempt.depositAddress, attempt.quote);
    s.answers.set(attempt.depositAddress, "PROCESSING");

    const result = await s.poller.pollOnce();

    expect(s.service.getAttempt(attempt.id).status).toBe("confirming");
    expect(s.queries.map((q) => q.depositAddress)).toContain(s.refund.depositAddress);
    expect(result.polled).toBe(2);
  });
});

describe("automatic refunds", () => {
  it("starts every one that is due, on every pass, and then watches it like any refund", async () => {
    const s = await setup();
    const { auto } = await s.duplicatePayment();
    s.attemptQuotes.clear();

    await s.poller.pollOnce();
    expect(s.refunds.get(auto.id).status).toBe("submitted");
    expect(s.client.submitIntent).toHaveBeenCalledTimes(2); // the manual refund from setup, and this one

    s.answers.set(s.refunds.get(auto.id).depositAddress!, "SUCCESS");
    s.clock.advance(11 * SECOND);
    await s.poller.pollOnce();
    expect(s.refunds.get(auto.id).status).toBe("succeeded");
  });

  it("does not start it again while a try is under way or after it was signed", async () => {
    const s = await setup();
    await s.duplicatePayment();
    await s.poller.pollOnce();
    await s.poller.pollOnce();
    await s.poller.pollOnce();
    expect(s.client.submitIntent).toHaveBeenCalledTimes(2);
  });

  it("keeps going when one automatic refund hits a bug, and says so", async () => {
    const s = await setup();
    const first = await s.duplicatePayment();
    const second = await s.duplicatePayment();
    const spy = vi.spyOn(s.refunds, "executeAutoRefund").mockImplementationOnce(async () => {
      throw new TypeError("a bug");
    });

    await s.poller.pollOnce();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(s.log.error).toHaveBeenCalledWith(expect.stringContaining(first.auto.id), expect.any(TypeError));
    expect(s.refunds.get(second.auto.id).status).toBe("submitted");
  });
});
