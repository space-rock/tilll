import { describe, expect, it } from "vitest";
import { enqueueEvent } from "../src/events.js";
import type { DeliveryResult } from "../src/webhooks/dispatcher.js";
import { TEST_SECRET, makeRefundApp } from "./helpers/refundWorld.js";

const HOUR = 3_600_000;
const refundsUrl = (id: string) => `/v1/invoices/${id}/refunds`;

describe("GET /v1/overview", () => {
  it("needs the merchant secret", async () => {
    const s = await makeRefundApp();
    expect((await s.merchant("GET", "/v1/overview", undefined, {})).statusCode).toBe(401);
  });

  it("sums up the balance, today's payments, open invoices and today's refunds against the limits", async () => {
    const s = await makeRefundApp({ balance: 12_340_000n, maxPerDay: 20_000_000n, maxPerTx: 10_000_000n });
    const { invoice } = await s.paidInvoice("5.00");
    await s.paidInvoice("3.00");
    s.service.createInvoice({ amount: "1.00" });
    await s.merchant("POST", refundsUrl(invoice.id), { amount: "2.00", idempotencyKey: "k" });

    const body = (await s.merchant("GET", "/v1/overview")).json();

    expect(body).toEqual({
      asset: { id: expect.stringContaining("nep141:"), symbol: "USDC", decimals: 6 },
      account: "shop-pay.near",
      balance: { value: "12.34", valueBase: "12340000" },
      paidToday: { count: 2, amount: "8", amountBase: "8000000" },
      openInvoices: 1,
      refundedToday: { amount: "2", amountBase: "2000000" },
      limits: { maxPerTx: "10", maxPerTxBase: "10000000", maxPerDay: "20", maxPerDayBase: "20000000" },
      day: s.clock.now().toISOString().slice(0, 10),
    });
  });

  it("counts only payments made today", async () => {
    const s = await makeRefundApp();
    await s.paidInvoice("5.00");
    s.clock.advance(24 * HOUR);
    expect((await s.merchant("GET", "/v1/overview")).json()).toMatchObject({
      paidToday: { count: 0, amountBase: "0" },
      refundedToday: { amountBase: "0" },
    });
  });

  it("still answers when the balance cannot be read, and says why", async () => {
    const s = await makeRefundApp();
    s.fail.readBalance = true;
    const response = await s.merchant("GET", "/v1/overview");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balance: null, balanceError: expect.stringContaining("balance") });
  });
});

async function shop() {
  const s = await makeRefundApp();
  const coffee = s.service.createInvoice({
    amount: "5",
    description: "Coffee beans",
    metadata: { orderId: "A-17", customer: "ana" },
  });
  const tea = s.service.createInvoice({ amount: "3", description: "Green tea", metadata: { orderId: "B-02" } });
  const search = async (q: string) =>
    ((await s.merchant("GET", `/v1/invoices?q=${encodeURIComponent(q)}`)).json().invoices as { id: string }[]).map(
      (i) => i.id,
    );
  return { s, coffee, tea, search };
}

describe("searching invoices", () => {
  it("finds an invoice by its id, by part of its description, and by its metadata, ignoring case", async () => {
    const { coffee, tea, search } = await shop();
    expect(await search(coffee.id)).toEqual([coffee.id]);
    expect(await search(tea.id.slice(0, 14))).toContain(tea.id);
    expect(await search("COFFEE")).toEqual([coffee.id]);
    expect(await search("a-17")).toEqual([coffee.id]);
    expect(await search("ana")).toEqual([coffee.id]);
  });

  it("finds nothing for nothing, and treats % and _ as plain characters", async () => {
    const { search } = await shop();
    expect(await search("zzz")).toEqual([]);
    expect(await search("%")).toEqual([]);
    expect(await search("x_x")).toEqual([]); // LIKE would match any three characters here
    expect(await search("a-1_")).toEqual([]);
  });

  it("combines with the status filter, and an empty search lists everything", async () => {
    const { s, coffee, tea, search } = await shop();
    expect((await search("")).toSorted()).toEqual([coffee.id, tea.id].toSorted());
    s.service.cancelInvoice(tea.id);
    const canceled = (await s.merchant("GET", "/v1/invoices?status=canceled&q=tea")).json().invoices;
    expect(canceled.map((i: { id: string }) => i.id)).toEqual([tea.id]);
    expect((await s.merchant("GET", "/v1/invoices?status=open&q=tea")).json().invoices).toEqual([]);
  });

  it("refuses a very long search", async () => {
    const { s } = await shop();
    expect((await s.merchant("GET", `/v1/invoices?q=${"a".repeat(101)}`)).statusCode).toBe(400);
  });
});

describe("GET /v1/refunds", () => {
  it("lists refunds of every invoice, newest first, in pages", async () => {
    const s = await makeRefundApp();
    const ids: string[] = [];
    for (const key of ["a", "b", "c"]) {
      const { invoice } = await s.paidInvoice();
      const response = await s.merchant("POST", refundsUrl(invoice.id), { idempotencyKey: key, amount: "1.00" });
      ids.push(response.json().refund.id);
    }

    const first = (await s.merchant("GET", "/v1/refunds?limit=2")).json();
    expect(first.refunds.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).toBe(ids[1]);
    expect(first.refunds[0]).toMatchObject({ status: "submitted", amountBase: "1000000", reason: "merchant_request" });

    const second = (await s.merchant("GET", `/v1/refunds?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.refunds.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("includes automatic refunds", async () => {
    const s = await makeRefundApp();
    await s.duplicatePayment();
    expect((await s.merchant("GET", "/v1/refunds")).json().refunds).toMatchObject([{ reason: "overpayment_auto" }]);
  });
});

describe("the webhook log", () => {
  it("lists events newest first with their state and payload", async () => {
    const s = await makeRefundApp();
    const { invoice } = await s.paidInvoice(); // queues nothing: paidInvoice applies the status but we add events by hand below
    const at = s.clock.now();
    const delivered = enqueueEvent(s.db, { type: "invoice.paid", data: { invoice: { id: invoice.id } } }, at);
    const failing = enqueueEvent(s.db, { type: "invoice.expired", data: { invoice: { id: invoice.id } } }, at);
    const pending = enqueueEvent(s.db, { type: "refund.succeeded", data: {} }, at);
    s.db
      .prepare("UPDATE webhook_deliveries SET delivered_at = ?, next_try_at = NULL, attempts = 1 WHERE id = ?")
      .run(at.toISOString(), delivered);
    s.db
      .prepare("UPDATE webhook_deliveries SET next_try_at = NULL, attempts = 6, last_error = 'HTTP 500' WHERE id = ?")
      .run(failing);

    const body = (await s.merchant("GET", "/v1/webhooks?limit=3")).json();

    expect(body.deliveries.map((d: { id: string }) => d.id)).toEqual([pending, failing, delivered]);
    expect(body.deliveries).toMatchObject([
      {
        type: "refund.succeeded",
        state: "pending",
        attempts: 0,
        nextTryAt: at.toISOString(),
        deliveredAt: null,
        lastError: null,
      },
      { type: "invoice.expired", state: "failed", attempts: 6, nextTryAt: null, lastError: "HTTP 500" },
      { type: "invoice.paid", state: "delivered", attempts: 1, deliveredAt: at.toISOString() },
    ]);
    expect(body.deliveries[2].payload).toMatchObject({
      id: delivered,
      type: "invoice.paid",
      data: { invoice: { id: invoice.id } },
    });
  });

  it("pages through the log", async () => {
    const s = await makeRefundApp();
    const ids = [1, 2, 3].map(() => enqueueEvent(s.db, { type: "ping", data: {} }, s.clock.now()));
    const first = (await s.merchant("GET", "/v1/webhooks?limit=2")).json();
    expect(first.nextCursor).toBe(first.deliveries[1].id);
    const second = (await s.merchant("GET", `/v1/webhooks?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.deliveries.map((d: { id: string }) => d.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  describe("resending", () => {
    it("sends the event again even if it was delivered, and reports how the endpoint answered", async () => {
      const s = await makeRefundApp();
      const id = enqueueEvent(s.db, { type: "invoice.paid", data: {} }, s.clock.now());
      const result: DeliveryResult = {
        id,
        delivered: false,
        status: 500,
        error: "HTTP 500",
        attempts: 2,
        gaveUp: false,
      };
      s.dispatcher.deliver.mockResolvedValueOnce(result);

      const response = await s.merchant("POST", `/v1/webhooks/${id}/resend`);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id,
        delivered: false,
        status: 500,
        error: "HTTP 500",
        attempts: 2,
        gaveUp: false,
      });
      expect(s.dispatcher.deliver).toHaveBeenCalledWith(id, { force: true });
    });

    it("answers 404 for an event that does not exist, without sending anything", async () => {
      const s = await makeRefundApp();
      const response = await s.merchant("POST", "/v1/webhooks/evt_nope/resend");
      expect(response.statusCode).toBe(404);
      expect(s.dispatcher.deliver).not.toHaveBeenCalled();
    });

    it("needs the merchant secret", async () => {
      const s = await makeRefundApp();
      const id = enqueueEvent(s.db, { type: "ping", data: {} }, s.clock.now());
      expect((await s.merchant("POST", `/v1/webhooks/${id}/resend`, undefined, {})).statusCode).toBe(401);
      expect(s.dispatcher.deliver).not.toHaveBeenCalled();
    });
  });
});

describe("GET /v1/settings", () => {
  it("shows how Tilll is set up, without a single secret", async () => {
    const s = await makeRefundApp({ maxPerTx: 10_000_000n, maxPerDay: 20_000_000n });
    const response = await s.merchant("GET", "/v1/settings");
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      account: "shop-pay.near",
      asset: { symbol: "USDC", decimals: 6 },
      intentsContract: "intents.near",
      publicBaseUrl: "http://localhost:8080",
      webhookUrl: "https://merchant.example/hooks/tilll",
      oneclick: { baseUrl: "https://1click.example", apiKeySet: true, reachable: true },
      limits: { maxPerTx: "10", maxPerDay: "20" },
      attemptDeadlineMinutes: 30,
      slippageBps: 100,
    });
    for (const secret of ["sk_test_secret", TEST_SECRET, "whsec_", "partner-jwt-value"]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("leaves credentials out of the URLs it shows", async () => {
    const s = await makeRefundApp();
    s.info.webhookUrl = "https://user:hunter2@merchant.example/hooks/tilll?x=1";
    s.info.oneclickBaseUrl = "https://key:abc@1click.example";
    const response = await s.merchant("GET", "/v1/settings");
    expect(response.json()).toMatchObject({
      webhookUrl: "https://merchant.example/hooks/tilll?x=1",
      oneclick: { baseUrl: "https://1click.example" },
    });
    expect(response.body).not.toMatch(/hunter2|abc@/);
  });

  it("says 1Click is unreachable when the token list cannot be fetched", async () => {
    const s = await makeRefundApp();
    s.tokens.fail = true;
    expect((await s.merchant("GET", "/v1/settings")).json().oneclick.reachable).toBe(false);
  });
});
