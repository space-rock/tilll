import { describe, expect, it } from "vitest";
import { AUTH, makeApp } from "./helpers/app.js";
import { USDC_BASE, REFUND_ADDRESS } from "./helpers/world.js";

const post = (app: Awaited<ReturnType<typeof makeApp>>["app"], url: string, payload: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });

describe("merchant auth", () => {
  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer nope" }],
    ["a secret of a different length", { authorization: "Bearer x" }],
    ["a non-Bearer scheme", { authorization: "Basic sk_test_secret" }],
    ["an empty bearer token", { authorization: "Bearer " }],
  ])("rejects %s with 401", async (_name, headers) => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/invoices", headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
  });

  it("lets the right secret through", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/invoices", headers: AUTH })).statusCode).toBe(200);
  });
});

describe("POST /v1/invoices", () => {
  it("creates an open invoice and returns its pay URL", async () => {
    const { app, service } = await makeApp();

    const res = await post(app, "/v1/invoices", {
      amount: "5.00",
      description: "Coffee",
      metadata: { orderId: "A-17" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      status: "open",
      amount: "5",
      amountBase: "5000000",
      description: "Coffee",
      metadata: { orderId: "A-17" },
      payUrl: `http://localhost:8080/pay/${body.id}`,
    });
    expect(body.expiresAt).toEqual(expect.any(String));
    expect(service.getInvoice(body.id).amount).toBe("5000000");
  });

  it.each([
    ["a numeric amount", { amount: 5 }],
    ["a missing amount", {}],
    ["a non-string description", { amount: "5", description: 7 }],
    ["a non-integer expiry", { amount: "5", expiresInMinutes: "soon" }],
    ["oversized metadata", { amount: "5", metadata: { blob: "x".repeat(5000) } }],
  ])("rejects %s as invalid_request", async (_name, payload) => {
    const { app } = await makeApp();
    const res = await post(app, "/v1/invoices", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("says why a numeric amount is refused", async () => {
    const { app } = await makeApp();
    const res = await post(app, "/v1/invoices", { amount: 5 });
    expect(res.json().error.message).toMatch(/amount.*string/i);
  });

  it("passes domain errors through with their own code", async () => {
    const { app } = await makeApp();
    const res = await post(app, "/v1/invoices", { amount: "0" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_amount");
  });

  it("answers malformed JSON with a 400 in the same error shape", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      payload: "{not json",
      headers: { ...AUTH, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});

describe("GET /v1/invoices/:id", () => {
  it("returns the invoice with its attempts (including the raw 1Click quote) and refunds", async () => {
    const { app, service } = await makeApp();
    const inv = service.createInvoice({ amount: "5" });
    const att = await service.createAttempt(inv.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });

    const res = await app.inject({ method: "GET", url: `/v1/invoices/${inv.id}`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.invoice).toMatchObject({ id: inv.id, status: "open", amount: "5" });
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]).toMatchObject({
      id: att.id,
      status: "awaiting",
      refundTo: REFUND_ADDRESS,
      amountIn: "5.051529",
    });
    expect(body.attempts[0].raw.quote.signature).toBe(att.quote.signature);
    expect(body.refunds).toEqual([]);
  });

  it("is a 404 in the standard error shape for an unknown invoice", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/invoices/inv_nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });
});

describe("GET /v1/invoices", () => {
  it("lists newest first with a cursor and filters by status", async () => {
    const { app, service, clock } = await makeApp();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      ids.push(service.createInvoice({ amount: "1" }).id);
    }
    service.cancelInvoice(ids[0]!);

    const page = (await app.inject({ method: "GET", url: "/v1/invoices?limit=2", headers: AUTH })).json();
    expect(page.invoices.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]]);
    expect(page.nextCursor).toBe(ids[1]);

    const next = (
      await app.inject({ method: "GET", url: `/v1/invoices?limit=2&cursor=${page.nextCursor}`, headers: AUTH })
    ).json();
    expect(next.invoices.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
    expect(next.nextCursor).toBeNull();

    const canceled = (await app.inject({ method: "GET", url: "/v1/invoices?status=canceled", headers: AUTH })).json();
    expect(canceled.invoices.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
  });

  it.each(["status=bogus", "limit=abc", "limit=0", "limit=101"])("rejects ?%s", async (query) => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: `/v1/invoices?${query}`, headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});

describe("POST /v1/invoices/:id/cancel", () => {
  it("cancels an open invoice, then refuses to cancel it again", async () => {
    const { app, service } = await makeApp();
    const inv = service.createInvoice({ amount: "5" });

    const first = await post(app, `/v1/invoices/${inv.id}/cancel`, {});
    expect(first.statusCode).toBe(200);
    expect(first.json().invoice.status).toBe("canceled");

    const second = await post(app, `/v1/invoices/${inv.id}/cancel`, {});
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("invoice_not_open");
  });
});

describe("GET /v1/tokens", () => {
  it("groups the supported origin tokens by chain", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/v1/tokens", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const { chains } = res.json();
    expect(chains.base).toContainEqual({ assetId: USDC_BASE, symbol: "USDC", decimals: 6 });
    expect(Object.keys(chains)).toContain("sol");
  });
});

describe("POST /v1/webhooks/test", () => {
  it("sends a ping and reports whether the merchant's endpoint accepted it", async () => {
    const { app, sendPing } = await makeApp();
    sendPing.mockResolvedValueOnce({
      id: "evt_PING",
      delivered: true,
      status: 200,
      error: null,
      attempts: 1,
      gaveUp: false,
    });

    const res = await post(app, "/v1/webhooks/test", {});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eventId: "evt_PING",
      delivered: true,
      status: 200,
      error: null,
      durationMs: expect.any(Number),
    });
  });

  it("reports an unhappy endpoint as data, not as a server error, so the merchant can see why", async () => {
    const { app, sendPing } = await makeApp();
    sendPing.mockResolvedValueOnce({
      id: "evt_PING",
      delivered: false,
      status: 500,
      error: "HTTP 500",
      attempts: 1,
      gaveUp: false,
    });

    const res = await post(app, "/v1/webhooks/test", {});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      eventId: "evt_PING",
      delivered: false,
      status: 500,
      error: "HTTP 500",
      durationMs: expect.any(Number),
    });
  });

  it("needs the merchant secret", async () => {
    const { app, sendPing } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/test", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(sendPing).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("answers an unknown route with a JSON 404", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/nowhere" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("hides the details of an unexpected failure behind a 500", async () => {
    const { app, service } = await makeApp();
    service.listInvoices = () => {
      throw new TypeError("secret internals: /Users/me/tilll/src/db.ts");
    };
    const res = await app.inject({ method: "GET", url: "/v1/invoices", headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: "internal_error", message: "Something went wrong. Try again in a moment." },
    });
    expect(res.body).not.toContain("secret internals");
  });
});
