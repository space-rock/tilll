import { describe, expect, it } from "vitest";
import { thrownBy } from "./helpers/failure.js";
import { ConfigError, parseConfig, parseOneClickConfig } from "../src/config.js";

describe("parseOneClickConfig", () => {
  it("needs no env at all: defaults to the public 1Click URL and no API key", () => {
    expect(parseOneClickConfig({})).toEqual({
      baseUrl: "https://1click.chaindefuser.com",
      apiKey: undefined,
    });
  });

  it("treats an empty ONECLICK_API_KEY as unset and keeps a real one", () => {
    expect(parseOneClickConfig({ ONECLICK_API_KEY: "" }).apiKey).toBeUndefined();
    expect(parseOneClickConfig({ ONECLICK_API_KEY: "jwt.abc.def" }).apiKey).toBe("jwt.abc.def");
  });

  it("strips a trailing slash from the base URL", () => {
    expect(parseOneClickConfig({ ONECLICK_BASE_URL: "http://localhost:9999/" }).baseUrl).toBe("http://localhost:9999");
  });
});

const valid = {
  SETTLEMENT_ACCOUNT_ID: "shop-pay.near",
  SETTLEMENT_ASSET_ID: "nep141:usdc.near",
  MERCHANT_SECRET: "sk_test_123",
  WEBHOOK_URL: "http://localhost:9000/hooks/tilll",
  WEBHOOK_SECRET: "whsec_123",
};

describe("parseConfig", () => {
  it("fills every default from the minimal required env", () => {
    expect(parseConfig(valid)).toEqual({
      port: 8080,
      publicBaseUrl: "http://localhost:8080",
      dataDir: "./data",
      allowedOrigins: ["*"],
      oneClick: { baseUrl: "https://1click.chaindefuser.com", apiKey: undefined },
      settlementAccountId: "shop-pay.near",
      settlementAssetId: "nep141:usdc.near",
      merchantSecret: "sk_test_123",
      webhookUrl: "http://localhost:9000/hooks/tilll",
      webhookSecret: "whsec_123",
      nearRpcUrl: "https://rpc.mainnet.near.org",
      attemptDeadlineMinutes: 30,
      slippageBps: 100,
      memoChains: ["stellar"],
      extraChains: [],
      intentsContract: "intents.near",
      refundMaxPerTx: "50",
      refundMaxPerDay: "200",
      trustProxy: false,
    });
  });

  it("reads EXTRA_CHAINS as a lowercase list of additional chains the checkout may offer", () => {
    expect(parseConfig({ ...valid, EXTRA_CHAINS: "ltc, DOGE ,xrp" }).extraChains).toEqual(["ltc", "doge", "xrp"]);
    expect(parseConfig({ ...valid, EXTRA_CHAINS: "" }).extraChains).toEqual([]);
  });

  it("reads INTENTS_CONTRACT, the NEAR Intents verifier contract, defaulting to the mainnet one", () => {
    expect(parseConfig(valid).intentsContract).toBe("intents.near");
    expect(parseConfig({ ...valid, INTENTS_CONTRACT: "verifier.tidepool-sandbox.testnet" }).intentsContract).toBe(
      "verifier.tidepool-sandbox.testnet",
    );
    expect(parseConfig({ ...valid, INTENTS_CONTRACT: "" }).intentsContract).toBe("intents.near");
  });

  it("derives publicBaseUrl from PORT when not set", () => {
    expect(parseConfig({ ...valid, PORT: "3000" }).publicBaseUrl).toBe("http://localhost:3000");
  });

  it("parses lists and numbers, and lets MEMO_CHAINS be explicitly empty", () => {
    const cfg = parseConfig({
      ...valid,
      ALLOWED_ORIGINS: "https://shop.example, https://b.example",
      MEMO_CHAINS: "stellar, XRP ,ton",
      SLIPPAGE_BPS: "50",
      ATTEMPT_DEADLINE_MINUTES: "45",
    });
    expect(cfg.allowedOrigins).toEqual(["https://shop.example", "https://b.example"]);
    expect(cfg.memoChains).toEqual(["stellar", "xrp", "ton"]);
    expect(cfg.slippageBps).toBe(50);
    expect(cfg.attemptDeadlineMinutes).toBe(45);
    expect(parseConfig({ ...valid, MEMO_CHAINS: "" }).memoChains).toEqual([]);
  });
});

const configError = (fn: () => unknown) => thrownBy(ConfigError, fn);

describe("config errors", () => {
  it("names every missing required variable at once", () => {
    const err = configError(() => parseConfig({}));
    expect(err.issues.map((i) => i.variable).toSorted()).toEqual([
      "MERCHANT_SECRET",
      "SETTLEMENT_ACCOUNT_ID",
      "SETTLEMENT_ASSET_ID",
      "WEBHOOK_SECRET",
      "WEBHOOK_URL",
    ]);
    expect(err.message).toMatch(/MERCHANT_SECRET/);
  });

  it.each([
    ["PORT", "abc"],
    ["PORT", "70000"],
    ["SETTLEMENT_ACCOUNT_ID", "Bad Account!"],
    ["SETTLEMENT_ASSET_ID", "usdc"],
    ["WEBHOOK_URL", "not a url"],
    ["PUBLIC_BASE_URL", "nope"],
    ["NEAR_RPC_URL", "nope"],
    ["INTENTS_CONTRACT", "Not A Contract"],
    ["SLIPPAGE_BPS", "20000"],
    ["SLIPPAGE_BPS", "1.5"],
    ["ATTEMPT_DEADLINE_MINUTES", "0"],
    ["REFUND_MAX_PER_TX", "-5"],
    ["REFUND_MAX_PER_DAY", "abc"],
    ["REFUND_MAX_PER_DAY", "0"],
  ])("rejects %s=%j and names the variable", (variable, value) => {
    const err = configError(() => parseConfig({ ...valid, [variable]: value }));
    expect(err.issues.map((i) => i.variable)).toEqual([variable]);
  });

  it("treats an empty required variable (as shipped in .env.example) as missing", () => {
    const err = configError(() => parseConfig({ ...valid, MERCHANT_SECRET: "", WEBHOOK_SECRET: "" }));
    expect(err.issues.map((i) => i.variable).toSorted()).toEqual(["MERCHANT_SECRET", "WEBHOOK_SECRET"]);
  });

  it("never echoes a secret value in the error message", () => {
    const err = configError(() => parseConfig({ ...valid, SETTLEMENT_ACCOUNT_ID: "Supersecret Value!" }));
    expect(err.message).not.toContain("Supersecret Value!");
  });

  it("no longer has a settlement private key: Tilll holds none, so a leftover one in .env is ignored", () => {
    const config = parseConfig({ ...valid, SETTLEMENT_PRIVATE_KEY: "ed25519:leftover" });
    expect(Object.keys(config)).not.toContain("settlementPrivateKey");
    expect(JSON.stringify(config)).not.toContain("leftover");
  });

  it("asks for the settlement account as the wallet's account, not an invented one", () => {
    const err = configError(() => parseConfig({ ...valid, SETTLEMENT_ACCOUNT_ID: "Bad Account!" }));
    expect(err.message).toMatch(/NEAR account id of a wallet you control/);
  });

  it("parseOneClickConfig also reports a bad URL as a ConfigError", () => {
    const err = configError(() => parseOneClickConfig({ ONECLICK_BASE_URL: "nope" }));
    expect(err.issues.map((i) => i.variable)).toEqual(["ONECLICK_BASE_URL"]);
  });
});

describe("PUBLIC_BASE_URL", () => {
  const base = {
    SETTLEMENT_ACCOUNT_ID: "shop.near",
    SETTLEMENT_ASSET_ID: "nep141:x",
    MERCHANT_SECRET: "s",
    WEBHOOK_URL: "http://localhost:9000/h",
    WEBHOOK_SECRET: "w",
  };

  it.each([
    ["https://pay.example.com/", "https://pay.example.com"],
    ["https://pay.example.com///", "https://pay.example.com"],
    ["https://pay.example.com/shop/", "https://pay.example.com/shop"],
    ["http://localhost:8080", "http://localhost:8080"],
  ])("%s becomes %s, so pay links never contain a double slash", (given, expected) => {
    expect(parseConfig({ ...base, PUBLIC_BASE_URL: given }).publicBaseUrl).toBe(expected);
  });
});

describe("ALLOWED_ORIGINS", () => {
  const base = {
    SETTLEMENT_ACCOUNT_ID: "shop.near",
    SETTLEMENT_ASSET_ID: "nep141:x",
    MERCHANT_SECRET: "s",
    WEBHOOK_URL: "http://localhost:9000/h",
    WEBHOOK_SECRET: "w",
  };

  it("matches what a browser sends as its Origin: no trailing slash, lower case", () => {
    expect(
      parseConfig({ ...base, ALLOWED_ORIGINS: "https://Shop.Example.com/, http://localhost:3000" }).allowedOrigins,
    ).toEqual(["https://shop.example.com", "http://localhost:3000"]);
    expect(parseConfig({ ...base, ALLOWED_ORIGINS: "*" }).allowedOrigins).toEqual(["*"]);
    expect(parseConfig(base).allowedOrigins).toEqual(["*"]);
  });

  it.each(["https://shop.example.com/checkout", "shop.example.com", "ftp://shop.example.com", "https://"])(
    "refuses %s, which can never match an Origin, and names the setting",
    (bad) => {
      expect(() => parseConfig({ ...base, ALLOWED_ORIGINS: bad })).toThrow(/ALLOWED_ORIGINS/);
    },
  );
});

describe("URL settings", () => {
  const base = {
    SETTLEMENT_ACCOUNT_ID: "shop.near",
    SETTLEMENT_ASSET_ID: "nep141:x",
    MERCHANT_SECRET: "s",
    WEBHOOK_URL: "http://localhost:9000/h",
    WEBHOOK_SECRET: "w",
  };

  it.each(["WEBHOOK_URL", "ONECLICK_BASE_URL", "NEAR_RPC_URL", "PUBLIC_BASE_URL"])(
    "%s must be http or https, so a typo fails at startup instead of failing silently later",
    (name) => {
      for (const bad of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "example.com/hook"]) {
        expect(() => parseConfig({ ...base, [name]: bad }), `${name}=${bad}`).toThrow(new RegExp(name));
      }
      expect(() => parseConfig({ ...base, [name]: "https://example.com/x" })).not.toThrow();
      expect(() => parseConfig({ ...base, [name]: "http://127.0.0.1:9000/x" })).not.toThrow();
    },
  );
});

describe("TRUST_PROXY", () => {
  const base = {
    SETTLEMENT_ACCOUNT_ID: "shop.near",
    SETTLEMENT_ASSET_ID: "nep141:x",
    MERCHANT_SECRET: "s",
    WEBHOOK_URL: "http://localhost:9000/h",
    WEBHOOK_SECRET: "w",
  };
  const trust = (value: string | undefined) =>
    parseConfig({ ...base, ...(value === undefined ? {} : { TRUST_PROXY: value }) }).trustProxy;

  it("is off unless set: Tilll believes nothing a client says about where it came from", () => {
    expect(trust(undefined)).toBe(false);
    expect(trust("")).toBe(false);
    expect(trust("false")).toBe(false);
  });

  it.each([
    ["true", true],
    ["1", 1],
    ["2", 2],
    [" 3 ", 3],
    ["loopback", ["loopback"]],
    ["10.0.0.0/8", ["10.0.0.0/8"]],
    ["10.0.0.0/8, 172.16.0.0/12 ,192.168.1.5", ["10.0.0.0/8", "172.16.0.0/12", "192.168.1.5"]],
    ["::1,fd00::/8", ["::1", "fd00::/8"]],
    ["loopback,uniquelocal", ["loopback", "uniquelocal"]],
  ])("reads %j as %j", (given, expected) => {
    expect(trust(given)).toEqual(expected);
  });

  it.each([
    "yes",
    "0",
    "-1",
    "1.5",
    "11",
    "banana",
    "10.0.0.0/33",
    "10.0.0.0/",
    "300.1.1.1",
    "::1/129",
    "10.0.0.0/8,",
    "10.0.0.0/8,,1.2.3.4",
    "1,2",
  ])("refuses %j and names the setting", (bad) => {
    expect(() => trust(bad)).toThrow(/TRUST_PROXY/);
  });
});
