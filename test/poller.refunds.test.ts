import { describe, expect, it, vi } from "vitest";
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
  const asked = await w.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "2.00" });
  const { refund } = await w.approve(asked.refund.id);
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

describe("refunds waiting for approval", () => {
  it("are left alone: nothing is quoted, polled or sent for them until the merchant's wallet approves", async () => {
    const s = await setup();
    const { auto } = await s.duplicatePayment();
    s.attemptQuotes.clear();
    const quotesBefore = s.client.quote.mock.calls.length;

    await s.poller.pollOnce();
    await s.poller.pollOnce();

    expect(s.refunds.get(auto.id)).toMatchObject({ status: "awaiting_approval", payload: null });
    expect(s.client.quote.mock.calls.length).toBe(quotesBefore);
    expect(s.client.submitIntent).toHaveBeenCalledTimes(1); // only the refund that setup approved
    expect(s.queries.every((q) => q.depositAddress !== auto.depositAddress)).toBe(true);
  });

  it("are watched like any refund once they have been approved", async () => {
    const s = await setup();
    const { auto } = await s.duplicatePayment();
    s.attemptQuotes.clear();
    const { refund } = await s.approve(auto.id);

    s.answers.set(refund.depositAddress!, "SUCCESS");
    s.clock.advance(11 * SECOND);
    await s.poller.pollOnce();

    expect(s.refunds.get(auto.id).status).toBe("succeeded");
  });
});
