import { describe, expect, it } from "vitest";
import { signNep413 } from "../src/near/nep413.js";
import { TEST_SECRET, makeRefundApp } from "./helpers/refundWorld.js";

const refundsUrl = (id: string) => `/v1/invoices/${id}/refunds`;

/** A paid invoice and a refund of 2.00 asked for on it, waiting for the wallet. */
const asked = async (s: Awaited<ReturnType<typeof makeRefundApp>>) => {
  const { invoice } = await s.paidInvoice("5.00");
  const { refund } = (await s.merchant("POST", refundsUrl(invoice.id), { amount: "2.00", idempotencyKey: "k" })).json();
  return { invoice, refund };
};

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
    it("asks for the refund and answers 201 with the refund waiting for approval, and the invoice", async () => {
      const s = await makeRefundApp();
      const { invoice } = await s.paidInvoice("5.00");

      const response = await s.merchant("POST", refundsUrl(invoice.id), { amount: "2.00", idempotencyKey: "order-17" });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        replayed: false,
        refund: {
          id: expect.stringMatching(/^ref_/),
          invoiceId: invoice.id,
          status: "awaiting_approval",
          amount: "2",
          amountBase: "2000000",
          reason: "merchant_request",
          idempotencyKey: "order-17",
          intentHash: null,
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
      expect(s.client.quote).not.toHaveBeenCalled();
      expect(s.client.submitIntent).not.toHaveBeenCalled();
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

    it("answers 502 intent_refused at prepare when 1Click hands back an intent that would move other money", async () => {
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
      const requested = await s.merchant("POST", refundsUrl(invoice.id), { idempotencyKey: "k" });
      const response = await s.merchant("POST", `/v1/refunds/${requested.json().refund.id}/prepare`, {});
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
      await s.approve(refund.id);
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

  describe("approving a refund with the wallet", () => {
    it("prepares the refund: the payload to sign, who signs it, when it expires, and a summary", async () => {
      const s = await makeRefundApp();
      const { refund } = await asked(s);

      const response = await s.merchant("POST", `/v1/refunds/${refund.id}/prepare`, {});

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        refund: { id: refund.id, status: "awaiting_approval" },
        signerId: "shop-pay.near",
        payload: { recipient: "intents.near", message: expect.any(String), nonce: expect.any(String) },
        expiresAt: expect.any(String),
        summary: { amount: "2", destination: { chain: "base", symbol: "USDC" } },
      });
    });

    it("submits the wallet's signature and answers with the refund, now submitted, and the invoice", async () => {
      const s = await makeRefundApp();
      const { refund } = await asked(s);
      const prepared = (await s.merchant("POST", `/v1/refunds/${refund.id}/prepare`, {})).json();
      const signed = signNep413(TEST_SECRET, prepared.payload);

      const response = await s.merchant("POST", `/v1/refunds/${refund.id}/submit`, {
        publicKey: signed.public_key,
        signature: signed.signature,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        refund: { id: refund.id, status: "submitted", intentHash: expect.any(String) },
        invoice: { status: "paid" },
      });
    });

    it.each([
      ["no body", undefined, "invalid_request"],
      ["no signature", { publicKey: "x" }, "invalid_request"],
      [
        "a signature that is not one",
        { publicKey: "ed25519:3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", signature: "AAAA" },
        "invalid_key",
      ],
    ])("refuses %s with a 4xx and sends nothing", async (_name, body, code) => {
      const s = await makeRefundApp();
      const { refund } = await asked(s);
      await s.merchant("POST", `/v1/refunds/${refund.id}/prepare`, {});

      const response = await s.merchant("POST", `/v1/refunds/${refund.id}/submit`, body as object | undefined);

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(response.json().error.code).toBe(code);
      expect(s.client.submitIntent).not.toHaveBeenCalled();
    });

    it("needs the merchant secret for all three", async () => {
      const s = await makeRefundApp();
      const { refund } = await asked(s);
      for (const action of ["prepare", "submit", "cancel"]) {
        const response = await s.merchant("POST", `/v1/refunds/${refund.id}/${action}`, {}, {});
        expect(response.statusCode).toBe(401);
      }
    });

    it("cancels a waiting refund, and refuses once it has been sent", async () => {
      const s = await makeRefundApp();
      const { refund } = await asked(s);
      const canceled = await s.merchant("POST", `/v1/refunds/${refund.id}/cancel`, {});
      expect(canceled.statusCode).toBe(200);
      expect(canceled.json().refund).toMatchObject({ status: "failed", error: "Canceled." });

      const { refund: second } = (
        await s.merchant("POST", refundsUrl((await asked(s)).invoice.id), { idempotencyKey: "other" })
      ).json();
      await s.approve(second.id);
      const late = await s.merchant("POST", `/v1/refunds/${second.id}/cancel`, {});
      expect([late.statusCode, late.json().error.code]).toEqual([409, "cannot_cancel"]);
    });

    it("says which key to register when the wallet's key is not registered, and refuses a post-quantum key", async () => {
      const s = await makeRefundApp();
      s.keys.registered = false;
      const { refund } = await asked(s);
      const prepared = (await s.merchant("POST", `/v1/refunds/${refund.id}/prepare`, {})).json();
      const signed = signNep413(TEST_SECRET, prepared.payload);

      const unregistered = await s.merchant("POST", `/v1/refunds/${refund.id}/submit`, {
        publicKey: signed.public_key,
        signature: signed.signature,
      });
      expect([unregistered.statusCode, unregistered.json().error.code]).toEqual([409, "key_not_registered"]);

      const pq = await s.merchant("POST", `/v1/refunds/${refund.id}/submit`, {
        publicKey: "mldsa65:" + "1".repeat(60),
        signature: "mldsa65:" + "1".repeat(80),
      });
      expect([pq.statusCode, pq.json().error.code]).toEqual([422, "unsupported_key_type"]);
    });

    it("lists refunds by status, with the counts, and shows the waiting ones in the overview", async () => {
      const s = await makeRefundApp();
      const { refund } = await asked(s);

      const waiting = (await s.merchant("GET", "/v1/refunds?status=awaiting_approval")).json();
      expect(waiting.refunds.map((r: { id: string }) => r.id)).toEqual([refund.id]);
      expect(waiting.counts).toMatchObject({ awaiting_approval: 1, submitted: 0 });
      expect((await s.merchant("GET", "/v1/refunds?status=succeeded")).json().refunds).toEqual([]);
      expect((await s.merchant("GET", "/v1/refunds?status=nope")).statusCode).toBe(400);
      expect((await s.merchant("GET", "/v1/overview")).json().refundsAwaitingApproval).toBe(1);
      expect((await s.merchant("GET", `/v1/refunds/${refund.id}`)).json().refund.id).toBe(refund.id);
    });

    it("tells the dashboard which network the wallet must be on, and no longer lists key types", async () => {
      const s = await makeRefundApp();
      const settings = (await s.merchant("GET", "/v1/settings")).json();
      expect(settings).toMatchObject({
        account: "shop-pay.near",
        network: expect.stringMatching(/^(mainnet|testnet)$/),
      });
      expect(settings).not.toHaveProperty("keyTypes");
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
