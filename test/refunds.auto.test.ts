import { describe, expect, it } from "vitest";
import { makeRefundWorld } from "./helpers/refundWorld.js";
import { USDC_BASE, statusResponseFor } from "./helpers/world.js";

const realQuotes = (w: ReturnType<typeof makeRefundWorld>) =>
  w.client.quote.mock.calls.map((c) => c[0]).filter((r) => !r.dry);

/**
 * 1Click returns a payment it could not complete. A duplicate or late payment is different: to 1Click the swap worked,
 * so the money lands in the merchant's balance and Tilll has to give it back. That needs the settlement account's
 * signature, so it waits for the merchant's wallet.
 */
describe("a duplicate or late payment", () => {
  it("is recorded as a refund waiting for the merchant's approval, and nothing is sent", async () => {
    const w = makeRefundWorld();
    const { auto } = await w.duplicatePayment();

    expect(auto).toMatchObject({ reason: "overpayment_auto", status: "awaiting_approval", payload: null });
    expect(realQuotes(w)).toHaveLength(0);
    expect(w.client.generateIntent).not.toHaveBeenCalled();
    expect(w.client.submitIntent).not.toHaveBeenCalled();
  });

  it("tells the merchant, with the payment and the refund that now waits", async () => {
    const w = makeRefundWorld();
    const { auto, invoice } = await w.duplicatePayment();

    const types = w.events().map((e) => e.type);
    expect(types).toContain("payment.duplicate");
    expect(types).not.toContain("payment.duplicate_refunded");
    const waiting = w.events().find((e) => e.type === "refund.awaiting_approval")!;
    expect(waiting).toMatchObject({
      data: { invoice: { id: invoice.id }, refund: { id: auto.id, status: "awaiting_approval" } },
    });
  });

  it("says why it came back: the invoice was already paid, expired or canceled", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.duplicatePayment();
    const event = w.events().find((e) => e.type === "payment.duplicate")!;
    expect(event).toMatchObject({ data: { cause: "invoice_already_paid", invoice: { id: invoice.id } } });
  });

  it("is returned in full, to the address the duplicate payer gave, whatever the manual limits are", async () => {
    const w = makeRefundWorld({ maxPerTx: 1_000_000n, maxPerDay: 1_000_000n });
    const { auto, duplicate, duplicateRefundTo } = await w.duplicatePayment("5.00");

    const { refund } = await w.approve(auto.id);

    expect(realQuotes(w)).toHaveLength(1);
    expect(realQuotes(w)[0]).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "INTENTS",
      amount: "5000000",
      recipient: duplicateRefundTo,
      destinationAsset: duplicate.originAsset,
    });
    expect(refund).toMatchObject({
      status: "submitted",
      attemptId: duplicate.id,
      intentHash: expect.any(String),
      error: null,
    });
    expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
  });

  it("does not use up the merchant's daily allowance, and is not counted against the invoice's own money", async () => {
    const w = makeRefundWorld({ maxPerDay: 1_000_000n });
    const { auto, invoice } = await w.duplicatePayment();
    await w.approve(auto.id);

    const manual = await w.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "1.00" });

    expect(manual.refund.status).toBe("awaiting_approval");
    expect(w.refunds.limits().usedToday).toBe(1_000_000n);
  });

  it("is checked against the balance when it is prepared, and waits, with the reason, while the balance is too low", async () => {
    const w = makeRefundWorld({ balance: 1_000_000n });
    const { auto } = await w.duplicatePayment("5.00");

    await expect(w.approve(auto.id)).rejects.toMatchObject({ code: "insufficient_balance" });

    expect(w.refunds.get(auto.id)).toMatchObject({ status: "awaiting_approval", error: expect.any(String) });
    expect(realQuotes(w)).toHaveLength(0);

    w.balance.value = 10_000_000n;
    expect((await w.approve(auto.id)).refund.status).toBe("submitted");
  });

  it("can be canceled by the merchant, which ends it with a refund.failed event", async () => {
    const w = makeRefundWorld();
    const { auto } = await w.duplicatePayment();
    w.refunds.cancel(auto.id);
    expect(w.refunds.get(auto.id)).toMatchObject({ status: "failed", error: "Canceled." });
    expect(w.events().at(-1)).toMatchObject({ type: "refund.failed" });
  });

  it("is followed to its end like any refund, and does not change the invoice's refunded amount", async () => {
    const w = makeRefundWorld();
    const { auto, invoice } = await w.duplicatePayment();
    await w.approve(auto.id);

    w.refunds.applyRefundStatus(auto.id, w.statusOf(auto.id, "SUCCESS"));

    expect(w.refunds.get(auto.id).status).toBe("succeeded");
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("0");
    expect(w.events().at(-1)).toMatchObject({ type: "refund.succeeded" });
  });

  it("is also recorded for a payment that arrives after the invoice expired or was canceled", async () => {
    const w = makeRefundWorld();
    for (const finish of ["expire", "cancel"] as const) {
      const invoice = w.service.createInvoice({ amount: "5.00" });
      const attempt = await w.service.createAttempt(invoice.id, {
        originAsset: USDC_BASE,
        refundTo: "0x3333333333333333333333333333333333333333",
      });
      if (finish === "cancel") w.service.cancelInvoice(invoice.id);
      else {
        w.clock.advance(61 * 60_000);
        w.service.expireInvoices();
      }
      w.service.applyStatus(attempt.id, statusResponseFor(attempt.quote, "SUCCESS", { amountOut: invoice.amount }));

      const [refund] = w.service.getInvoiceDetail(invoice.id).refunds;
      expect(refund).toMatchObject({ reason: "overpayment_auto", status: "awaiting_approval" });
      const cause = w.events().find((e) => e.type === "payment.duplicate" && e.data.invoice.id === invoice.id);
      expect(cause?.data.cause).toBe(finish === "cancel" ? "invoice_canceled" : "invoice_expired");
    }
  });
});
