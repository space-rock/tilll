import { describe, expect, it } from "vitest";
import {
  DUMMY_API_KEY,
  TESTNET_BASE_URL,
  TestnetGuardError,
  assertTestnetHealth,
  assertTestnetTargets,
  type TestnetTargets,
} from "../scripts/testnet/guard.js";
import { thrownBy } from "./helpers/failure.js";

const GOOD: TestnetTargets = {
  oneClickBaseUrl: TESTNET_BASE_URL,
  nearRpcUrl: "https://test.rpc.fastnear.com",
  intentsContract: "verifier.tidepool-sandbox.testnet",
  accountIds: ["shop.testnet", "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"],
  apiKey: DUMMY_API_KEY,
};

const violations = (targets: TestnetTargets) =>
  thrownBy(TestnetGuardError, () => assertTestnetTargets(targets)).violations;

describe("assertTestnetTargets", () => {
  it("accepts the Tidepool testnet setup", () => {
    expect(() => assertTestnetTargets(GOOD)).not.toThrow();
    expect(() => assertTestnetTargets({ ...GOOD, apiKey: undefined })).not.toThrow();
  });

  it.each([
    ["the real 1Click", "https://1click.chaindefuser.com"],
    ["an empty URL, which Tilll would treat as its mainnet default", ""],
    ["a look-alike host", "https://www.usetidepool.tech.evil.example"],
    ["a look-alike prefix", "https://evil-www.usetidepool.tech"],
    ["plain http", "http://www.usetidepool.tech"],
    ["a path trick", "https://1click.chaindefuser.com/#www.usetidepool.tech"],
    ["userinfo that hides the real host", "https://www.usetidepool.tech@1click.chaindefuser.com"],
    ["credentials embedded in an otherwise correct URL", "https://user:secret@www.usetidepool.tech"],
    ["a non-default port", "https://www.usetidepool.tech:8443"],
    ["a path", "https://www.usetidepool.tech/somewhere"],
    ["something that is not a URL", "not a url"],
  ])("refuses %s as the 1Click base URL", (_name, url) => {
    expect(violations({ ...GOOD, oneClickBaseUrl: url }).join("\n")).toMatch(/1Click base URL/);
  });

  it.each([
    ["the mainnet RPC", "https://rpc.mainnet.near.org"],
    ["an unknown host", "https://rpc.example.com"],
    ["an empty URL", ""],
    ["a mainnet host that mentions testnet in its path", "https://rpc.mainnet.near.org/testnet"],
  ])("refuses %s as the NEAR RPC", (_name, url) => {
    expect(violations({ ...GOOD, nearRpcUrl: url }).join("\n")).toMatch(/NEAR RPC/);
  });

  it.each(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"])(
    "accepts the testnet RPC %s",
    (url) => {
      expect(() => assertTestnetTargets({ ...GOOD, nearRpcUrl: url })).not.toThrow();
    },
  );

  it.each([
    ["the mainnet verifier", "intents.near"],
    ["an account that is not a testnet one", "verifier.example.near"],
    ["an empty value", ""],
  ])("refuses %s as the verifier contract", (_name, contract) => {
    expect(violations({ ...GOOD, intentsContract: contract }).join("\n")).toMatch(/verifier contract/);
  });

  it.each([
    ["a mainnet named account", "shopname-pay.near"],
    ["a placeholder", "example.near"],
    ["a 63 character hex string", "a".repeat(63)],
    ["uppercase hex", "A".repeat(64)],
    ["an empty id", ""],
  ])("refuses %s as an account", (_name, id) => {
    expect(violations({ ...GOOD, accountIds: [id] }).join("\n")).toMatch(/account/);
  });

  it("refuses one bad account among good ones", () => {
    expect(violations({ ...GOOD, accountIds: ["ok.testnet", "real-shop.near"] }).join("\n")).toContain(
      "real-shop.near",
    );
  });

  it.each([
    [
      "a JWT, which is what a real partner key looks like",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["any other value", "my-real-partner-key"],
    ["an empty string", ""],
  ])("refuses %s as the API key sent to the third party", (_name, apiKey) => {
    expect(violations({ ...GOOD, apiKey }).join("\n")).toMatch(/API key/);
  });

  it("reports every problem at once", () => {
    const all = violations({
      oneClickBaseUrl: "https://1click.chaindefuser.com",
      nearRpcUrl: "https://rpc.mainnet.near.org",
      intentsContract: "intents.near",
      accountIds: ["shopname-pay.near"],
      apiKey: "eyJ.real.jwt",
    });
    expect(all).toHaveLength(5);
  });

  it("never echoes the API key in its message", () => {
    const err = thrownBy(TestnetGuardError, () =>
      assertTestnetTargets({ ...GOOD, apiKey: "super-secret-partner-key" }),
    );
    expect(err.message).not.toContain("super-secret-partner-key");
  });
});

describe("assertTestnetHealth", () => {
  const healthy = { service: "tidepool", network: "testnet", ok: true, verifier: "verifier.tidepool-sandbox.testnet" };

  it("accepts a healthy testnet answer from the expected verifier", () => {
    expect(() => assertTestnetHealth(healthy, "verifier.tidepool-sandbox.testnet")).not.toThrow();
  });

  it.each([
    ["a mainnet answer", { ...healthy, network: "mainnet" }],
    ["an unhealthy answer", { ...healthy, ok: false }],
    ["a different verifier than configured", { ...healthy, verifier: "verifier.other.testnet" }],
    ["a mainnet verifier", { ...healthy, verifier: "intents.near" }],
    ["an answer with no network", { service: "tidepool", ok: true, verifier: "verifier.tidepool-sandbox.testnet" }],
    ["something that is not an object", "ok"],
    ["null", null],
  ])("refuses %s", (_name, health) => {
    expect(() => assertTestnetHealth(health, "verifier.tidepool-sandbox.testnet")).toThrow(TestnetGuardError);
  });
});
