import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { createSettingsStore, createSettingsStoreWith } from "../src/settings/store.js";
import { createTokenCache } from "../src/oneclick/tokens.js";
import { failureOf } from "./helpers/failure.js";
import { makeRefundWorld } from "./helpers/refundWorld.js";
import { SETTINGS_DEFAULTS } from "./helpers/settingsData.js";
import { REFUND_ADDRESS, START, TOKENS, USDC_BASE, USDC_NEAR, makeWorld } from "./helpers/world.js";

const WNEAR = "nep141:wrap.near";

const refusal = (fn: () => Promise<unknown>) => failureOf(ApiError, fn);

describe("the settings store", () => {
  it("starts from .env, and says every value comes from there", () => {
    const { settings } = makeWorld();
    const now = settings.current();
    expect(now).toMatchObject({
      accountId: "shop-pay.near",
      slippageBps: 100,
      attemptDeadlineMinutes: 30,
      webhookUrl: "https://merchant.example/hooks/tilll",
      maxPerTx: 50_000_000n,
      maxPerDay: 200_000_000n,
    });
    expect(now.asset).toMatchObject({ assetId: USDC_NEAR, symbol: "USDC", decimals: 6 });
    expect(Object.values(settings.sources()).every((s) => s.source === "env" && s.updatedAt === null)).toBe(true);
    expect(settings.overridden()).toEqual([]);
  });

  it("saves what the dashboard sends, applies it at once, and says it now comes from the dashboard", async () => {
    const { settings } = makeWorld();
    const changed = await settings.update({
      slippageBps: 50,
      attemptDeadlineMinutes: 45,
      webhookUrl: "https://other.example/hook",
      refundMaxPerTx: "10",
      refundMaxPerDay: "20.5",
    });

    expect(changed.map((c) => c.key).toSorted()).toEqual([
      "attemptDeadlineMinutes",
      "refundMaxPerDay",
      "refundMaxPerTx",
      "slippageBps",
      "webhookUrl",
    ]);
    expect(settings.current()).toMatchObject({
      slippageBps: 50,
      attemptDeadlineMinutes: 45,
      webhookUrl: "https://other.example/hook",
      maxPerTx: 10_000_000n,
      maxPerDay: 20_500_000n,
    });
    expect(settings.values()).toMatchObject({ refundMaxPerTx: "10", refundMaxPerDay: "20.5" });
    expect(settings.sources().slippageBps.source).toBe("dashboard");
    expect(settings.sources().settlementAccount.source).toBe("env"); // not touched
  });

  it.each([
    [{ slippageBps: 20_000 }, /Slippage/],
    [{ slippageBps: 1.5 }, /Slippage/],
    [{ slippageBps: -1 }, /Slippage/],
    [{ attemptDeadlineMinutes: 0 }, /Payment window/],
    [{ attemptDeadlineMinutes: 5000 }, /Payment window/],
    [{ webhookUrl: "ftp://merchant.example/hook" }, /Webhook URL/],
    [{ webhookUrl: "not a url" }, /Webhook URL/],
    [{ refundMaxPerTx: "0" }, /Limit per refund/],
    [{ refundMaxPerTx: "ten" }, /Limit per refund/],
    [{ refundMaxPerDay: "-5" }, /Limit per day/],
    // USDC has 6 decimals.
    [{ refundMaxPerTx: "0.0000001" }, /Limit per refund.*6 decimals/],
  ])("refuses %j, naming the setting", async (patch, message) => {
    const { settings } = makeWorld();
    const error = await refusal(() => settings.update(patch));
    expect(error).toMatchObject({ status: 400, code: "invalid_setting" });
    expect(error.message).toMatch(message);
  });

  it("changes the public URL, drops a trailing slash, and refuses anything that is not an http or https address", async () => {
    const { settings } = makeWorld();
    expect(settings.current().publicBaseUrl).toBe("http://localhost:8080");
    await settings.update({ publicBaseUrl: "https://pay.shop.example//" });
    expect(settings.current().publicBaseUrl).toBe("https://pay.shop.example");
    expect(settings.sources().publicBaseUrl.source).toBe("dashboard");
    for (const bad of ["shop.example", "ftp://shop.example", ""]) {
      const error = await refusal(() => settings.update({ publicBaseUrl: bad }));
      expect(error).toMatchObject({ code: "invalid_setting" });
      expect(error.message).toMatch(/^Public URL: must be an http or https URL/);
    }
    expect(settings.current().publicBaseUrl).toBe("https://pay.shop.example");
  });

  it("leaves a password in the public URL out of the history and the event", async () => {
    const { settings, events } = makeWorld();
    await settings.update({ publicBaseUrl: "https://user:hunter2@shop.example" });
    expect(JSON.stringify([settings.history(), events()])).not.toContain("hunter2");
  });

  it("saves all of a request or none: one bad value leaves the good ones unsaved too", async () => {
    const { settings, db } = makeWorld();
    await refusal(() => settings.update({ slippageBps: 50, webhookUrl: "nope" }));
    expect(settings.current().slippageBps).toBe(100);
    expect(db.prepare("SELECT count(*) AS n FROM settings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM settings_history").get()).toEqual({ n: 0 });
  });

  it("changes nothing, and tells no one, when the value is already in force", async () => {
    const { settings, events } = makeWorld();
    expect(await settings.update({ slippageBps: 100, webhookUrl: "https://merchant.example/hooks/tilll" })).toEqual([]);
    expect(settings.overridden()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it("keeps dashboard values across a restart, and lists the ones that override .env", async () => {
    const { settings, db } = makeWorld();
    await settings.update({ slippageBps: 25, refundMaxPerTx: "7" });

    const restarted = await createSettingsStore({
      db,
      defaults: SETTINGS_DEFAULTS, // .env still says 100 and 50
      tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    });
    expect(restarted.current()).toMatchObject({ slippageBps: 25, maxPerTx: 7_000_000n });
    expect(restarted.overridden().toSorted()).toEqual(["refundMaxPerTx", "slippageBps"]);
  });

  it("goes back to the .env value when reset", async () => {
    const { settings } = makeWorld();
    await settings.update({ slippageBps: 25 });
    const changed = await settings.reset("slippageBps");
    expect(changed).toEqual([{ key: "slippageBps", from: "25", to: "100" }]);
    expect(settings.current().slippageBps).toBe(100);
    expect(settings.sources().slippageBps.source).toBe("env");
  });

  it("writes each change to a history and sends settings.updated, with no password from a webhook URL in either", async () => {
    const { settings, events } = makeWorld();
    await settings.update({ webhookUrl: "https://user:hunter2@other.example/hook?x=1", slippageBps: 30 });

    const history = settings.history();
    expect(history.map((h) => [h.key, h.from, h.to]).toSorted()).toEqual([
      ["slippageBps", "100", "30"],
      ["webhookUrl", "https://merchant.example/hooks/tilll", "https://other.example/hook?x=1"],
    ]);
    const [event] = events();
    expect(event).toMatchObject({ type: "settings.updated" });
    expect(event!.data.changes).toHaveLength(2);
    expect(JSON.stringify([history, event])).not.toContain("hunter2");
    // The real address still receives events.
    expect(settings.current().webhookUrl).toBe("https://user:hunter2@other.example/hook?x=1");
  });

  it("changes the settlement account to a valid NEAR account, and refuses one that is not", async () => {
    const { settings } = makeWorld();
    expect(await refusal(() => settings.changeAccount("Not An Account!"))).toMatchObject({ code: "invalid_setting" });
    expect(await settings.changeAccount("new-shop.near")).toEqual([
      { key: "settlementAccount", from: "shop-pay.near", to: "new-shop.near" },
    ]);
    expect(settings.current().accountId).toBe("new-shop.near");
    expect(await settings.changeAccount("new-shop.near")).toEqual([]);
  });
});

describe("changing the settlement asset", () => {
  it("needs both refund limits in the same save, because the old ones are in the old asset's units", async () => {
    const { settings } = makeWorld();
    for (const patch of [{}, { refundMaxPerTx: "1" }, { refundMaxPerDay: "1" }]) {
      const error = await refusal(() => settings.update({ settlementAssetId: WNEAR, ...patch }));
      expect(error).toMatchObject({ code: "invalid_setting" });
      expect(error.message).toMatch(/limits/);
    }
    expect(settings.current().asset.assetId).toBe(USDC_NEAR);
  });

  it("refuses an asset 1Click does not list, and one that is not an asset id", async () => {
    const { settings } = makeWorld();
    const limits = { refundMaxPerTx: "1", refundMaxPerDay: "2" };
    expect(await refusal(() => settings.update({ settlementAssetId: "nep141:nothing.near", ...limits }))).toMatchObject(
      {
        code: "invalid_setting",
      },
    );
    expect(await refusal(() => settings.update({ settlementAssetId: "banana", ...limits }))).toMatchObject({
      code: "invalid_setting",
    });
    expect(settings.current().asset.assetId).toBe(USDC_NEAR);
  });

  it("moves to the new asset with limits in its units, and still knows the old asset's symbol and decimals", async () => {
    const { settings } = makeWorld();
    await settings.update({ settlementAssetId: WNEAR, refundMaxPerTx: "1.5", refundMaxPerDay: "3" });

    const now = settings.current();
    expect(now.asset).toMatchObject({ assetId: WNEAR, symbol: "wNEAR", decimals: 24 });
    expect(now.maxPerTx).toBe(1_500_000_000_000_000_000_000_000n);
    expect(settings.tokenFor(USDC_NEAR)).toMatchObject({ symbol: "USDC", decimals: 6 });
    expect(settings.tokenFor(WNEAR)).toMatchObject({ symbol: "wNEAR", decimals: 24 });
  });

  it("has no symbol for an asset that was never in use, rather than a guess", () => {
    expect(() => makeWorld().settings.tokenFor("nep141:never.near")).toThrow(/never in use/);
  });

  it("resetting the asset resets the limits with it, which are in its units", async () => {
    const { settings } = makeWorld();
    await settings.update({ settlementAssetId: WNEAR, refundMaxPerTx: "1.5", refundMaxPerDay: "3" });
    await settings.reset("settlementAsset");
    expect(settings.current().asset.assetId).toBe(USDC_NEAR);
    expect(settings.current()).toMatchObject({ maxPerTx: 50_000_000n, maxPerDay: 200_000_000n });
    expect(settings.overridden()).toEqual([]);
  });

  it("survives a restart on the new asset even though .env still names the old one", async () => {
    const { settings, db } = makeWorld();
    await settings.update({ settlementAssetId: WNEAR, refundMaxPerTx: "1.5", refundMaxPerDay: "3" });
    const restarted = await createSettingsStore({
      db,
      defaults: SETTINGS_DEFAULTS,
      tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    });
    expect(restarted.current().asset).toMatchObject({ assetId: WNEAR, decimals: 24 });
  });

  it("is a startup error, not a crash later, when the saved asset is no longer listed", async () => {
    const { settings, db } = makeWorld();
    await settings.update({ settlementAssetId: WNEAR, refundMaxPerTx: "1.5", refundMaxPerDay: "3" });
    const error = await refusal(() =>
      createSettingsStore({
        db,
        defaults: SETTINGS_DEFAULTS,
        tokens: createTokenCache({ client: { tokens: async () => TOKENS.filter((t) => t.assetId !== WNEAR) } }),
      }),
    );
    expect(error).toMatchObject({ code: "invalid_setting" });
  });
});

describe("moving money to another account or asset while payments are open", () => {
  it("is refused while a refund is open, and says how many", async () => {
    const w = makeRefundWorld();
    const { invoice } = await w.paidInvoice();
    await w.refunds.refund(invoice.id, { idempotencyKey: "k", amount: "1.00" });

    const forAccount = await refusal(() => w.settings.changeAccount("new-shop.near"));
    expect(forAccount).toMatchObject({ status: 409, code: "money_in_motion" });
    expect(forAccount.message).toMatch(/1 refund still open/);
    const forAsset = await refusal(() =>
      w.settings.update({ settlementAssetId: WNEAR, refundMaxPerTx: "1", refundMaxPerDay: "2" }),
    );
    expect(forAsset.code).toBe("money_in_motion");
    expect(w.settings.current()).toMatchObject({ accountId: "shop-pay.near" });
  });

  it("is refused while an open invoice has a payment under way, and allowed once it is paid", async () => {
    const w = makeWorld();
    const invoice = w.service.createInvoice({ amount: "5.00" });
    const attempt = await w.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });

    const error = await refusal(() => w.settings.changeAccount("new-shop.near"));
    expect(error.message).toMatch(/1 open invoice has a payment under way/);

    w.service.applyStatus(attempt.id, {
      correlationId: "c",
      quoteResponse: attempt.quote,
      status: "SUCCESS",
      updatedAt: START.toISOString(),
      swapDetails: {},
    });
    expect(await w.settings.changeAccount("new-shop.near")).toHaveLength(1);
  });

  it("does not stop an invoice nobody has tried to pay, nor changes that move no money", async () => {
    const w = makeWorld();
    w.service.createInvoice({ amount: "5.00" });
    expect(await w.settings.update({ slippageBps: 10, webhookUrl: "https://other.example/hook" })).toHaveLength(2);
  });
});

describe("what a change applies to", () => {
  it("is read for every operation: a new slippage and payment window are in the next quote", async () => {
    const w = makeWorld();
    const first = w.service.createInvoice({ amount: "5.00" });
    await w.service.createAttempt(first.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    await w.settings.update({ slippageBps: 25, attemptDeadlineMinutes: 45 });
    const second = w.service.createInvoice({ amount: "5.00" });
    await w.service.createAttempt(second.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });

    const [early, late] = w.client.quote.mock.calls.map(([request]) => request);
    expect(early).toMatchObject({ slippageTolerance: 100 });
    expect(Date.parse(early!.deadline) - START.getTime()).toBe(30 * 60_000);
    expect(late).toMatchObject({ slippageTolerance: 25 });
    expect(Date.parse(late!.deadline) - START.getTime()).toBe(45 * 60_000);
  });

  it("prices new invoices in the new asset and pays them to the new account, and leaves earlier invoices as they were", async () => {
    const w = makeWorld();
    const before = w.service.createInvoice({ amount: "5.00" });
    await w.settings.update({ settlementAssetId: WNEAR, refundMaxPerTx: "1", refundMaxPerDay: "2" });
    await w.settings.changeAccount("new-shop.near");
    const after = w.service.createInvoice({ amount: "1.5" });

    expect(before).toMatchObject({ assetId: USDC_NEAR, settlementAccount: "shop-pay.near", amount: "5000000" });
    expect(after).toMatchObject({
      assetId: WNEAR,
      settlementAccount: "new-shop.near",
      amount: "1500000000000000000000000",
    });

    // An invoice made before the change is still paid where it said it would be.
    await w.service.createAttempt(before.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    expect(w.client.quote.mock.calls.at(-1)![0]).toMatchObject({
      recipient: "shop-pay.near",
      destinationAsset: USDC_NEAR,
      amount: "5000000",
    });
  });

  it("accepts an asset change through a store made with the asset it already knows", async () => {
    const w = makeWorld();
    const store = createSettingsStoreWith(
      {
        db: w.db,
        defaults: SETTINGS_DEFAULTS,
        tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
      },
      w.settings.current().asset,
    );
    expect(store.current().asset.assetId).toBe(USDC_NEAR);
  });
});
