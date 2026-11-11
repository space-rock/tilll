import { describe, expect, it } from "vitest";
import { makeRefundApp } from "./helpers/refundWorld.js";

const refundsUrl = (id: string) => `/v1/invoices/${id}/refunds`;

describe("the refund endpoints", () => {
  it.each([
    ["POST", (id: string) => `${refundsUrl(id)}/preview`],
    ["POST", refundsUrl],
    ["GET", () => "/v1/balance"],
  ] as const)("%s needs the merchant secret", async (method, url) => {
    const s = await makeRefundApp();
    const { invoice } = await s.paidInvoice();
    const response = await s.merchant(
      method,
      url(invoice.id),
      method === "POST" ? { idempotencyKey: "k" } : undefined,
      {},
    );
    expect(response.statusCode).toBe(401);
    expect(s.client.submitIntent).not.toHaveBeenCalled();
  });

  describe("POST /v1/invoices/:id/refunds/preview", () => {
    it("shows what the customer would receive, where and on which chain", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice("5.00");

      const response = await s.merchant("POST", `${refundsUrl(invoice.id)}/preview`, {});

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        invoiceId: invoice.id,
        amount: "5",
        destination: { chain: "base", symbol: "USDC", address: "0x1111111111111111111111111111111111111111" },
        estimate: { amountOutFormatted: "5.0" },
        note: expect.stringMatching(/today's price/),
      });
    });

    it("accepts a request with no body and one with an amount", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice("5.00");
      expect((await s.merchant("POST", `${refundsUrl(invoice.id)}/preview`)).statusCode).toBe(200);
      const small = await s.merchant("POST", `${refundsUrl(invoice.id)}/preview`, { amount: "1.25" });
      expect(small.json()).toMatchObject({ amount: "1.25", amountBase: "1250000" });
    });

    it.each([
      [{ amount: 5 }, 400, "invalid_request"],
      [{ amount: "5.01" }, 409, "refund_exceeds_remaining"],
      [{ amount: "0" }, 400, "invalid_amount"],
    ])("answers %j with %i %s", async (body, status, code) => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice("5.00");
      const response = await s.merchant("POST", `${refundsUrl(invoice.id)}/preview`, body);
      expect([response.statusCode, response.json().error.code]).toEqual([status, code]);
    });

    it("answers 404 for an invoice that does not exist", async () => {
      const s = await makeRefundApp();
      expect((await s.merchant("POST", `${refundsUrl("inv_nope")}/preview`, {})).statusCode).toBe(404);
    });
  });

  describe("POST /v1/invoices/:id/refunds", () => {
    it("starts the refund and answers 201 with the refund and the invoice", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice("5.00");

      const response = await s.merchant("POST", refundsUrl(invoice.id), { amount: "2.00", idempotencyKey: "order-17" });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        replayed: false,
        refund: {
          id: expect.stringMatching(/^ref_/),
          invoiceId: invoice.id,
          status: "submitted",
          amount: "2",
          amountBase: "2000000",
          reason: "merchant_request",
          idempotencyKey: "order-17",
          intentHash: expect.any(String),
          txLinks: [],
        },
        invoice: { id: invoice.id, status: "paid", refundedAmountBase: "0" },
      });
    });

    it("answers 200 and says so when the same key comes again", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice();
      const first = await s.merchant("POST", refundsUrl(invoice.id), { idempotencyKey: "same" });
      const again = await s.merchant("POST", refundsUrl(invoice.id), { idempotencyKey: "same" });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ replayed: true, refund: { id: first.json().refund.id } });
      expect(s.client.submitIntent).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["no key", {}],
      ["an empty key", { idempotencyKey: "" }],
      ["a key that is not a string", { idempotencyKey: 7 }],
      ["a key over 200 characters", { idempotencyKey: "k".repeat(201) }],
    ])("refuses %s, and refunds nothing", async (_name, body) => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice();
      const response = await s.merchant("POST", refundsUrl(invoice.id), body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("idempotencyKey"),
      });
      expect(s.client.quote).not.toHaveBeenCalled();
    });

    it.each([["a key reused for another amount", 409, "idempotency_key_reused"]])(
      "explains %s",
      async (_name, status, code) => {
        const s = await makeRefundApp();
        const { invoice } = await s.paidInvoice();
        await s.merchant("POST", refundsUrl(invoice.id), { amount: "1.00", idempotencyKey: "k" });
        const response = await s.merchant("POST", refundsUrl(invoice.id), { amount: "2.00", idempotencyKey: "k" });
        expect([response.statusCode, response.json().error.code]).toEqual([status, code]);
      },
    );

    it("answers 409 when the invoice is not paid, 409 when the balance is short, 422 over the limit, 503 without a balance", async () => {
      const open = await makeRefundApp();
      const unpaid = open.service.createInvoice({ amount: "5" });
      expect((await open.merchant("POST", refundsUrl(unpaid.id), { idempotencyKey: "k" })).json().error.code).toBe(
        "invoice_not_paid",
      );

      const poor = await makeRefundApp({ balance: 1n });
      const a = await poor.paidInvoice();
      const short = await poor.merchant("POST", refundsUrl(a.invoice.id), { idempotencyKey: "k" });
      expect([short.statusCode, short.json().error.code]).toEqual([409, "insufficient_balance"]);

      const strict = await makeRefundApp({ maxPerTx: 1_000_000n });
      const b = await strict.paidInvoice();
      const over = await strict.merchant("POST", refundsUrl(b.invoice.id), { idempotencyKey: "k" });
      expect([over.statusCode, over.json().error.code]).toEqual([422, "refund_limit_exceeded"]);

      const blind = await makeRefundApp();
      const c = await blind.paidInvoice();
      blind.fail.readBalance = true;
      const down = await blind.merchant("POST", refundsUrl(c.invoice.id), { idempotencyKey: "k" });
      expect([down.statusCode, down.json().error.code]).toEqual([503, "upstream_unavailable"]);
    });

    it("answers 502 intent_refused when 1Click hands back an intent that would move other money", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice();
      s.behaviour.intent = (req, quote) => {
        const honest = s.behaviour.honest(req, quote);
        const message = JSON.parse(honest.intent.payload.message);
        message.intents[0].receiver_id = "b".repeat(64);
        return {
          ...honest,
          intent: { ...honest.intent, payload: { ...honest.intent.payload, message: JSON.stringify(message) } },
        };
      };
      const response = await s.merchant("POST", refundsUrl(invoice.id), { idempotencyKey: "k" });
      expect([response.statusCode, response.json().error.code]).toEqual([502, "intent_refused"]);
      expect(s.client.submitIntent).not.toHaveBeenCalled();
    });
  });

  describe("the invoice afterwards", () => {
    it("lists the refund, and shows the transfer once 1Click reports it", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice("5.00");
      const { refund } = (
        await s.merchant("POST", refundsUrl(invoice.id), { amount: "2.00", idempotencyKey: "k" })
      ).json();
      s.refunds.applyRefundStatus(
        refund.id,
        s.statusOf(refund.id, "SUCCESS", {
          destinationChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
        }),
      );

      const detail = (await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json();

      expect(detail.invoice).toMatchObject({ refundedAmount: "2", refundedAmountBase: "2000000" });
      expect(detail.refunds).toMatchObject([
        {
          id: refund.id,
          status: "succeeded",
          txLinks: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
        },
      ]);
    });
  });

  describe("GET /v1/balance", () => {
    it("reports the settlement balance of the settlement asset", async () => {
      const s = await makeRefundApp({ balance: 12_340_000n });
      const response = await s.merchant("GET", "/v1/balance");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        asset: { id: expect.stringContaining("nep141:"), symbol: "USDC", decimals: 6 },
        account: "shop-pay.near",
        balance: "12.34",
        balanceBase: "12340000",
      });
    });

    it("answers 503 when the node cannot be reached", async () => {
      const s = await makeRefundApp();
      s.fail.readBalance = true;
      const response = await s.merchant("GET", "/v1/balance");
      expect([response.statusCode, response.json().error.code]).toEqual([503, "upstream_unavailable"]);
    });
  });
});
