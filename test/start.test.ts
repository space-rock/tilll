import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiverServer, type ReceivedEvent } from "../demo-store/webhook-receiver.js";
import { ConfigError } from "../src/config.js";
import { publicKeyOf } from "../src/near/keys.js";
import { verifyNep413 } from "../src/near/nep413.js";
import { OneClickError } from "../src/oneclick/client.js";
import { SettlementAssetError } from "../src/oneclick/tokens.js";
import { startTilll, startupErrorMessage } from "../src/start.js";
import { startFakeOneClick, type FakeOneClick } from "./helpers/fakeOneClick.js";
import { startFakeNear as startNear } from "./helpers/fakeNear.js";
import { PNG, fakeExplorer } from "./helpers/fakeExplorer.js";
import { TEST_SECRET } from "./helpers/refundWorld.js";

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.toReversed()) await fn();
  cleanup = [];
});

async function startFakeNear(value: string) {
  const near = await startNear(value);
  cleanup.push(() => near.close());
  return near;
}

async function setup(
  overrides: Record<string, string> = {},
  fakeOptions: Parameters<typeof startFakeOneClick>[0] = {},
) {
  const fake: FakeOneClick = await startFakeOneClick(fakeOptions);
  const dataDir = mkdtempSync(join(tmpdir(), "tilll-data-"));
  cleanup.push(
    () => fake.close(),
    () => rmSync(dataDir, { recursive: true, force: true }),
  );
  const env = {
    ONECLICK_BASE_URL: fake.url,
    DATA_DIR: join(dataDir, "nested", "data"),
    SETTLEMENT_ACCOUNT_ID: "shop-pay.near",
    SETTLEMENT_PRIVATE_KEY: "ed25519:5Hd9wTxDq2",
    SETTLEMENT_ASSET_ID: USDC_NEAR,
    MERCHANT_SECRET: "sk_test_secret",
    WEBHOOK_URL: "http://localhost:9000/hooks/tilll",
    WEBHOOK_SECRET: "whsec_test",
    ...overrides,
  };
  return { fake, env, dbPath: join(env.DATA_DIR, "tilll.db") };
}

/** A dashboard login as a reverse proxy would forward it for the visitor at `forwardedFor`. */
const loginVia = (url: string, forwardedFor: string, secret: string) =>
  fetch(`${url}/dashboard/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ secret }),
  });

/** Ten wrong logins from one visitor: all of their tries for the minute. */
const useUpTries = async (url: string) => {
  for (let i = 0; i < 10; i++) await loginVia(url, "203.0.113.1", "wrong");
};

describe("startTilll", () => {
  it("starts a server that serves the API over real HTTP and creates the data directory and database", async () => {
    const { env, dbPath } = await setup();

    const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
    cleanup.push(() => tilll.stop());

    expect(existsSync(dbPath)).toBe(true);
    const unauth = await fetch(`${tilll.url}/v1/invoices`);
    expect(unauth.status).toBe(401);

    const created = await fetch(`${tilll.url}/v1/invoices`, {
      method: "POST",
      headers: { authorization: "Bearer sk_test_secret", "content-type": "application/json" },
      body: JSON.stringify({ amount: "5.00" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ status: "open", amount: "5" });

    const tokens = await fetch(`${tilll.url}/pay/tokens`);
    expect(tokens.status).toBe(200);
  });

  it("serves token images from the folder shipped with it first, so a payer and the server need nothing from outside", async () => {
    const { env } = await setup();
    const bundled = mkdtempSync(join(tmpdir(), "tilll-bundled-"));
    cleanup.push(() => rmSync(bundled, { recursive: true, force: true }));
    mkdirSync(join(bundled, "token"));
    writeFileSync(join(bundled, "token", "usdc.png"), PNG);
    const explorer = fakeExplorer();
    const tilll = await startTilll(env, {
      port: 0,
      host: "127.0.0.1",
      iconFetch: explorer.fetcher,
      bundledIconsDir: bundled,
    });
    cleanup.push(() => tilll.stop());

    const list = (await (await fetch(`${tilll.url}/pay/tokens`)).json()) as { chainIcons: string[] };
    expect(list.chainIcons).toContain("base");
    const image = await fetch(`${tilll.url}/pay/icons/token/usdc`);
    expect([image.status, image.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(explorer.fetcher).not.toHaveBeenCalled();
  });

  it("fetches an image the folder lacks once, keeps it in its data folder, and serves it from its own address", async () => {
    const { env } = await setup();
    const empty = mkdtempSync(join(tmpdir(), "tilll-bundled-"));
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }));
    const explorer = fakeExplorer();
    const tilll = await startTilll(env, {
      port: 0,
      host: "127.0.0.1",
      iconFetch: explorer.fetcher,
      bundledIconsDir: empty,
    });
    cleanup.push(() => tilll.stop());

    const image = await fetch(`${tilll.url}/pay/icons/token/usdc`);
    expect([image.status, image.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect(explorer.fetcher).toHaveBeenCalled();
    expect(existsSync(join(env.DATA_DIR, "icons", "token", "usdc.png"))).toBe(true);
  });

  it("looks for images it lacks in the background only when asked to, and never otherwise", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tilll-bundled-"));
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }));

    const quiet = await setup();
    const quietExplorer = fakeExplorer();
    const idle = await startTilll(quiet.env, {
      port: 0,
      host: "127.0.0.1",
      iconFetch: quietExplorer.fetcher,
      bundledIconsDir: empty,
    });
    cleanup.push(() => idle.stop());
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(quietExplorer.fetcher).not.toHaveBeenCalled();

    const busy = await setup();
    const explorer = fakeExplorer();
    const tilll = await startTilll(busy.env, {
      port: 0,
      host: "127.0.0.1",
      iconFetch: explorer.fetcher,
      bundledIconsDir: empty,
      syncIcons: true,
    });
    cleanup.push(() => tilll.stop());
    await vi.waitFor(() => expect(existsSync(join(busy.env.DATA_DIR, "icons", "chain", "base.svg"))).toBe(true), {
      timeout: 5000,
    });
    expect(explorer.fetcher).toHaveBeenCalled();
  });

  it("is wired to WEBHOOK_URL and WEBHOOK_SECRET: a test ping reaches the merchant's endpoint, signed and verified", async () => {
    const received: ReceivedEvent[] = [];
    const receiver = createReceiverServer({ secret: "whsec_start_test", onEvent: (e) => void received.push(e) });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((done) => (receiver.closeAllConnections(), receiver.close(() => done()))));
    const hookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hooks/tilll`;

    const { env } = await setup({ WEBHOOK_URL: hookUrl, WEBHOOK_SECRET: "whsec_start_test" });
    const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
    cleanup.push(() => tilll.stop());

    const res = await fetch(`${tilll.url}/v1/webhooks/test`, {
      method: "POST",
      headers: { authorization: "Bearer sk_test_secret", "content-type": "application/json" },
      body: "{}",
    });

    expect(await res.json()).toMatchObject({ delivered: true, status: 200, error: null });
    expect(received.map((e) => e.type)).toEqual(["ping"]);
  });

  it("keeps invoices across a restart, because the database is a file", async () => {
    const { env } = await setup();
    const first = await startTilll(env, { port: 0, host: "127.0.0.1" });
    const { id } = (await (
      await fetch(`${first.url}/v1/invoices`, {
        method: "POST",
        headers: { authorization: "Bearer sk_test_secret", "content-type": "application/json" },
        body: JSON.stringify({ amount: "2" }),
      })
    ).json()) as { id: string };
    await first.stop();

    const second = await startTilll(env, { port: 0, host: "127.0.0.1" });
    cleanup.push(() => second.stop());
    const res = await fetch(`${second.url}/pay/invoices/${id}`);
    expect(res.status).toBe(200);
  });

  it("stops listening when stopped", async () => {
    const { env } = await setup();
    const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
    await tilll.stop();
    await expect(fetch(`${tilll.url}/pay/tokens`)).rejects.toThrow(/fetch failed/);
  });

  it("fails fast on a settlement asset 1Click does not list, before touching the disk or the network port", async () => {
    const { env, dbPath } = await setup({ SETTLEMENT_ASSET_ID: "nep141:usdc.typo.near" });
    const err = await startTilll(env, { port: 0, host: "127.0.0.1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementAssetError);
    expect((err as Error).message).toContain(USDC_NEAR);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("fails with every bad variable named when the configuration is invalid, without contacting 1Click", async () => {
    const { env, fake } = await setup({ MERCHANT_SECRET: "", SETTLEMENT_PRIVATE_KEY: "not-a-key" });
    const err = await startTilll(env, { port: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => i.variable).toSorted()).toEqual([
      "MERCHANT_SECRET",
      "SETTLEMENT_PRIVATE_KEY",
    ]);
    expect(fake.requests).toEqual([]);
  });

  it("fails with a clear error when 1Click cannot be reached at startup", async () => {
    const { env, fake } = await setup();
    fake.failNext("/v0/tokens", 503, { message: "maintenance" });
    const err = await startTilll(env, { port: 0, host: "127.0.0.1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneClickError);
  });

  it("fails clearly when the port is already taken", async () => {
    const { env } = await setup();
    const first = await startTilll(env, { port: 0, host: "127.0.0.1" });
    cleanup.push(() => first.stop());
    const port = Number(new URL(first.url).port);
    await expect(startTilll(env, { port, host: "127.0.0.1" })).rejects.toThrow(/EADDRINUSE/);
  });
  it("reads the settlement balance from the verifier named by INTENTS_CONTRACT, over NEAR_RPC_URL", async () => {
    const near = await startFakeNear("7000000");
    const { env } = await setup({ NEAR_RPC_URL: near.url, INTENTS_CONTRACT: "verifier.example.testnet" });
    const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
    cleanup.push(() => tilll.stop());

    const res = await fetch(`${tilll.url}/v1/balance`, { headers: { authorization: "Bearer sk_test_secret" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: "shop-pay.near", balance: "7", balanceBase: "7000000" });
    expect(near.asked).toEqual([
      {
        account_id: "verifier.example.testnet",
        method_name: "mt_balance_of",
        args: { account_id: "shop-pay.near", token_id: USDC_NEAR },
      },
    ]);
  });

  it("refuses a refund limit with more decimals than the settlement asset, before anything is created", async () => {
    const { env, dbPath } = await setup({ REFUND_MAX_PER_TX: "0.0000001" });
    const error = await startTilll(env, { port: 0, host: "127.0.0.1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toMatchObject([{ variable: "REFUND_MAX_PER_TX" }]);
    expect(existsSync(dbPath)).toBe(false);
  });
  it("refunds a paid invoice with the settlement key from SETTLEMENT_PRIVATE_KEY", async () => {
    const near = await startFakeNear("100000000");
    const { env, fake, dbPath } = await setup({ NEAR_RPC_URL: near.url, SETTLEMENT_PRIVATE_KEY: TEST_SECRET });
    const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
    cleanup.push(() => tilll.stop());
    // A paid invoice, written straight into the database: paying one for real would wait on the watcher's timer.
    const side = new Database(dbPath);
    const at = new Date().toISOString();
    side
      .prepare(
        `INSERT INTO invoices (id, amount, asset_id, status, paid_attempt_id, expires_at, created_at, updated_at)
         VALUES ('inv_paid', '5000000', ?, 'paid', 'att_paid', ?, ?, ?)`,
      )
      .run(USDC_NEAR, at, at, at);
    side
      .prepare(
        `INSERT INTO attempts (id, invoice_id, origin_asset, origin_chain, origin_symbol, origin_decimals, refund_to,
           deposit_address, amount_in, min_amount_in, deadline, quote_json, oneclick_status, status, created_at, updated_at)
         VALUES ('att_paid', 'inv_paid', ?, 'base', 'USDC', 6, ?, '0xPAID', '5051500', '5001000', ?, '{}', 'SUCCESS', 'paid', ?, ?)`,
      )
      .run(
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        "0x1111111111111111111111111111111111111111",
        at,
        at,
        at,
      );
    side.close();

    const response = await fetch(`${tilll.url}/v1/invoices/inv_paid/refunds`, {
      method: "POST",
      headers: { authorization: "Bearer sk_test_secret", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "k", amount: "2.00" }),
    });

    expect(response.status).toBe(201);
    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]!.public_key).toBe(publicKeyOf(TEST_SECRET));
    expect(verifyNep413(fake.submitted[0]!)).toBe(true);
  });
  describe("TRUST_PROXY", () => {
    it("with TRUST_PROXY=1, tells visitors behind the proxy apart: one cannot lock another out of the dashboard", async () => {
      const { env } = await setup({ TRUST_PROXY: "1" });
      const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
      cleanup.push(() => tilll.stop());

      await useUpTries(tilll.url);
      expect((await loginVia(tilll.url, "203.0.113.1", "wrong")).status).toBe(429);
      expect((await loginVia(tilll.url, "198.51.100.9", "sk_test_secret")).status).toBe(200);
    });

    it("by default, treats every request as coming from the one address it arrived from", async () => {
      const { env } = await setup();
      const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
      cleanup.push(() => tilll.stop());

      await useUpTries(tilll.url);
      expect((await loginVia(tilll.url, "198.51.100.9", "sk_test_secret")).status).toBe(429);
    });

    it("refuses a TRUST_PROXY it cannot read, before anything starts", async () => {
      const { env, dbPath } = await setup({ TRUST_PROXY: "sometimes" });
      const error = await startTilll(env, { port: 0, host: "127.0.0.1" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toMatchObject([{ variable: "TRUST_PROXY" }]);
      expect(existsSync(dbPath)).toBe(false);
    });
  });
});

describe("startupErrorMessage", () => {
  it("returns the message for errors a user can fix, and undefined for bugs", () => {
    expect(startupErrorMessage(new ConfigError([{ variable: "PORT", message: "bad" }]))).toContain("PORT");
    expect(startupErrorMessage(new SettlementAssetError("nope"))).toBe("nope");
    expect(startupErrorMessage(new OneClickError(0, "1Click GET /v0/tokens failed: fetch failed"))).toContain(
      "fetch failed",
    );
    expect(
      startupErrorMessage(
        Object.assign(new Error("listen EADDRINUSE: address already in use 0.0.0.0:8080"), { code: "EADDRINUSE" }),
      ),
    ).toContain("EADDRINUSE");
    expect(startupErrorMessage(new TypeError("a bug"))).toBeUndefined();
    expect(startupErrorMessage("string")).toBeUndefined();
  });
});
