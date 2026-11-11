import { describe, expect, it } from "vitest";
import { OneClickError } from "../src/oneclick/client.js";
import { makeRefundWorld, oneClickFailure } from "./helpers/refundWorld.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The pause after each failed try: PLAN section 13's webhook schedule, reused. */
const BACKOFF = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR];

const realQuotes = (w: ReturnType<typeof makeRefundWorld>) =>
  w.client.quote.mock.calls.map((c) => c[0]).filter((r) => !r.dry);

describe("automatic refunds of duplicate and late payments", () => {
  it("is queued by the duplicate payment and due at once", async () => {
    const w = makeRefundWorld();
    const { auto } = await w.duplicatePayment();
    expect(auto).toMatchObject({ reason: "overpayment_auto", status: "pending", tries: 0 });
    expect(w.refunds.listDueAutoRefunds().map((r) => r.id)).toEqual([auto.id]);
  });

  it("refunds the whole duplicate to the address that duplicate payer gave, whatever the manual limits are", async () => {
    const w = makeRefundWorld({ maxPerTx: 1_000_000n, maxPerDay: 1_000_000n });
    const { auto, duplicate, duplicateRefundTo } = await w.duplicatePayment("5.00");

    const done = await w.refunds.executeAutoRefund(auto.id);

    expect(realQuotes(w)).toHaveLength(1);
    expect(realQuotes(w)[0]).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "INTENTS",
      amount: "5000000",
      recipient: duplicateRefundTo,
      destinationAsset: duplicate.originAsset,
    });
    expect(done).toMatchObject({
      status: "submitted",
      attemptId: duplicate.id,
      intentHash: expect.any(String),
      error: null,
    });
    expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
  });

  it("does not use up the merchant's daily allowance", async () => {
    const w = makeRefundWorld({ maxPerDay: 1_000_000n });
    const { auto, invoice } = await w.duplicatePayment();
    await w.refunds.executeAutoRefund(auto.id);

    const manual = await w.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "1.00" });

    expect(manual.refund.status).toBe("submitted");
  });

  it("is logged, without any key material", async () => {
    const w = makeRefundWorld();
    const { auto, invoice } = await w.duplicatePayment();
    await w.refunds.executeAutoRefund(auto.id);
    const lines = w.log.info.mock.calls.map((c) => c[0]);
    expect(lines.join("\n")).toContain(auto.id);
    expect(lines.join("\n")).toContain(invoice.id);
    expect(lines.join("\n")).not.toMatch(/ed25519:/);
  });

  it("ends when 1Click reports SUCCESS, leaving the invoice's own refunded amount alone, and tells the merchant", async () => {
    const w = makeRefundWorld();
    const { auto, invoice } = await w.duplicatePayment();
    await w.refunds.executeAutoRefund(auto.id);

    w.refunds.applyRefundStatus(auto.id, w.statusOf(auto.id, "SUCCESS"));

    expect(w.refunds.get(auto.id).status).toBe("succeeded");
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("0");
    expect(w.events().at(-1)).toMatchObject({
      type: "refund.succeeded",
      data: { refund: { id: auto.id, reason: "overpayment_auto" } },
    });
    expect(w.refunds.listDueAutoRefunds()).toEqual([]);
  });

  it("is never started twice", async () => {
    const w = makeRefundWorld();
    const { auto } = await w.duplicatePayment();
    await w.refunds.executeAutoRefund(auto.id);
    await w.refunds.executeAutoRefund(auto.id);
    expect(realQuotes(w)).toHaveLength(1);
    expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
  });

  it("is not started twice when two passes race", async () => {
    const w = makeRefundWorld();
    const { auto } = await w.duplicatePayment();
    await Promise.all([w.refunds.executeAutoRefund(auto.id), w.refunds.executeAutoRefund(auto.id)]);
    expect(realQuotes(w)).toHaveLength(1);
  });

  describe("when a try fails before anything is signed", () => {
    it("is tried again later, with the reason kept, and not before", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.quote.mockRejectedValueOnce(oneClickFailure(503, "maintenance"));

      const after = await w.refunds.executeAutoRefund(auto.id);

      expect(after).toMatchObject({ status: "pending", tries: 1, error: expect.stringContaining("maintenance") });
      expect(after.nextTryAt).toBe(new Date(w.clock.now().getTime() + BACKOFF[0]!).toISOString());
      expect(w.refunds.listDueAutoRefunds()).toEqual([]);
      w.clock.advance(BACKOFF[0]!);
      expect(w.refunds.listDueAutoRefunds().map((r) => r.id)).toEqual([auto.id]);
    });

    it("succeeds on a later try and drops the old error", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.quote.mockRejectedValueOnce(oneClickFailure(503, "maintenance"));
      await w.refunds.executeAutoRefund(auto.id);
      w.clock.advance(BACKOFF[0]!);

      const done = await w.refunds.executeAutoRefund(auto.id);

      expect(done).toMatchObject({ status: "submitted", tries: 2, error: null });
    });

    it("backs off 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then fails and says so", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.quote.mockRejectedValue(oneClickFailure(400, "pair is not available"));
      const pauses: number[] = [];

      for (let i = 0; i < BACKOFF.length; i++) {
        const before = w.clock.now().getTime();
        const r = await w.refunds.executeAutoRefund(auto.id);
        expect(r.status).toBe("pending");
        pauses.push(Date.parse(r.nextTryAt!) - before);
        w.clock.advance(BACKOFF[i]!);
      }
      expect(pauses).toEqual(BACKOFF);

      const last = await w.refunds.executeAutoRefund(auto.id);

      expect(last).toMatchObject({
        status: "failed",
        tries: 6,
        error: expect.stringContaining("pair is not available"),
      });
      expect(w.events().at(-1)).toMatchObject({ type: "refund.failed", data: { refund: { id: auto.id } } });
      expect(w.refunds.listDueAutoRefunds()).toEqual([]);
    });

    it("also retries an intent it refused to sign, and signs nothing meanwhile", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.behaviour.intent = (req, quote) => {
        const honest = w.behaviour.honest(req, quote);
        const message = JSON.parse(honest.intent.payload.message);
        message.intents[0].receiver_id = "b".repeat(64);
        return {
          ...honest,
          intent: { ...honest.intent, payload: { ...honest.intent.payload, message: JSON.stringify(message) } },
        };
      };
      const after = await w.refunds.executeAutoRefund(auto.id);
      expect(after).toMatchObject({ status: "pending", error: expect.stringContaining("Refusing to sign") });
      expect(w.client.submitIntent).not.toHaveBeenCalled();
    });

    it("waits, without asking 1Click for a quote, while the settlement balance is too low", async () => {
      const w = makeRefundWorld({ balance: 1_000_000n });
      const { auto } = await w.duplicatePayment();
      const after = await w.refunds.executeAutoRefund(auto.id);
      expect(after).toMatchObject({ status: "pending", tries: 1, error: expect.stringMatching(/balance/i) });
      expect(realQuotes(w)).toHaveLength(0);
    });

    it("waits when the balance cannot be read", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.fail.readBalance = true;
      expect(await w.refunds.executeAutoRefund(auto.id)).toMatchObject({ status: "pending", tries: 1 });
    });

    it("comes back after a crash mid-try: the claim expires", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.fail.crash = true;
      await expect(w.refunds.executeAutoRefund(auto.id)).rejects.toThrow("a bug");

      expect(w.refunds.listDueAutoRefunds()).toEqual([]);
      w.clock.advance(5 * MINUTE);
      expect(w.refunds.listDueAutoRefunds().map((r) => r.id)).toEqual([auto.id]);
    });
  });

  describe("when something unexpected goes wrong", () => {
    it("counts a failure that is not a 1Click answer (a bug, a malformed reply) towards the same six tries, then ends the refund", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.quote.mockRejectedValue(new TypeError("unexpected reply shape"));

      for (let i = 0; i < BACKOFF.length; i++) {
        await expect(w.refunds.executeAutoRefund(auto.id)).rejects.toThrow("unexpected reply shape"); // still surfaced to the log
        expect(w.refunds.get(auto.id)).toMatchObject({
          status: "pending",
          tries: i + 1,
          error: "unexpected reply shape",
        });
        w.clock.advance(BACKOFF[i]!);
      }
      await expect(w.refunds.executeAutoRefund(auto.id)).rejects.toThrow("unexpected reply shape");

      expect(w.refunds.get(auto.id)).toMatchObject({ status: "failed", tries: 6 });
      expect(w.events().at(-1)).toMatchObject({ type: "refund.failed" });
      expect(w.refunds.listDueAutoRefunds()).toEqual([]);
    });
  });

  describe("when something breaks after the intent was accepted", () => {
    it("never sends another intent for it: the accepted one is the watcher's to follow", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      // 1Click accepts the intent, but handling its answer fails (here: a reply whose intentHash cannot be read)
      w.client.submitIntent.mockResolvedValueOnce({
        get intentHash(): string {
          throw new TypeError("unreadable reply");
        },
        correlationId: "c",
      });

      await expect(w.refunds.executeAutoRefund(auto.id)).rejects.toThrow("unreadable reply");

      expect(w.refunds.get(auto.id)).toMatchObject({ status: "pending", intentDeadline: expect.any(String) });
      w.clock.advance(7 * HOUR);
      expect(w.refunds.listDueAutoRefunds()).toEqual([]);
      expect(w.refunds.listPollableRefunds().map((r) => r.id)).toEqual([auto.id]);
      expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
    });
  });

  describe("when 1Click turns down the signed intent", () => {
    it("tries again later, as for any failure before the money moved, instead of waiting for the intent to expire", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.submitIntent.mockRejectedValueOnce(
        oneClickFailure(400, "Verifier rejected the signed intent: nonce already used"),
      );

      const after = await w.refunds.executeAutoRefund(auto.id);

      expect(after).toMatchObject({
        status: "pending",
        tries: 1,
        intentDeadline: null,
        error: expect.stringContaining("Verifier rejected"),
      });
      expect(w.refunds.listPollableRefunds()).toEqual([]); // nothing was accepted, so there is nothing to watch
      w.clock.advance(BACKOFF[0]!);
      expect(w.refunds.listDueAutoRefunds().map((r) => r.id)).toEqual([auto.id]);

      const done = await w.refunds.executeAutoRefund(auto.id);
      expect(done).toMatchObject({ status: "submitted", tries: 2, error: null });
    });

    it("ends the refund after the sixth rejection, and says so", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.submitIntent.mockRejectedValue(oneClickFailure(400, "invalid signature"));
      for (let i = 0; i < BACKOFF.length; i++) {
        await w.refunds.executeAutoRefund(auto.id);
        w.clock.advance(BACKOFF[i]!);
      }
      expect(await w.refunds.executeAutoRefund(auto.id)).toMatchObject({ status: "failed", tries: 6 });
      expect(w.events().at(-1)).toMatchObject({ type: "refund.failed" });
    });
  });

  describe("when it is unknown whether the intent was accepted", () => {
    it("is not tried again, because that intent may still land; the watcher finds out", async () => {
      const w = makeRefundWorld();
      const { auto } = await w.duplicatePayment();
      w.client.submitIntent.mockRejectedValueOnce(new OneClickError(0, "timeout"));

      const after = await w.refunds.executeAutoRefund(auto.id);

      expect(after).toMatchObject({ status: "pending", intentDeadline: expect.any(String) });
      w.clock.advance(7 * HOUR);
      expect(w.refunds.listDueAutoRefunds()).toEqual([]);
      expect(w.refunds.listPollableRefunds().map((r) => r.id)).toEqual([auto.id]);
    });
  });

  it("reserves balance for a signed automatic refund, so a manual refund cannot spend the same money", async () => {
    const w = makeRefundWorld({ balance: 6_000_000n });
    const { auto } = await w.duplicatePayment("5.00");
    await w.refunds.executeAutoRefund(auto.id);
    const other = await w.paidInvoice("5.00");

    await expect(w.refunds.refund(other.invoice.id, { idempotencyKey: "k", amount: "2.00" })).rejects.toMatchObject({
      code: "insufficient_balance",
    });
  });

  it("is not written off as interrupted just for waiting to be tried", async () => {
    const w = makeRefundWorld();
    const { auto } = await w.duplicatePayment();
    w.clock.advance(HOUR);
    expect(w.refunds.failInterrupted()).toBe(0);
    expect(w.refunds.get(auto.id).status).toBe("pending");
  });

  it("is never started for a refund that is not automatic or was already signed", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    const { refund } = await w.refunds.refund(invoice.id, { idempotencyKey: "k" });
    await expect(w.refunds.executeAutoRefund(refund.id)).rejects.toThrow(/automatic/);
    expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
  });
});
