import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureShop, loadOrCreateKeystore, setPayerAccount, setShopAccount } from "../scripts/testnet/keystore.js";
import { FaucetLimitedError, TidepoolError, faucet, faucetIntents, getHealth } from "../scripts/testnet/tidepool.js";
import { implicitAccountOf, publicKeyOf } from "../src/near/keys.js";
import { failureOf } from "./helpers/failure.js";
import { fakeFetch } from "./helpers/fakeFetch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "tilll-testnet-"));
  dirs.push(d);
  return d;
};

describe("loadOrCreateKeystore", () => {
  it("creates throwaway keys on first use, as implicit accounts that match their keys", () => {
    const path = join(tmp(), "nested", "keys.json");

    const store = loadOrCreateKeystore(path);

    for (const entry of [store.settlement, store.payer]) {
      expect(entry.secretKey).toMatch(/^ed25519:/);
      expect(entry.publicKey).toBe(publicKeyOf(entry.secretKey));
      expect(entry.accountId).toBe(implicitAccountOf(entry.secretKey));
    }
    expect(store.settlement.secretKey).not.toBe(store.payer.secretKey);
  });

  it("keeps the same keys across runs, so the faucet's once-a-day limit is not burned", () => {
    const path = join(tmp(), "keys.json");
    const first = loadOrCreateKeystore(path);
    const second = loadOrCreateKeystore(path);
    expect(second).toEqual(first);
  });

  it("is readable only by its owner", () => {
    const path = join(tmp(), "keys.json");
    loadOrCreateKeystore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a file it cannot understand instead of overwriting keys that may hold test funds", () => {
    const path = join(tmp(), "keys.json");
    writeFileSync(path, "{ not json");
    expect(() => loadOrCreateKeystore(path)).toThrow(/keys\.json/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("refuses a file whose account does not match its key", () => {
    const path = join(tmp(), "keys.json");
    const good = loadOrCreateKeystore(path);
    writeFileSync(path, JSON.stringify({ ...good, payer: { ...good.payer, accountId: "a".repeat(64) } }));
    expect(() => loadOrCreateKeystore(path)).toThrow(/does not match/);
  });

  it("does not leave a partial file behind when the directory cannot be written", () => {
    const dir = tmp();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(() => loadOrCreateKeystore(join(blocker, "keys.json"))).toThrow(/ENOTDIR|EEXIST/);
    expect(existsSync(join(blocker, "keys.json"))).toBe(false);
  });
});

describe("setPayerAccount", () => {
  it("records the named testnet account created for the payer's key, and keeps it across runs", () => {
    const path = join(tmp(), "keys.json");
    const before = loadOrCreateKeystore(path);
    expect(before.payer.namedAccountId).toBeUndefined();

    setPayerAccount(path, "tilll-test-payer-abc123.testnet");

    const after = loadOrCreateKeystore(path);
    expect(after.payer.namedAccountId).toBe("tilll-test-payer-abc123.testnet");
    expect(after.payer.secretKey).toBe(before.payer.secretKey);
    expect(after.settlement).toEqual(before.settlement);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each(["shopname-pay.near", "UPPER.testnet", "has space.testnet", "", "a".repeat(64)])(
    "refuses %j, which is not a .testnet account",
    (id) => {
      const path = join(tmp(), "keys.json");
      loadOrCreateKeystore(path);
      expect(() => setPayerAccount(path, id)).toThrow(/testnet/);
    },
  );

  it("needs an existing keystore", () => {
    expect(() => setPayerAccount(join(tmp(), "missing.json"), "x.testnet")).toThrow(/keys\.json|exist/i);
  });
});

const BASE = "https://www.usetidepool.tech";

describe("getHealth", () => {
  it("GETs /v0/health and returns the JSON", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { network: "testnet", ok: true } }));
    expect(await getHealth(BASE, fetch)).toEqual({ network: "testnet", ok: true });
    expect([calls[0]!.method, calls[0]!.url]).toEqual(["GET", `${BASE}/v0/health`]);
  });

  it("reports an unreachable service as a TidepoolError, so the harness can say 'service unavailable'", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failureOf(TidepoolError, () => getHealth(BASE, fetch));
    expect(err.message).toContain("fetch failed");
  });
});

describe("faucetIntents", () => {
  it("POSTs the documented intents-mode request and returns what was dripped", async () => {
    const reply = {
      accountId: "x.testnet",
      mode: "intents",
      drips: [{ symbol: "USDC", amount: "100" }],
      transactions: [{ txHash: "H" }],
    };
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: reply }));

    const result = await faucetIntents({ baseUrl: BASE, accountId: "x.testnet", fetch });

    expect(result).toEqual(reply);
    expect([calls[0]!.method, calls[0]!.url]).toEqual(["POST", `${BASE}/v0/faucet`]);
    expect(calls[0]!.body).toEqual({ accountId: "x.testnet", mode: "intents" });
  });

  it("can ask for a subset of assets", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    await faucetIntents({ baseUrl: BASE, accountId: "x.testnet", assets: ["USDT"], fetch });
    expect(calls[0]!.body).toEqual({ accountId: "x.testnet", mode: "intents", assets: ["USDT"] });
  });

  it("faucet() can use wallet mode, which puts the tokens on the account itself (it must already exist)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { mode: "wallet" } }));
    await faucet({ baseUrl: BASE, accountId: "x.testnet", mode: "wallet", assets: ["USDT"], fetch });
    expect(calls[0]!.body).toEqual({ accountId: "x.testnet", mode: "wallet", assets: ["USDT"] });
  });

  it("turns a 429 into FaucetLimitedError carrying how long to wait", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      body: { error: "rate limited", available_at: "2026-11-08T10:00:00Z", retryAfter: 3600, retryAfterSeconds: 3600 },
    }));
    const err = await failureOf(FaucetLimitedError, () =>
      faucetIntents({ baseUrl: BASE, accountId: "x.testnet", fetch }),
    );
    expect(err.retryAfterSeconds).toBe(3600);
    expect(err.message).toMatch(/once|24|limit/i);
  });

  it("turns other failures into TidepoolError with the server's message", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: "unknown asset FOO" } }));
    const err = await failureOf(TidepoolError, () => faucetIntents({ baseUrl: BASE, accountId: "x.testnet", fetch }));
    expect(err.message).toContain("unknown asset FOO");
  });
});

describe("the named shop account (a settlement account whose server key must be registered)", () => {
  it("is created once, as two unrelated keys: one the account owns, one the server signs refunds with", () => {
    const path = join(tmp(), "keys.json");
    loadOrCreateKeystore(path);

    const shop = ensureShop(path);
    const again = ensureShop(path);

    expect(again).toEqual(shop);
    expect(shop.publicKey).toBe(publicKeyOf(shop.secretKey));
    expect(shop.accessKey.publicKey).toBe(publicKeyOf(shop.accessKey.secretKey));
    expect(shop.accessKey.secretKey).not.toBe(shop.secretKey);
    expect(shop.namedAccountId).toBeUndefined();
  });

  it("remembers the account name, and only a .testnet one", () => {
    const path = join(tmp(), "keys.json");
    ensureShop(path);
    setShopAccount(path, "tilll-test-shop-abc123.testnet");
    expect(loadOrCreateKeystore(path).shop?.namedAccountId).toBe("tilll-test-shop-abc123.testnet");
    expect(() => setShopAccount(path, "shop.near")).toThrow(/testnet/);
  });

  it("is kept when another account is recorded in the same file", () => {
    const path = join(tmp(), "keys.json");
    loadOrCreateKeystore(path);
    const shop = ensureShop(path);
    setPayerAccount(path, "tilll-test-payer-abc123.testnet");
    expect(loadOrCreateKeystore(path).shop).toEqual(shop);
  });

  it("is absent from a keystore that never asked for one", () => {
    expect(loadOrCreateKeystore(join(tmp(), "keys.json")).shop).toBeUndefined();
  });

  it("refuses a shop whose keys do not match", () => {
    const path = join(tmp(), "keys.json");
    const shop = ensureShop(path);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.shop = { ...shop, publicKey: loadOrCreateKeystore(join(tmp(), "other.json")).payer.publicKey };
    writeFileSync(path, JSON.stringify(file));
    expect(() => loadOrCreateKeystore(path)).toThrow(/does not match/);
  });
});
