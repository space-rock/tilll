import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitCode, formatChecks, runChecks, type CheckResult } from "../src/check.js";
import quoteFixture from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "./fixtures/tokens.json" with { type: "json" };
import { fakeFetch, type RecordedCall } from "./helpers/fakeFetch.js";

const ONECLICK = "https://1click.test";
const RPC = "https://rpc.test";
const HOOK = "https://merchant.test/hooks/tilll";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  /** What intents.near says: the balance. */
  balance?: string;
  rpcDown?: boolean;
  oneClickDown?: boolean;
  quoteStatus?: number;
  webhookStatus?: number;
}

function setup(world: World = {}, envOverrides: Record<string, string | undefined> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "tilll-check-"));
  dirs.push(dataDir);
  const env = {
    ONECLICK_BASE_URL: ONECLICK,
    NEAR_RPC_URL: RPC,
    DATA_DIR: join(dataDir, "data"),
    SETTLEMENT_ACCOUNT_ID: "shop-pay.near",
    SETTLEMENT_ASSET_ID: USDC_NEAR,
    MERCHANT_SECRET: "sk_test_secret",
    WEBHOOK_URL: HOOK,
    WEBHOOK_SECRET: "whsec_test",
    ...envOverrides,
  };

  const { fetch, calls } = fakeFetch((call: RecordedCall) => {
    const url = new URL(call.url);
    if (call.url.startsWith(ONECLICK)) {
      if (world.oneClickDown) throw new TypeError("fetch failed");
      if (url.pathname === "/v0/tokens") return { body: tokensFixture };
      if (url.pathname === "/v0/quote") {
        return world.quoteStatus && world.quoteStatus !== 201
          ? { status: world.quoteStatus, body: { message: "Unauthorized" } }
          : { status: 201, body: quoteFixture };
      }
    }
    if (call.url.startsWith(RPC)) {
      if (world.rpcDown) throw new TypeError("fetch failed");
      const method = (call.body as { params: { method_name: string } }).params.method_name;
      const answer = method === "mt_balance_of" ? (world.balance ?? "0") : false;
      return { body: { result: { result: [...Buffer.from(JSON.stringify(answer))] } } };
    }
    if (call.url === HOOK) return { status: world.webhookStatus ?? 200, body: { received: true } };
    return { status: 404, body: { message: `unexpected ${call.method} ${call.url}` } };
  });

  const run = (options: { webhook?: boolean } = {}) => runChecks({ env, fetch, ...options });
  return { run, calls, env, dataDir };
}

const byName = (results: CheckResult[], name: string) => {
  const found = results.find((r) => r.name === name);
  if (!found) throw new Error(`no check named ${name}; have ${results.map((r) => r.name).join(", ")}`);
  return found;
};

describe("a healthy setup", () => {
  it("passes every check that matters, warning only about what is optional or not needed yet", async () => {
    const { run } = setup({ balance: "5000000" });

    const results = await run();

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["config", "pass"],
      ["1Click", "pass"],
      ["settlement asset", "pass"],
      ["API key", "warn"],
      ["NEAR RPC", "pass"],
      ["settlement account", "pass"],
      ["webhook", "pass"],
      ["data directory", "pass"],
    ]);
    expect(exitCode(results)).toBe(0);
  });

  it("reports what it found: token count, the settlement token, the Intents balance and the account", async () => {
    const { run } = setup({ balance: "5250000" });
    const results = await run();

    expect(byName(results, "1Click").detail).toMatch(/215 tokens/);
    expect(byName(results, "settlement asset").detail).toMatch(/USDC on near/);
    expect(byName(results, "NEAR RPC").detail).toMatch(/5\.25 USDC/);
    expect(byName(results, "settlement account").detail).toContain("shop-pay.near");
  });
});

describe("configuration", () => {
  it("names every bad setting, checks nothing else, and fails", async () => {
    const { run, calls } = setup({}, { MERCHANT_SECRET: "", SETTLEMENT_ASSET_ID: "nonsense" });

    const results = await run();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "config", status: "fail" });
    expect(results[0]!.detail).toContain("MERCHANT_SECRET");
    expect(results[0]!.detail).toContain("SETTLEMENT_ASSET_ID");
    expect(calls).toEqual([]);
    expect(exitCode(results)).toBe(1);
  });
});

describe("1Click", () => {
  it("fails when 1Click cannot be reached and skips what depends on it", async () => {
    const { run } = setup({ oneClickDown: true });
    const results = await run();
    expect(byName(results, "1Click")).toMatchObject({ status: "fail" });
    expect(byName(results, "settlement asset").status).toBe("warn");
    expect(byName(results, "settlement asset").detail).toMatch(/skipped/i);
    expect(exitCode(results)).toBe(1);
  });

  it("fails with a pointer to USDC on NEAR when the settlement asset is not listed", async () => {
    const { run } = setup({}, { SETTLEMENT_ASSET_ID: "nep141:usdc.typo.near" });
    const result = byName(await run(), "settlement asset");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain(USDC_NEAR);
  });
});

describe("API key", () => {
  it("warns when there is none, because quotes may then carry an extra platform fee", async () => {
    const result = byName(await setup().run(), "API key");
    expect(result.status).toBe("warn");
    expect(result.detail).toMatch(/not set/i);
  });

  it("passes when 1Click accepts a dry quote made with the key", async () => {
    const { run, calls } = setup({}, { ONECLICK_API_KEY: "partner.jwt.value" });
    expect(byName(await run(), "API key")).toMatchObject({ status: "pass" });
    expect(
      calls.filter((c) => c.url.startsWith(ONECLICK)).every((c) => c.headers.get("x-api-key") === "partner.jwt.value"),
    ).toBe(true);
  });

  it("fails when 1Click rejects the key", async () => {
    const { run } = setup({ quoteStatus: 401 }, { ONECLICK_API_KEY: "partner.jwt.value" });
    const results = await run();
    expect(byName(results, "API key")).toMatchObject({ status: "fail" });
    expect(byName(results, "API key").detail).toMatch(/rejected/i);
  });

  it.each([
    ["when 1Click rejects it", { quoteStatus: 401 }],
    ["when 1Click accepts it", {}],
  ])("never prints the key, %s", async (_name, world) => {
    const { run } = setup(world, { ONECLICK_API_KEY: "partner.jwt.value" });
    expect(formatChecks(await run({ webhook: true }))).not.toContain("partner.jwt.value");
  });
});

describe("NEAR RPC and the Intents balance", () => {
  it("fails with a hint to try another public RPC when it cannot be reached", async () => {
    const result = byName(await setup({ rpcDown: true }).run(), "NEAR RPC");
    expect(result.status).toBe("fail");
    expect(result.hint).toMatch(/NEAR_RPC_URL/);
  });
});

describe("settlement account", () => {
  it("says Tilll holds no key, and that refunds are approved with a wallet in the dashboard", async () => {
    const result = byName(await setup().run(), "settlement account");
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("shop-pay.near");
    expect(result.detail).toMatch(/no key/i);
    expect(result.detail).toMatch(/wallet/i);
  });

  it("never asks the contract about a key, because there is none to ask about", async () => {
    const { run, calls } = setup();
    await run();
    const methods = calls
      .filter((c) => c.url.startsWith(RPC))
      .map((c) => (c.body as { params: { method_name: string } }).params.method_name);
    expect(methods).not.toContain("has_public_key");
  });

  it("does not mention a private key anywhere in its output", async () => {
    const text = formatChecks(await setup().run());
    expect(text).not.toMatch(/private key|SETTLEMENT_PRIVATE_KEY/i);
  });
});

const accountsCalled = (calls: RecordedCall[]) =>
  calls
    .filter((c) => c.url.startsWith(RPC))
    .map((c) => (c.body as { params: { account_id: string } }).params.account_id);

describe("a testnet verifier", () => {
  const VERIFIER = "verifier.tidepool-sandbox.testnet";

  it("asks the configured verifier for the balance, and says so", async () => {
    const { run, calls } = setup({ balance: "100000000" }, { INTENTS_CONTRACT: VERIFIER });
    const results = await run();

    expect(new Set(accountsCalled(calls))).toEqual(new Set([VERIFIER]));
    expect(byName(results, "NEAR RPC").detail).toContain(VERIFIER);
  });
});

describe("webhook", () => {
  it("does not contact the endpoint unless asked", async () => {
    const { run, calls } = setup();
    expect(byName(await run(), "webhook").detail).toMatch(/--webhook/);
    expect(calls.some((c) => c.url === HOOK)).toBe(false);
  });

  it("sends a signed test ping with --webhook and passes when the endpoint accepts it", async () => {
    const { run, calls } = setup();
    expect(byName(await run({ webhook: true }), "webhook")).toMatchObject({ status: "pass" });
    const ping = calls.find((c) => c.url === HOOK)!;
    expect(ping.headers.get("tilll-signature")).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(ping.rawBody!)).toMatchObject({ type: "ping" });
  });

  it("fails with the HTTP status when the endpoint refuses the ping", async () => {
    const result = byName(await setup({ webhookStatus: 500 }).run({ webhook: true }), "webhook");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("HTTP 500");
  });
});

describe("data directory", () => {
  it("fails when it cannot be written to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tilll-check-file-"));
    dirs.push(dir);
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const results = await setup({}, { DATA_DIR: join(blocker, "data") }).run();
    expect(byName(results, "data directory").status).toBe("fail");
  });

  it("leaves nothing behind when it passes", async () => {
    const { run, dataDir } = setup();
    await run();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(dataDir, "data"))).toEqual([]);
  });
});

describe("everything it does outside this machine is read-only (hard rule)", () => {
  it("only reads token lists, asks for dry quotes, and makes NEAR view calls", async () => {
    const { run, calls } = setup({ balance: "1" }, { ONECLICK_API_KEY: "partner.jwt.value" });

    await run({ webhook: true });

    const oneClick = calls.filter((c) => c.url.startsWith(ONECLICK));
    expect(oneClick.map((c) => `${c.method} ${new URL(c.url).pathname}`).toSorted()).toEqual([
      "GET /v0/tokens",
      "POST /v0/quote",
    ]);
    for (const quote of oneClick.filter((c) => c.method === "POST")) expect(quote.body).toMatchObject({ dry: true });

    for (const rpc of calls.filter((c) => c.url.startsWith(RPC))) {
      expect(rpc.body).toMatchObject({ method: "query", params: { request_type: "call_function" } });
    }
    expect(calls.map((c) => new URL(c.url).pathname)).not.toEqual(
      expect.arrayContaining(["/v0/generate-intent", "/v0/submit-intent", "/v0/deposit/submit"]),
    );
  });
});

describe("formatChecks", () => {
  const sample: CheckResult[] = [
    { name: "config", status: "pass", detail: "all set" },
    { name: "API key", status: "warn", detail: "not set", hint: "get one at partners.near-intents.org" },
    { name: "NEAR RPC", status: "fail", detail: "unreachable", hint: "try another RPC" },
  ];

  it("shows one line per check with a symbol, and puts hints underneath", () => {
    const text = formatChecks(sample);
    expect(text).toMatch(/✓\s+config\s+all set/);
    expect(text).toMatch(/⚠\s+API key\s+not set/);
    expect(text).toMatch(/✗\s+NEAR RPC\s+unreachable/);
    expect(text).toMatch(/\n\s+→ get one at partners\.near-intents\.org/);
    expect(text).toMatch(/\n\s+→ try another RPC/);
  });

  it("ends with a one-line verdict", () => {
    expect(formatChecks(sample)).toMatch(/1 failed/);
    expect(formatChecks([{ name: "config", status: "pass", detail: "ok" }])).toMatch(/all checks passed/i);
  });

  it("exits 1 only when something failed", () => {
    expect(exitCode(sample)).toBe(1);
    expect(exitCode(sample.slice(0, 2))).toBe(0);
  });
});
