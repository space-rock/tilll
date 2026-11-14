import { describe, expect, it } from "vitest";
import { OneClickError } from "../src/oneclick/client.js";
import { makeApp } from "./helpers/app.js";
import { USDC_BASE, statusResponseFor, REFUND_ADDRESS } from "./helpers/world.js";

type TestApp = Awaited<ReturnType<typeof makeApp>>;

const attemptBody = { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS };
const attemptUrl = (invoiceId: string) => `/pay/invoices/${invoiceId}/attempts`;
const createAttempt = (t: TestApp, invoiceId: string, payload: unknown = attemptBody) =>
  t.app.inject({ method: "POST", url: attemptUrl(invoiceId), payload: payload as object });

async function liveAttempt() {
  const t = await makeApp();
  const inv = t.service.createInvoice({ amount: "5" });
  const { id } = (await createAttempt(t, inv.id)).json();
  return { t, id, att: t.service.getAttempt(id) };
}

describe("GET /pay/invoices/:id", () => {
  it("shows the payer what they need and nothing the merchant keeps private, without any auth", async () => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5", description: "Coffee", metadata: { secret: "internal" } });

    const res = await t.app.inject({ method: "GET", url: `/pay/invoices/${inv.id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: inv.id,
      status: "open",
      amount: "5",
      asset: { id: inv.assetId, symbol: "USDC", decimals: 6 },
      description: "Coffee",
      expiresAt: inv.expiresAt,
    });
    expect(res.body).not.toContain("internal");
  });

  it("is a 404 for an unknown invoice", async () => {
    const t = await makeApp();
    expect((await t.app.inject({ method: "GET", url: "/pay/invoices/inv_nope" })).statusCode).toBe(404);
  });
});

describe("GET /pay/tokens", () => {
  it("lists origin tokens grouped by chain, without auth", async () => {
    const t = await makeApp();
    const res = await t.app.inject({ method: "GET", url: "/pay/tokens" });
    expect(res.statusCode).toBe(200);
    expect(res.json().chains.base).toContainEqual({ assetId: USDC_BASE, symbol: "USDC", decimals: 6 });
  });
});

describe("GET /pay/tokens enabledChains", () => {
  it("offers the chains with a strict address check, plus any EXTRA_CHAINS", async () => {
    const t = await makeApp({ extraChains: ["ltc"] });
    const { enabledChains, chains } = (await t.app.inject({ method: "GET", url: "/pay/tokens" })).json();
    expect(enabledChains).toEqual(expect.arrayContaining(["eth", "base", "arb", "sol", "near", "btc", "tron", "ltc"]));
    expect(enabledChains).not.toContain("doge");
    expect(enabledChains.every((c: string) => c in chains)).toBe(true);
  });

  it("drops an enabled chain that 1Click does not list, so the widget never shows an empty chain", async () => {
    const t = await makeApp({ extraChains: ["nowhere"] });
    expect((await t.app.inject({ method: "GET", url: "/pay/tokens" })).json().enabledChains).not.toContain("nowhere");
  });

  it("is also reported to the merchant API, which still lists every chain", async () => {
    const t = await makeApp();
    const res = (
      await t.app.inject({ method: "GET", url: "/v1/tokens", headers: { authorization: "Bearer sk_test_secret" } })
    ).json();
    expect(res.enabledChains).toContain("base");
    expect(Object.keys(res.chains)).toContain("doge");
  });
});

describe("POST /pay/invoices/:id/attempts", () => {
  it("creates an attempt and returns what the payer needs to send money", async () => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5" });

    const res = await createAttempt(t, inv.id);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.stringMatching(/^att_/),
      invoiceId: inv.id,
      status: "awaiting",
      invoiceStatus: "open",
      depositAddress: "0xDEPOSIT1",
      depositMemo: null,
      amountIn: "5.051529",
      symbol: "USDC",
      chain: "base",
      deadline: expect.any(String),
      timeEstimate: 35,
      txLinks: [],
    });
  });

  it("never reveals the refund address or the raw quote to whoever holds the link", async () => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5" });
    const res = await createAttempt(t, inv.id);
    expect(res.body).not.toContain(REFUND_ADDRESS);
    expect(res.body).not.toContain("signature");
  });

  it.each([
    ["a missing refund address", { originAsset: USDC_BASE }],
    ["a missing asset", { refundTo: "0xabc" }],
    ["a non-string refund address", { originAsset: USDC_BASE, refundTo: 5 }],
    ["an absurdly long refund address", { originAsset: USDC_BASE, refundTo: "x".repeat(300) }],
  ])("rejects %s", async (_name, payload) => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5" });
    const res = await createAttempt(t, inv.id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(t.client.quote).not.toHaveBeenCalled();
  });

  it("reports domain errors with their status: unsupported asset 400, closed invoice 409, unknown invoice 404", async () => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5" });
    const unsupported = await createAttempt(t, inv.id, { originAsset: "nep141:nope", refundTo: "0xabc" });
    expect([unsupported.statusCode, unsupported.json().error.code]).toEqual([400, "unsupported_asset"]);

    t.service.cancelInvoice(inv.id);
    const closed = await createAttempt(t, inv.id);
    expect([closed.statusCode, closed.json().error.code]).toEqual([409, "invoice_not_open"]);

    expect((await createAttempt(t, "inv_nope")).statusCode).toBe(404);
  });

  it("passes a 1Click rejection through as 422", async () => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5" });
    t.client.quote.mockRejectedValueOnce(new OneClickError(400, "Quoting for this pair is not available"));
    const res = await createAttempt(t, inv.id);
    expect([res.statusCode, res.json().error.code]).toEqual([422, "pair_unavailable"]);
  });
});

describe("GET /pay/attempts/:id", () => {
  it("follows the attempt through to paid, with the explorer link", async () => {
    const t = await makeApp();
    const inv = t.service.createInvoice({ amount: "5" });
    const { id } = (await createAttempt(t, inv.id)).json();

    const before = (await t.app.inject({ method: "GET", url: `/pay/attempts/${id}` })).json();
    expect([before.status, before.invoiceStatus]).toEqual(["awaiting", "open"]);

    const att = t.service.getAttempt(id);
    t.service.applyStatus(
      id,
      statusResponseFor(att.quote, "SUCCESS", {
        amountOut: "5000000",
        originChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
      }),
    );

    const after = (await t.app.inject({ method: "GET", url: `/pay/attempts/${id}` })).json();
    expect([after.status, after.invoiceStatus]).toEqual(["paid", "paid"]);
    expect(after.txLinks).toEqual([{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }]);
  });

  it("is a 404 for an unknown attempt", async () => {
    const t = await makeApp();
    expect((await t.app.inject({ method: "GET", url: "/pay/attempts/att_nope" })).statusCode).toBe(404);
  });
});

const submit = (t: TestApp, id: string, payload: unknown) =>
  t.app.inject({ method: "POST", url: `/pay/attempts/${id}/tx`, payload: payload as object });

describe("POST /pay/attempts/:id/tx", () => {
  it("forwards the tx hash to 1Click with the attempt's deposit address and applies the answer", async () => {
    const { t, id, att } = await liveAttempt();
    t.depositSubmit.mockResolvedValueOnce(statusResponseFor(att.quote, "KNOWN_DEPOSIT_TX"));

    const res = await submit(t, id, { txHash: "0xfeed" });

    expect(t.depositSubmit).toHaveBeenCalledWith({ txHash: "0xfeed", depositAddress: att.depositAddress });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("confirming");
    expect(t.service.getAttempt(id).status).toBe("confirming");
  });

  it("includes the memo when the attempt has one", async () => {
    const { t, id, att } = await liveAttempt();
    t.db.prepare("UPDATE attempts SET deposit_memo = '42' WHERE id = ?").run(id);
    t.depositSubmit.mockResolvedValueOnce(statusResponseFor(att.quote, "KNOWN_DEPOSIT_TX"));
    await submit(t, id, { txHash: "0xfeed" });
    expect(t.depositSubmit).toHaveBeenCalledWith({ txHash: "0xfeed", depositAddress: att.depositAddress, memo: "42" });
  });

  it("rejects a bad body without calling 1Click", async () => {
    const { t, id } = await liveAttempt();
    expect((await submit(t, id, {})).statusCode).toBe(400);
    expect((await submit(t, id, { txHash: "" })).statusCode).toBe(400);
    expect(t.depositSubmit).not.toHaveBeenCalled();
  });

  it("refuses once the attempt is closed", async () => {
    const { t, id, att } = await liveAttempt();
    t.service.applyStatus(id, statusResponseFor(att.quote, "FAILED"));
    const res = await submit(t, id, { txHash: "0xfeed" });
    expect([res.statusCode, res.json().error.code]).toEqual([409, "attempt_closed"]);
    expect(t.depositSubmit).not.toHaveBeenCalled();
  });

  it.each([
    [new OneClickError(400, "bad hash"), 422, "tx_rejected"],
    [new OneClickError(0, "fetch failed"), 503, "upstream_unavailable"],
    [new OneClickError(500, "boom"), 502, "upstream_error"],
  ])("maps %s to %i %s", async (upstream, status, code) => {
    const { t, id } = await liveAttempt();
    t.depositSubmit.mockRejectedValueOnce(upstream);
    const res = await submit(t, id, { txHash: "0xfeed" });
    expect([res.statusCode, res.json().error.code]).toEqual([status, code]);
  });
});

const preflight = (t: TestApp, origin: string) =>
  t.app.inject({
    method: "OPTIONS",
    url: "/pay/invoices/inv_x/attempts",
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });

describe("CORS", () => {
  it("allows any origin when ALLOWED_ORIGINS is *", async () => {
    const t = await makeApp({ allowedOrigins: ["*"] });
    expect((await preflight(t, "https://anywhere.example")).headers["access-control-allow-origin"]).toBe("*");
  });

  it("allows only the listed origins otherwise", async () => {
    const t = await makeApp({ allowedOrigins: ["https://shop.example"] });
    expect((await preflight(t, "https://shop.example")).headers["access-control-allow-origin"]).toBe(
      "https://shop.example",
    );
    expect((await preflight(t, "https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not open the merchant API to browsers", async () => {
    const t = await makeApp({ allowedOrigins: ["*"] });
    const res = await t.app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: { origin: "https://anywhere.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("rate limit", () => {
  it("limits the public routes per IP with the standard error shape, and leaves /v1 alone", async () => {
    const t = await makeApp({ rateLimit: { max: 3, timeWindow: "1 minute" } });
    const get = () => t.app.inject({ method: "GET", url: "/pay/tokens" });

    expect([(await get()).statusCode, (await get()).statusCode, (await get()).statusCode]).toEqual([200, 200, 200]);
    const limited = await get();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");

    const merchant = await t.app.inject({
      method: "GET",
      url: "/v1/tokens",
      headers: { authorization: "Bearer sk_test_secret" },
    });
    expect(merchant.statusCode).toBe(200);
  });
});
