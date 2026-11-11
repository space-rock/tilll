import { afterEach, describe, expect, it } from "vitest";
import { publicKeyOf } from "../src/near/keys.js";
import { verifyNep413 } from "../src/near/nep413.js";
import { TEST_SECRET } from "./helpers/refundWorld.js";
import { EVM_ADDRESS, makeStack, type Stack } from "./helpers/stack.js";
import { USDC_BASE } from "./helpers/world.js";

const SECOND = 1000;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function start() {
  stack = await makeStack({ startAt: new Date() });
  return stack;
}

async function paidInvoice(s: Stack, amount = "5.00") {
  const invoice = (await s.merchant("POST", "/v1/invoices", { amount })).json();
  const attempt = (
    await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, { originAsset: USDC_BASE, refundTo: EVM_ADDRESS })
  ).json();
  s.fake.setStatus(attempt.depositAddress, "SUCCESS");
  s.clock.advance(10 * SECOND);
  await s.poller.pollOnce();
  return { invoice, attempt };
}

const refund = (s: Stack, invoiceId: string, body: object) =>
  s.merchant("POST", `/v1/invoices/${invoiceId}/refunds`, body);

describe("a refund, from the merchant's request to the money arriving (Phase 5 exit check, on mocks)", () => {
  it("is signed by the settlement key, accepted by the verifier, paid out, counted, and announced by a signed webhook", async () => {
    const s = await start();
    const { invoice } = await paidInvoice(s);
    await s.dispatcher.deliverDue(); // invoice.paid
    s.receiver.events.length = 0;

    const response = await refund(s, invoice.id, { amount: "2.00", idempotencyKey: "order-17-refund" });
    expect(response.statusCode).toBe(201);
    const { refund: created } = response.json();

    // 1Click was asked for a real refund quote funded from the Intents balance, paid out to the payer's own address.
    const quotes = s.fake.to("/v0/quote").map((r) => r.body!);
    expect(quotes.at(-1)).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "INTENTS",
      originAsset: expect.stringContaining("nep141:1720"),
      destinationAsset: USDC_BASE,
      amount: "2000000",
      recipient: EVM_ADDRESS,
      recipientType: "DESTINATION_CHAIN",
      refundTo: "shop-pay.near",
      refundType: "INTENTS",
    });
    // The intent that reached the verifier carries the settlement key's valid NEP-413 signature.
    expect(s.fake.submitted).toHaveLength(1);
    const signed = s.fake.submitted[0]!;
    expect(signed.public_key).toBe(publicKeyOf(TEST_SECRET));
    expect(verifyNep413(signed)).toBe(true);

    // Still nothing counted: the money has not arrived.
    expect(s.service.getInvoice(invoice.id).refundedAmount).toBe("0");

    // 1Click finishes the swap.
    const address = s.refunds.get(created.id).depositAddress!;
    s.fake.setStatus(address, "SUCCESS", {
      destinationChainTxHashes: [{ hash: "0xrefundtx", explorerUrl: "https://basescan.org/tx/0xrefundtx" }],
    });
    s.clock.advance(11 * SECOND);
    await s.poller.pollOnce();

    const detail = (await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json();
    expect(detail.invoice).toMatchObject({ refundedAmountBase: "2000000" });
    expect(detail.refunds).toMatchObject([{ id: created.id, status: "succeeded", txLinks: [{ hash: "0xrefundtx" }] }]);

    // The merchant's server hears about it, over a signature it verifies.
    expect(await s.dispatcher.deliverDue()).toMatchObject({ delivered: 1, failed: 0 });
    expect(s.receiver.events).toHaveLength(1);
    expect(s.receiver.events[0]).toMatchObject({
      type: "refund.succeeded",
      data: {
        invoice: { id: invoice.id, refundedAmountBase: "2000000" },
        refund: { id: created.id, amountBase: "2000000", txLinks: [{ hash: "0xrefundtx" }] },
      },
    });
  });

  it("sends nothing twice when the request is repeated", async () => {
    const s = await start();
    const { invoice } = await paidInvoice(s);
    const first = (await refund(s, invoice.id, { idempotencyKey: "k" })).json();
    const again = await refund(s, invoice.id, { idempotencyKey: "k" });

    expect(again.statusCode).toBe(200);
    expect(again.json().refund.id).toBe(first.refund.id);
    expect(s.fake.to("/v0/generate-intent")).toHaveLength(1);
    expect(s.fake.submitted).toHaveLength(1);
  });

  it("reports a refund 1Click could not complete, and lets the merchant try again", async () => {
    const s = await start();
    const { invoice } = await paidInvoice(s);
    const { refund: created } = (await refund(s, invoice.id, { idempotencyKey: "k" })).json();
    await s.dispatcher.deliverDue();
    s.receiver.events.length = 0;

    s.fake.setStatus(s.refunds.get(created.id).depositAddress!, "REFUNDED", { refundReason: "no route" });
    s.clock.advance(11 * SECOND);
    await s.poller.pollOnce();
    await s.dispatcher.deliverDue();

    expect(s.receiver.events).toMatchObject([
      { type: "refund.failed", data: { refund: { id: created.id, status: "failed" } } },
    ]);
    expect(s.service.getInvoice(invoice.id).refundedAmount).toBe("0");
    expect((await refund(s, invoice.id, { idempotencyKey: "k2" })).statusCode).toBe(201);
  });

  it("previews the refund with a dry quote that creates no deposit address", async () => {
    const s = await start();
    const { invoice } = await paidInvoice(s);
    const before = s.fake.to("/v0/quote").length;

    const response = await s.merchant("POST", `/v1/invoices/${invoice.id}/refunds/preview`, { amount: "1.00" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      amountBase: "1000000",
      destination: { address: EVM_ADDRESS, chain: "base" },
    });
    const sent = s.fake.to("/v0/quote").slice(before);
    expect(sent.map((r) => r.body!.dry)).toEqual([true]);
    expect(s.fake.to("/v0/generate-intent")).toHaveLength(0);
  });

  it("answers 502 refund_failed when 1Click rejects the signed intent, and counts nothing", async () => {
    const s = await start();
    const { invoice } = await paidInvoice(s);
    s.fake.failNext("/v0/submit-intent", 400, { message: "invalid signature" });
    const response = await refund(s, invoice.id, { idempotencyKey: "k" });
    expect([response.statusCode, response.json().error.code]).toEqual([502, "refund_failed"]);
    expect(s.service.getInvoice(invoice.id).refundedAmount).toBe("0");
  });
});
