import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { publicKeyOf } from "../src/near/keys.js";
import { verifyNep413 } from "../src/near/nep413.js";
import { insertRefund } from "../src/invoices/repo.js";
import { failureOf } from "./helpers/failure.js";
import { TEST_SECRET, VERIFIER, makeRefundWorld, oneClickFailure, type RefundWorld } from "./helpers/refundWorld.js";
import { REFUND_ADDRESS, USDC_BASE, USDC_NEAR, statusResponseFor } from "./helpers/world.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const refusal = async (fn: () => unknown) => failureOf(ApiError, fn);
/** Request a refund and approve it with the merchant's wallet, as the dashboard does. */
const ask = async (w: RefundWorld, invoiceId: string, over: { amount?: string; idempotencyKey?: string } = {}) => {
  const { refund, replayed } = await w.refunds.refund(invoiceId, { idempotencyKey: "key-1", ...over });
  if (replayed) return { refund, replayed };
  return { refund: (await w.approve(refund.id)).refund, replayed: false };
};
const sent = (w: RefundWorld) => w.client.quote.mock.calls.map((c) => c[0]).filter((r) => !r.dry);

describe("previewing a refund", () => {
  it("asks for a dry swap from the settlement balance to the payer's own address on the chain they paid from", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice("5.00");

    const preview = await w.refunds.preview(invoice.id, {});

    expect(w.client.quote).toHaveBeenCalledTimes(1);
    expect(w.client.quote.mock.lastCall![0]).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: USDC_NEAR,
      depositType: "INTENTS",
      destinationAsset: USDC_BASE,
      amount: "5000000",
      refundTo: "shop-pay.near",
      refundType: "INTENTS",
      recipient: REFUND_ADDRESS,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(w.clock.now().getTime() + 30 * MINUTE).toISOString(),
    });
    expect(preview).toMatchObject({
      invoiceId: invoice.id,
      amount: "5",
      amountBase: "5000000",
      destination: { assetId: USDC_BASE, chain: "base", symbol: "USDC", address: REFUND_ADDRESS },
      estimate: { amountOutFormatted: "5.0" },
    });
    expect(preview.note).toMatch(/today's price/);
  });

  it("changes nothing and never asks for an intent", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    await w.refunds.preview(invoice.id, { amount: "1.00" });
    expect(w.service.getInvoiceDetail(invoice.id).refunds).toEqual([]);
    expect(w.client.generateIntent).not.toHaveBeenCalled();
    expect(w.client.submitIntent).not.toHaveBeenCalled();
  });

  it("takes a smaller amount, and defaults to what earlier refunds left", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice("5.00");
    expect(await w.refunds.preview(invoice.id, { amount: "1.50" })).toMatchObject({ amountBase: "1500000" });

    await ask(w, invoice.id, { amount: "2.00" });

    expect(await w.refunds.preview(invoice.id, {})).toMatchObject({ amountBase: "3000000" });
  });

  it.each([
    [
      "an invoice that is still open",
      async (w: RefundWorld) => w.service.createInvoice({ amount: "5" }).id,
      "invoice_not_paid",
      409,
    ],
  ])("refuses %s", async (_name, make, code, status) => {
    const w = makeRefundWorld();
    const id = await make(w);
    expect(await refusal(() => w.refunds.preview(id, {}))).toMatchObject({ code, status });
  });

  it("refuses an invoice that does not exist", async () => {
    const w = makeRefundWorld();
    expect(await refusal(() => w.refunds.preview("inv_nope", {}))).toMatchObject({ status: 404 });
  });

  it.each(["0", "-1", "abc", "1.0000001", ""])("refuses the amount %j", async (amount) => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    expect(await refusal(() => w.refunds.preview(invoice.id, { amount }))).toMatchObject({
      code: "invalid_amount",
      status: 400,
    });
  });

  it("refuses more than the invoice has left, and says when nothing is left", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice("5.00");
    expect(await refusal(() => w.refunds.preview(invoice.id, { amount: "5.01" }))).toMatchObject({
      code: "refund_exceeds_remaining",
      status: 409,
    });
    await ask(w, invoice.id);
    expect(await refusal(() => w.refunds.preview(invoice.id, {}))).toMatchObject({ code: "nothing_to_refund" });
  });

  it("maps a 1Click rejection to the error a merchant should see", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    w.client.quote.mockRejectedValueOnce(oneClickFailure(400, "pair is not available"));
    expect(await refusal(() => w.refunds.preview(invoice.id, {}))).toMatchObject({ code: "pair_unavailable" });
  });
});

describe("requesting a refund", () => {
  it("quotes for real, has the intent made for that quote's deposit address, signs it untouched, and submits it", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice("5.00");

    const { refund, replayed } = await ask(w, invoice.id, { amount: "2.00" });

    const [real] = sent(w);
    expect(real).toMatchObject({ dry: false, swapType: "EXACT_INPUT", amount: "2000000", depositType: "INTENTS" });
    const depositAddress = [...w.quoteByAddress.keys()].at(-1)!;
    expect(w.client.generateIntent).toHaveBeenCalledWith({
      type: "swap_transfer",
      standard: "nep413",
      signerId: "shop-pay.near",
      depositAddress,
    });

    const request = w.client.submitIntent.mock.calls[0]![0];
    const generated = await w.client.generateIntent.mock.results[0]!.value;
    expect(request.type).toBe("swap_transfer");
    expect(request.signedData.payload).toEqual(generated.intent.payload);
    expect(request.signedData.public_key).toBe(publicKeyOf(TEST_SECRET));
    expect(verifyNep413(request.signedData)).toBe(true);

    expect(replayed).toBe(false);
    expect(refund).toMatchObject({
      invoiceId: invoice.id,
      amount: "2000000",
      reason: "merchant_request",
      status: "submitted",
      depositAddress,
      intentHash: expect.stringMatching(/^hash-/),
      idempotencyKey: "key-1",
      error: null,
    });
    expect(w.service.getInvoiceDetail(invoice.id).refunds).toHaveLength(1);
  });

  it("does not count the refund as refunded until 1Click says it succeeded", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    await ask(w, invoice.id);
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("0");
    expect(w.events().map((e) => e.type)).not.toContain("refund.succeeded");
  });

  describe("idempotency", () => {
    it("returns the same refund for the same key and does not pay twice", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      const first = await ask(w, invoice.id, { amount: "2.00" });
      const again = await ask(w, invoice.id, { amount: "2.00" });

      expect(again.replayed).toBe(true);
      expect(again.refund.id).toBe(first.refund.id);
      expect(sent(w)).toHaveLength(1);
      expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
    });

    it("also replays when the retry leaves the amount out", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      const first = await ask(w, invoice.id, { amount: "2.00" });
      const again = await w.refunds.refund(invoice.id, { idempotencyKey: "key-1" });
      expect(again.refund.id).toBe(first.refund.id);
    });

    it("refuses a key that was used for a different amount", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      await ask(w, invoice.id, { amount: "2.00" });
      expect(await refusal(() => ask(w, invoice.id, { amount: "3.00" }))).toMatchObject({
        code: "idempotency_key_reused",
        status: 409,
      });
    });

    it("treats the same key on another invoice as a different request", async () => {
      const w = makeRefundWorld();
      const a = await w.paidInvoice();
      const b = await w.paidInvoice();
      const first = await ask(w, a.invoice.id);
      const second = await ask(w, b.invoice.id);
      expect(second.refund.id).not.toBe(first.refund.id);
    });

    it("sends one refund when the same request arrives twice at once", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      const [one, two] = await Promise.all([ask(w, invoice.id), ask(w, invoice.id)]);
      expect(two.refund.id).toBe(one.refund.id);
      expect(sent(w)).toHaveLength(1);
      expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
    });

    it("keeps a refund whose preparation failed waiting, so the same key replays it and approving again works", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      const { refund } = await w.refunds.refund(invoice.id, { idempotencyKey: "key-1" });
      w.client.quote.mockRejectedValueOnce(oneClickFailure(400, "pair is not available"));
      await refusal(() => w.approve(refund.id));
      expect(w.refunds.get(refund.id)).toMatchObject({
        status: "awaiting_approval",
        error: expect.stringContaining("Choose another token"),
      });

      const again = await ask(w, invoice.id);
      expect(again).toMatchObject({ replayed: true, refund: { id: refund.id, status: "awaiting_approval" } });

      const approved = await w.approve(refund.id);
      expect(approved.refund).toMatchObject({ status: "submitted", error: null });
    });
  });

  describe("how much can be refunded", () => {
    it("refuses an invoice that is not paid", async () => {
      const w = makeRefundWorld();
      const open = w.service.createInvoice({ amount: "5" });
      expect(await refusal(() => ask(w, open.id))).toMatchObject({ code: "invoice_not_paid" });
    });

    it("counts refunds still in flight against the invoice", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice("5.00");
      await ask(w, invoice.id, { amount: "3.00" });
      expect(await refusal(() => ask(w, invoice.id, { amount: "2.01", idempotencyKey: "k2" }))).toMatchObject({
        code: "refund_exceeds_remaining",
      });
      expect((await ask(w, invoice.id, { amount: "2.00", idempotencyKey: "k2" })).refund.status).toBe("submitted");
    });

    it("does not count an automatic refund of a duplicate payment against the invoice's own money", async () => {
      const w = makeRefundWorld();
      const invoice = w.service.createInvoice({ amount: "5.00" });
      const first = await w.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
      const second = await w.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
      for (const attempt of [first, second]) {
        w.service.applyStatus(attempt.id, statusResponseFor(attempt.quote, "SUCCESS", { amountOut: invoice.amount }));
      }
      expect(w.service.getInvoiceDetail(invoice.id).refunds).toMatchObject([{ reason: "overpayment_auto" }]);

      const { refund } = await ask(w, invoice.id);
      expect(refund.amount).toBe("5000000");
    });

    it("refunds to the attempt that was paid, not to another one", async () => {
      const w = makeRefundWorld();
      const invoice = w.service.createInvoice({ amount: "5.00" });
      await w.service.createAttempt(invoice.id, {
        originAsset: USDC_BASE,
        refundTo: "0x2222222222222222222222222222222222222222",
      });
      const paid = await w.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
      w.service.applyStatus(paid.id, statusResponseFor(paid.quote, "SUCCESS", { amountOut: invoice.amount }));

      const { refund } = await ask(w, invoice.id);

      expect(refund.attemptId).toBe(paid.id);
      expect(sent(w).at(-1)).toMatchObject({ recipient: REFUND_ADDRESS });
    });
  });

  describe("limits", () => {
    it("refuses a refund above the per-transaction limit, and allows one at the limit", async () => {
      const w = makeRefundWorld({ maxPerTx: 2_000_000n });
      const { invoice } = await w.paidInvoice();
      expect(await refusal(() => ask(w, invoice.id, { amount: "2.01" }))).toMatchObject({
        code: "refund_limit_exceeded",
        status: 422,
      });
      expect((await ask(w, invoice.id, { amount: "2.00" })).refund.status).toBe("submitted");
    });

    it("refuses a refund that would take the day's total above the daily limit", async () => {
      const w = makeRefundWorld({ maxPerDay: 6_000_000n });
      const a = await w.paidInvoice();
      const b = await w.paidInvoice();
      await ask(w, a.invoice.id, { amount: "4.00" });
      expect(await refusal(() => ask(w, b.invoice.id, { amount: "2.01", idempotencyKey: "k2" }))).toMatchObject({
        code: "daily_refund_limit",
        status: 422,
      });
      expect((await ask(w, b.invoice.id, { amount: "2.00", idempotencyKey: "k3" })).refund.status).toBe("submitted");
    });

    it("starts a new day at midnight UTC", async () => {
      const w = makeRefundWorld({ maxPerDay: 4_000_000n });
      const a = await w.paidInvoice();
      const b = await w.paidInvoice();
      await ask(w, a.invoice.id, { amount: "4.00" });
      expect(await refusal(() => ask(w, b.invoice.id, { amount: "1.00", idempotencyKey: "k2" }))).toMatchObject({
        code: "daily_refund_limit",
      });
      w.clock.advance(24 * HOUR);
      expect((await ask(w, b.invoice.id, { amount: "1.00", idempotencyKey: "k3" })).refund.status).toBe("submitted");
    });

    it("gives the allowance back when a refund fails", async () => {
      const w = makeRefundWorld({ maxPerDay: 4_000_000n });
      const a = await w.paidInvoice();
      const b = await w.paidInvoice();
      const { refund } = await ask(w, a.invoice.id, { amount: "4.00" });
      w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "FAILED"));
      expect((await ask(w, b.invoice.id, { amount: "4.00", idempotencyKey: "k2" })).refund.status).toBe("submitted");
    });
  });

  describe("the settlement balance", () => {
    it("refuses a refund the balance cannot cover", async () => {
      const w = makeRefundWorld({ balance: 1_999_999n });
      const { invoice } = await w.paidInvoice();
      expect(await refusal(() => ask(w, invoice.id, { amount: "2.00" }))).toMatchObject({
        code: "insufficient_balance",
        status: 409,
      });
      expect(w.service.getInvoiceDetail(invoice.id).refunds).toEqual([]);
    });

    it("does not let two refunds in flight spend the same money", async () => {
      const w = makeRefundWorld({ balance: 6_000_000n });
      const a = await w.paidInvoice();
      const b = await w.paidInvoice();
      await ask(w, a.invoice.id, { amount: "4.00" });
      expect(await refusal(() => ask(w, b.invoice.id, { amount: "4.00", idempotencyKey: "k2" }))).toMatchObject({
        code: "insufficient_balance",
      });
    });

    it("stops holding back a refund's money once 1Click has the deposit, because the balance has already gone down by then", async () => {
      const w = makeRefundWorld({ balance: 6_000_000n });
      const a = await w.paidInvoice();
      const b = await w.paidInvoice();
      const { refund } = await ask(w, a.invoice.id, { amount: "4.00" });
      expect(await refusal(() => ask(w, b.invoice.id, { amount: "4.00", idempotencyKey: "k2" }))).toMatchObject({
        code: "insufficient_balance",
      }); // submitted, but 1Click has not reported the deposit: its money is still spoken for

      w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "PROCESSING"));

      // The (stubbed) balance still reads 6, as it would after the debit of a larger starting balance.
      expect((await ask(w, b.invoice.id, { amount: "4.00", idempotencyKey: "k3" })).refund.status).toBe("submitted");
    });

    it("reports 503 when the balance cannot be read, and refunds nothing", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      w.fail.readBalance = true;
      expect(await refusal(() => ask(w, invoice.id))).toMatchObject({ code: "upstream_unavailable", status: 503 });
      expect(sent(w)).toHaveLength(0);
    });
  });

  describe("when something goes wrong before the refund is approved", () => {
    it("refuses to hand the wallet an intent that would move other money, and submits nothing", async () => {
      const w = makeRefundWorld({ maxPerDay: 5_000_000n });
      const a = await w.paidInvoice();
      w.behaviour.intent = (req, quote) => ({
        intent: {
          standard: "nep413",
          payload: {
            recipient: VERIFIER,
            nonce: Buffer.alloc(32, 3).toString("base64"),
            message: JSON.stringify({
              signer_id: req.signerId,
              deadline: new Date(w.clock.now().getTime() + 15 * MINUTE).toISOString(),
              intents: [
                {
                  intent: "transfer",
                  receiver_id: "b".repeat(64),
                  tokens: { [quote.quoteRequest.originAsset]: "5000000" },
                },
              ],
            }),
          },
        },
        correlationId: "evil",
      });

      const error = await refusal(() => ask(w, a.invoice.id));

      expect(error).toMatchObject({ code: "intent_refused", status: 502 });
      expect(w.client.submitIntent).not.toHaveBeenCalled();
      const [refund] = w.service.getInvoiceDetail(a.invoice.id).refunds;
      // Nothing was kept for the wallet to sign, and the refund still waits: the merchant can try again or cancel.
      expect(refund).toMatchObject({
        status: "awaiting_approval",
        payload: null,
        error: expect.stringContaining("Refusing to sign"),
      });
      w.behaviour.intent = w.behaviour.honest;
      expect((await w.approve(refund!.id)).refund).toMatchObject({ status: "submitted", error: null });
    });

    it("keeps the refund waiting when the quote is rejected", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      w.client.quote.mockRejectedValueOnce(oneClickFailure(400, "pair is not available"));
      expect(await refusal(() => ask(w, invoice.id))).toMatchObject({ code: "pair_unavailable" });
      expect(w.service.getInvoiceDetail(invoice.id).refunds).toMatchObject([{ status: "awaiting_approval" }]);
      expect(w.client.generateIntent).not.toHaveBeenCalled();
    });

    it("keeps the refund waiting when no intent can be made", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      w.client.generateIntent.mockRejectedValueOnce(oneClickFailure(500, "boom"));
      expect(await refusal(() => ask(w, invoice.id))).toMatchObject({ code: "refund_failed", status: 502 });
      expect(w.client.submitIntent).not.toHaveBeenCalled();
      expect(w.service.getInvoiceDetail(invoice.id).refunds).toMatchObject([{ status: "awaiting_approval" }]);
    });

    it("returns the refund to waiting when 1Click rejects the signed intent, with the intent forgotten", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      w.client.submitIntent.mockRejectedValueOnce(oneClickFailure(400, "invalid signature"));
      expect(await refusal(() => ask(w, invoice.id))).toMatchObject({ code: "refund_failed", status: 502 });
      const [refund] = w.service.getInvoiceDetail(invoice.id).refunds;
      expect(refund).toMatchObject({
        status: "awaiting_approval",
        error: expect.stringContaining("invalid signature"),
        payload: null,
        depositAddress: null,
        intentDeadline: null,
      });
      expect((await w.approve(refund!.id)).refund.status).toBe("submitted");
    });
  });

  it("does not undo a success the watcher recorded while the intent was still being submitted", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    w.client.submitIntent.mockImplementationOnce(async () => {
      const [open] = w.refunds.listPollableRefunds();
      w.refunds.applyRefundStatus(open!.id, w.statusOf(open!.id, "SUCCESS"));
      return { intentHash: "hash-late", correlationId: "c" };
    });

    const { refund } = await ask(w, invoice.id);

    expect(refund).toMatchObject({ status: "succeeded", intentHash: "hash-late" });
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("5000000");
  });

  describe("when it is unknown whether the intent was accepted", () => {
    it.each([
      ["no answer", 0],
      ["a server error", 503],
    ])("leaves the refund pending after %s, so the watcher can find out", async (_name, status) => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      w.client.submitIntent.mockRejectedValueOnce(oneClickFailure(status));

      const { refund } = await ask(w, invoice.id);

      expect(refund).toMatchObject({ status: "pending", intentHash: null, error: null });
      expect(w.refunds.listPollableRefunds().map((r) => r.id)).toEqual([refund.id]);
    });

    it("later learns the intent landed", async () => {
      const w = makeRefundWorld();
      const { invoice } = await w.paidInvoice();
      w.client.submitIntent.mockRejectedValueOnce(oneClickFailure(0));
      const { refund } = await ask(w, invoice.id);

      w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "SUCCESS"));

      expect(w.refunds.get(refund.id).status).toBe("succeeded");
    });
  });
});

const submitted = async (amount = "2.00", invoiceAmount = "5.00") => {
  const w = makeRefundWorld();
  const { invoice } = await w.paidInvoice(invoiceAmount);
  const { refund } = await ask(w, invoice.id, { amount });
  return { w, invoice, refund };
};
const lastEvent = (w: RefundWorld) => w.events().at(-1)!;

describe("following a refund to its end", () => {
  it("marks a refund succeeded, adds it to the invoice and queues refund.succeeded with the transfer's links", async () => {
    const { w, invoice, refund } = await submitted();

    w.refunds.applyRefundStatus(
      refund.id,
      w.statusOf(refund.id, "SUCCESS", {
        destinationChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
        amountOut: "1990000",
      }),
    );

    expect(w.refunds.get(refund.id).status).toBe("succeeded");
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("2000000");
    const event = lastEvent(w);
    expect(event.type).toBe("refund.succeeded");
    expect(event.data).toMatchObject({
      invoice: { id: invoice.id, refundedAmountBase: "2000000" },
      refund: {
        id: refund.id,
        status: "succeeded",
        amountBase: "2000000",
        txLinks: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
      },
    });
    expect(event.proof).toMatchObject({ oneclickQuoteSignature: expect.stringMatching(/^ed25519:SIG/) });
    expect(event.proofVerified).toBe(false); // the test quotes carry made-up signatures
  });

  it("counts a refund once however often success is reported", async () => {
    const { w, invoice, refund } = await submitted();
    const success = w.statusOf(refund.id, "SUCCESS");
    w.refunds.applyRefundStatus(refund.id, success);
    w.refunds.applyRefundStatus(refund.id, success);
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("2000000");
    expect(w.events().filter((e) => e.type === "refund.succeeded")).toHaveLength(1);
  });

  it("adds up partial refunds until the invoice is fully refunded", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice("5.00");
    const one = await ask(w, invoice.id, { amount: "2.00", idempotencyKey: "a" });
    const two = await ask(w, invoice.id, { amount: "3.00", idempotencyKey: "b" });
    w.refunds.applyRefundStatus(one.refund.id, w.statusOf(one.refund.id, "SUCCESS"));
    w.refunds.applyRefundStatus(two.refund.id, w.statusOf(two.refund.id, "SUCCESS"));
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("5000000");
  });

  it.each(["FAILED", "REFUNDED"] as const)(
    "marks a refund failed on %s, queues refund.failed and refunds nothing",
    async (status) => {
      const { w, invoice, refund } = await submitted();

      w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, status, { refundReason: "no liquidity" }));

      expect(w.refunds.get(refund.id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("no liquidity"),
      });
      expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("0");
      expect(lastEvent(w)).toMatchObject({
        type: "refund.failed",
        data: { refund: { id: refund.id, status: "failed" } },
      });
      // the money is back in the settlement balance, so the invoice can be refunded again
      expect((await ask(w, invoice.id, { amount: "5.00", idempotencyKey: "again" })).refund.status).toBe("submitted");
    },
  );

  it("does not turn a failure into a success later", async () => {
    const { w, invoice, refund } = await submitted();
    w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "FAILED"));
    w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "SUCCESS"));
    expect(w.refunds.get(refund.id).status).toBe("failed");
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("0");
  });

  it("moves a pending refund to submitted once 1Click has the deposit, with no event yet", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    w.client.submitIntent.mockRejectedValueOnce(oneClickFailure(0));
    const { refund } = await ask(w, invoice.id);
    const before = w.events().length;

    w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "PROCESSING"));

    expect(w.refunds.get(refund.id).status).toBe("submitted");
    expect(w.events()).toHaveLength(before);
  });

  it("keeps waiting while nothing has arrived, then gives up once the intent can no longer be used", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    w.client.submitIntent.mockRejectedValueOnce(oneClickFailure(0));
    const { refund } = await ask(w, invoice.id); // the intent is good for 15 minutes

    w.clock.advance(19 * MINUTE);
    w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "PENDING_DEPOSIT"));
    expect(w.refunds.get(refund.id).status).toBe("pending");

    w.clock.advance(2 * MINUTE);
    w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "PENDING_DEPOSIT"));
    expect(w.refunds.get(refund.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/never|expired/i),
    });
    expect(lastEvent(w).type).toBe("refund.failed");
  });

  it("stops watching a refund that has ended", async () => {
    const { w, refund } = await submitted();
    expect(w.refunds.listPollableRefunds().map((r) => r.id)).toEqual([refund.id]);
    w.refunds.applyRefundStatus(refund.id, w.statusOf(refund.id, "SUCCESS"));
    expect(w.refunds.listPollableRefunds()).toEqual([]);
  });

  it("leaves the invoice's refunded amount alone when an automatic refund of a duplicate payment succeeds", async () => {
    const w = makeRefundWorld();
    const { invoice, attempt } = await w.paidInvoice();
    const at = w.clock.now().toISOString();
    const { refund } = await ask(w, invoice.id, { amount: "1.00" }); // only to get a quote to answer for
    insertRefund(w.db, {
      ...w.refunds.get(refund.id),
      id: "ref_auto",
      attemptId: attempt.id,
      reason: "overpayment_auto",
      idempotencyKey: null,
      createdAt: at,
      updatedAt: at,
    });

    w.refunds.applyRefundStatus("ref_auto", w.statusOf("ref_auto", "SUCCESS"));

    expect(w.refunds.get("ref_auto").status).toBe("succeeded");
    expect(w.service.getInvoice(invoice.id).refundedAmount).toBe("0");
  });
});

describe("the settlement balance", () => {
  it("reports what the settlement account holds", async () => {
    const w = makeRefundWorld({ balance: 12_340_000n });
    expect(await w.refunds.balance()).toBe(12_340_000n);
  });

  it("reports 503 when the node cannot be reached", async () => {
    const w = makeRefundWorld();
    w.fail.readBalance = true;
    expect(await refusal(() => w.refunds.balance())).toMatchObject({ code: "upstream_unavailable", status: 503 });
  });
});
