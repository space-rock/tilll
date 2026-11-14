import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Encode, implicitAccountOf } from "../src/near/keys.js";
import { signNep413, type Nep413Payload } from "../src/near/nep413.js";
import { AUTH } from "./helpers/app.js";
import { TEST_SECRET, makeRefundApp } from "./helpers/refundWorld.js";
import { REFUND_ADDRESS, USDC_BASE, USDC_NEAR, statusResponseFor } from "./helpers/world.js";

const WNEAR = "nep141:wrap.near";
type Stack = Awaited<ReturnType<typeof makeRefundApp>>;

const settings = async (s: Stack) => (await s.merchant("GET", "/v1/settings")).json();

/** The dashboard's two steps: ask for the message, have the wallet sign it, send the signature back. */
async function changeAccount(
  s: Stack,
  accountId: string,
  options: {
    secret?: string;
    alter?: (payload: Nep413Payload) => Nep413Payload;
    publicKey?: string;
    nonce?: string;
  } = {},
) {
  const asked = await s.merchant("POST", "/v1/settings/account-challenge", { accountId });
  expect(asked.statusCode).toBe(200);
  const challenge = asked.json() as Nep413Payload & { expiresAt: string };
  const payload: Nep413Payload = {
    message: challenge.message,
    nonce: challenge.nonce,
    recipient: challenge.recipient,
    callbackUrl: null,
  };
  const signed = signNep413(options.secret ?? TEST_SECRET, options.alter ? options.alter(payload) : payload);
  return s.merchant("PUT", "/v1/settings/account", {
    accountId,
    nonce: options.nonce ?? challenge.nonce,
    publicKey: options.publicKey ?? signed.public_key,
    signature: signed.signature,
  });
}

describe("GET /v1/settings", () => {
  it("says where each value comes from and lists the latest changes", async () => {
    const s = await makeRefundApp();
    const before = await settings(s);
    expect(before.sources.slippageBps).toEqual({ source: "env", updatedAt: null });
    expect(before.history).toEqual([]);

    await s.merchant("PATCH", "/v1/settings", { slippageBps: 40 });
    const after = await settings(s);
    expect(after.slippageBps).toBe(40);
    expect(after.sources.slippageBps).toMatchObject({ source: "dashboard", updatedAt: expect.any(String) });
    expect(after.history).toEqual([{ setting: "slippageBps", from: "100", to: "40", changedAt: expect.any(String) }]);
  });
});

describe("PATCH /v1/settings", () => {
  it("applies the change at once and reports which settings changed", async () => {
    const s = await makeRefundApp();
    const res = await s.merchant("PATCH", "/v1/settings", {
      attemptDeadlineMinutes: 60,
      refundMaxPerTx: "5",
      refundMaxPerDay: "9",
      webhookUrl: "https://other.example/hook",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed.toSorted()).toEqual([
      "attemptDeadlineMinutes",
      "refundMaxPerDay",
      "refundMaxPerTx",
      "webhookUrl",
    ]);
    expect(await settings(s)).toMatchObject({
      attemptDeadlineMinutes: 60,
      limits: { maxPerTx: "5", maxPerDay: "9" },
      webhookUrl: "https://other.example/hook",
    });
  });

  it("makes the next pay link from a new public URL, and shows it in the settings", async () => {
    const s = await makeRefundApp();
    const first = (await s.merchant("POST", "/v1/invoices", { amount: "1" })).json();
    expect(first.payUrl).toBe(`http://localhost:8080/pay/${first.id}`);

    const res = await s.merchant("PATCH", "/v1/settings", { publicBaseUrl: "https://pay.shop.example/" });
    expect(res.json()).toEqual({ changed: ["publicBaseUrl"] });
    const second = (await s.merchant("POST", "/v1/invoices", { amount: "1" })).json();
    expect(second.payUrl).toBe(`https://pay.shop.example/pay/${second.id}`);
    expect(await settings(s)).toMatchObject({
      publicBaseUrl: "https://pay.shop.example",
      sources: { publicBaseUrl: { source: "dashboard" } },
    });
  });

  it("refuses a public URL that is not an address", async () => {
    const s = await makeRefundApp();
    const res = await s.merchant("PATCH", "/v1/settings", { publicBaseUrl: "not a url" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/^Public URL:/);
  });

  it("enforces a new refund limit on the very next refund", async () => {
    const s = await makeRefundApp();
    const { invoice } = await s.paidInvoice("5.00");
    await s.merchant("PATCH", "/v1/settings", { refundMaxPerTx: "1" });
    const res = await s.merchant("POST", `/v1/invoices/${invoice.id}/refunds`, { idempotencyKey: "k", amount: "2.00" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "refund_limit_exceeded" });
  });

  it("answers a bad value with 400 and the name of the setting, and saves nothing", async () => {
    const s = await makeRefundApp();
    const res = await s.merchant("PATCH", "/v1/settings", { slippageBps: 99_999, refundMaxPerTx: "6" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "invalid_setting" });
    expect(res.json().error.message).toMatch(/^Slippage:/);
    expect((await settings(s)).limits.maxPerTx).toBe("50");
  });

  it("refuses settings that cannot be changed here, such as the merchant secret", async () => {
    const s = await makeRefundApp();
    for (const body of [{ merchantSecret: "x" }, { webhookSecret: "x" }, { settlementAccount: "x.near" }]) {
      expect((await s.merchant("PATCH", "/v1/settings", body)).statusCode).toBe(400);
    }
  });

  it("needs the merchant secret", async () => {
    const s = await makeRefundApp();
    const res = await s.app.inject({ method: "PATCH", url: "/v1/settings", payload: { slippageBps: 1 } });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /v1/settings/:key", () => {
  it("goes back to the .env value", async () => {
    const s = await makeRefundApp();
    await s.merchant("PATCH", "/v1/settings", { slippageBps: 40 });
    const res = await s.merchant("DELETE", "/v1/settings/slippageBps");
    expect(res.json()).toEqual({ changed: ["slippageBps"] });
    expect((await settings(s)).sources.slippageBps.source).toBe("env");
  });

  it("knows only the settings that can be changed", async () => {
    const s = await makeRefundApp();
    expect((await s.merchant("DELETE", "/v1/settings/merchantSecret")).statusCode).toBe(400);
  });

  it("resets the limits together with the asset", async () => {
    const s = await makeRefundApp();
    await s.merchant("PATCH", "/v1/settings", { settlementAssetId: WNEAR, refundMaxPerTx: "1", refundMaxPerDay: "2" });
    const res = await s.merchant("DELETE", "/v1/settings/settlementAsset");
    expect(res.json().changed.toSorted()).toEqual(["refundMaxPerDay", "refundMaxPerTx", "settlementAsset"]);
    expect(await settings(s)).toMatchObject({
      asset: { symbol: "USDC" },
      limits: { maxPerTx: "50", maxPerDay: "200" },
    });
  });
});

describe("changing the settlement account", () => {
  it("is accepted when a full-access key of that account signs the message", async () => {
    const s = await makeRefundApp();
    s.accessKeys.kind = "full";
    const res = await changeAccount(s, "new-shop.near");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: ["settlementAccount"] });
    expect((await settings(s)).account).toBe("new-shop.near");
  });

  it("needs no lookup for an implicit account signed by its own key", async () => {
    const s = await makeRefundApp();
    s.accessKeys.fails = true; // the node would be asked about any other account
    const implicit = implicitAccountOf(TEST_SECRET);
    expect((await changeAccount(s, implicit)).statusCode).toBe(200);
    expect((await settings(s)).account).toBe(implicit);
  });

  it("is refused for a key that does not belong to the account", async () => {
    const s = await makeRefundApp();
    s.accessKeys.kind = "none";
    const res = await changeAccount(s, "someone-else.near");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: "key_not_on_account" });
    expect((await settings(s)).account).toBe("shop-pay.near");
  });

  it("is refused for a key that can only call certain contracts", async () => {
    const s = await makeRefundApp();
    s.accessKeys.kind = "function_call";
    const res = await changeAccount(s, "new-shop.near");
    expect(res.json().error).toMatchObject({ code: "key_not_full_access" });
    expect((await settings(s)).account).toBe("shop-pay.near");
  });

  it("is refused when the signature is over a different message", async () => {
    const s = await makeRefundApp();
    const res = await changeAccount(s, "new-shop.near", {
      alter: (payload) => ({ ...payload, message: "Use evil.near as the Tilll settlement account." }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "invalid_signature" });
  });

  it("is refused when the signature is over a different nonce", async () => {
    const s = await makeRefundApp();
    const res = await changeAccount(s, "new-shop.near", {
      alter: (payload) => ({ ...payload, nonce: randomBytes(32).toString("base64") }),
    });
    expect(res.json().error).toMatchObject({ code: "invalid_signature" });
  });

  it("works once: the same signed message cannot be sent again, and a made-up nonce is not accepted", async () => {
    const s = await makeRefundApp();
    const asked = (await s.merchant("POST", "/v1/settings/account-challenge", { accountId: "new-shop.near" })).json();
    const signed = signNep413(TEST_SECRET, {
      message: asked.message,
      nonce: asked.nonce,
      recipient: asked.recipient,
      callbackUrl: null,
    });
    const body = {
      accountId: "new-shop.near",
      nonce: asked.nonce,
      publicKey: signed.public_key,
      signature: signed.signature,
    };
    expect((await s.merchant("PUT", "/v1/settings/account", body)).statusCode).toBe(200);
    await s.merchant("DELETE", "/v1/settings/settlementAccount");
    const again = await s.merchant("PUT", "/v1/settings/account", body);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: "challenge_expired" });
    const invented = await s.merchant("PUT", "/v1/settings/account", {
      ...body,
      nonce: randomBytes(32).toString("base64"),
    });
    expect(invented.json().error).toMatchObject({ code: "challenge_expired" });
  });

  it("is only for the account that was asked about", async () => {
    const s = await makeRefundApp();
    const asked = (await s.merchant("POST", "/v1/settings/account-challenge", { accountId: "new-shop.near" })).json();
    const signed = signNep413(TEST_SECRET, {
      message: asked.message,
      nonce: asked.nonce,
      recipient: asked.recipient,
      callbackUrl: null,
    });
    const res = await s.merchant("PUT", "/v1/settings/account", {
      accountId: "other-shop.near",
      nonce: asked.nonce,
      publicKey: signed.public_key,
      signature: signed.signature,
    });
    expect(res.json().error).toMatchObject({ code: "challenge_expired" });
  });

  it("is refused for a key that is not ed25519, which Tilll cannot check", async () => {
    const s = await makeRefundApp();
    const res = await changeAccount(s, "new-shop.near", { publicKey: `secp256k1:${base58Encode(randomBytes(64))}` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "unsupported_key_type" });
  });

  it("says so when the NEAR node cannot be asked, and changes nothing", async () => {
    const s = await makeRefundApp();
    s.accessKeys.fails = true;
    const res = await changeAccount(s, "new-shop.near");
    expect(res.statusCode).toBe(503);
    expect((await settings(s)).account).toBe("shop-pay.near");
  });

  it("is refused, after the signature is checked, while a refund is open", async () => {
    const s = await makeRefundApp();
    const { invoice } = await s.paidInvoice();
    await s.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "1.00" });
    const res = await changeAccount(s, "new-shop.near");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "money_in_motion" });
    expect((await settings(s)).account).toBe("shop-pay.near");
  });

  it("refuses an account that is not a NEAR account id", async () => {
    const s = await makeRefundApp();
    const res = await changeAccount(s, "Not An Account!");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "invalid_setting" });
  });

  it("needs the merchant secret for both steps", async () => {
    const s = await makeRefundApp();
    for (const [method, url] of [
      ["POST", "/v1/settings/account-challenge"],
      ["PUT", "/v1/settings/account"],
    ] as const) {
      expect((await s.app.inject({ method, url, payload: {} })).statusCode).toBe(401);
    }
    expect(AUTH.authorization).toBeTruthy();
  });
});

async function switched() {
  const s = await makeRefundApp();
  const { invoice } = await s.paidInvoice("5.00");
  const res = await s.merchant("PATCH", "/v1/settings", {
    settlementAssetId: WNEAR,
    refundMaxPerTx: "1",
    refundMaxPerDay: "2",
  });
  expect(res.statusCode).toBe(200);
  return { s, invoice };
}

describe("invoices made before a change of settlement asset", () => {
  it("still show their own symbol and amount, and say they cannot be refunded here", async () => {
    const { s, invoice } = await switched();
    const detail = (await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json();
    expect(detail.invoice).toMatchObject({
      amount: "5",
      asset: { id: USDC_NEAR, symbol: "USDC", decimals: 6 },
      settlementAccount: "shop-pay.near",
    });
    expect(detail.refundableHere).toBe(false);
    const list = (await s.merchant("GET", "/v1/invoices")).json();
    expect(list.invoices[0].asset.symbol).toBe("USDC");
  });

  it("are not refunded from the new asset's balance: asking, or previewing, says why", async () => {
    const { s, invoice } = await switched();
    for (const url of [`/v1/invoices/${invoice.id}/refunds`, `/v1/invoices/${invoice.id}/refunds/preview`]) {
      const res = await s.merchant("POST", url, { idempotencyKey: "k" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: "settlement_changed" });
      expect(res.json().error.message).toMatch(/shop-pay\.near in USDC/);
    }
    expect(s.client.quote).not.toHaveBeenCalled();
  });

  it("leave new invoices in the new asset, and the refunded-today figure starts again in its units", async () => {
    const s = await makeRefundApp();
    const { invoice } = await s.paidInvoice("5.00");
    const { refund } = await s.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "4.00" });
    await s.approve(refund.id);
    s.refunds.applyRefundStatus(refund.id, s.statusOf(refund.id, "SUCCESS"));
    expect((await s.merchant("GET", "/v1/overview")).json().refundedToday).toMatchObject({ amount: "4" });

    await s.merchant("PATCH", "/v1/settings", { settlementAssetId: WNEAR, refundMaxPerTx: "1", refundMaxPerDay: "2" });
    const overview = (await s.merchant("GET", "/v1/overview")).json();
    expect(overview.asset.symbol).toBe("wNEAR");
    expect(overview.refundedToday).toMatchObject({ amount: "0" });
    expect(overview.limits).toMatchObject({ maxPerTx: "1", maxPerDay: "2" });

    const created = await s.merchant("POST", "/v1/invoices", { amount: "1.5" });
    expect(created.json()).toMatchObject({ amount: "1.5", asset: { symbol: "wNEAR", decimals: 24 } });
  });

  it("record a late payment to the old account without queueing a refund Tilll could not make", async () => {
    const s = await makeRefundApp();
    const invoice = s.service.createInvoice({ amount: "5.00" });
    const first = await s.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    const second = await s.service.createAttempt(invoice.id, {
      originAsset: USDC_BASE,
      refundTo: "0x2222222222222222222222222222222222222222",
    });
    s.service.applyStatus(first.id, statusResponseFor(first.quote, "SUCCESS", { amountOut: invoice.amount }));
    await s.merchant("PATCH", "/v1/settings", { settlementAssetId: WNEAR, refundMaxPerTx: "1", refundMaxPerDay: "2" });

    s.service.applyStatus(second.id, statusResponseFor(second.quote, "SUCCESS", { amountOut: invoice.amount }));

    expect(s.service.getInvoiceDetail(invoice.id).refunds).toEqual([]);
    const types = s.events().map((e) => e.type);
    expect(types).toContain("payment.duplicate");
    expect(types).not.toContain("refund.awaiting_approval");
    const duplicate = s.events().find((e) => e.type === "payment.duplicate")!;
    expect(duplicate.data).toMatchObject({ cause: "invoice_already_paid", refund: null });
    expect(duplicate.data.note).toMatch(/shop-pay\.near in USDC.*cannot refund it/);
  });
});
