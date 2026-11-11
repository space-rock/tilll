import { describe, expect, it } from "vitest";
import { STRICT_CHAINS, hasStrictValidation, validateAddress } from "../src/validate/addresses.js";

const EVM = "0x1111111111111111111111111111111111111111";
const EVM_MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

const valid: [chain: string, address: string][] = [
  ["eth", EVM],
  ["base", EVM_MIXED],
  ["arb", EVM],
  ["sol", "11111111111111111111111111111111"],
  ["sol", "So11111111111111111111111111111111111111112"],
  ["near", "alice.near"],
  ["near", "shop-pay.near"],
  ["near", "sub.account_1.near"],
  ["near", "a".repeat(64)],
  ["btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
  ["btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"],
  ["btc", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ["tron", "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL"],
];

const invalid: [chain: string, address: string][] = [
  ["base", "0x123"],
  ["base", EVM.slice(2)],
  ["base", `${EVM}0`],
  ["base", "0X1111111111111111111111111111111111111111"],
  ["base", "0xZZ11111111111111111111111111111111111111"],
  ["eth", `${EVM} `],
  ["sol", "1".repeat(31)],
  ["sol", "1".repeat(45)],
  ["sol", `${"1".repeat(31)}0`],
  ["sol", `${"1".repeat(31)}O`],
  ["sol", `${"1".repeat(31)}l`],
  ["near", "Alice.near"],
  ["near", "a"],
  ["near", ".near"],
  ["near", "alice..near"],
  ["near", "alice.near."],
  ["near", "alice near"],
  ["near", "a".repeat(65)],
  ["btc", "bc1"],
  ["btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"],
  ["btc", EVM],
  ["tron", "ANPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL"],
  ["tron", "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqe"],
];

describe("validateAddress", () => {
  it.each(valid)("accepts %s address %s as strictly valid", (chain, address) => {
    expect(validateAddress(chain, address)).toEqual({ ok: true, strict: true });
  });

  it.each(invalid)("rejects %s address %j with a reason the payer can act on", (chain, address) => {
    expect(validateAddress(chain, address)).toMatchObject({ ok: false, reason: expect.stringMatching(/.{10,}/) });
  });

  it("treats chain ids case-insensitively", () => {
    expect(validateAddress("BASE", EVM)).toEqual({ ok: true, strict: true });
    expect(validateAddress("Sol", "11111111111111111111111111111111")).toEqual({ ok: true, strict: true });
  });

  it("only checks non-empty and no whitespace on chains without a strict rule, and says so", () => {
    expect(validateAddress("ltc", "LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL")).toEqual({ ok: true, strict: false });
    expect(validateAddress("ltc", "")).toMatchObject({ ok: false });
    expect(validateAddress("ltc", "L dP8")).toMatchObject({ ok: false });
    expect(validateAddress("some-new-chain", "anything-goes")).toEqual({ ok: true, strict: false });
  });

  it("names the expected shape in the message", () => {
    const evm = validateAddress("base", "0x123");
    const sol = validateAddress("sol", "abc");
    expect(!evm.ok && evm.reason).toMatch(/0x/);
    expect(!sol.ok && sol.reason).toMatch(/32/);
  });

  it("never throws on odd input", () => {
    for (const odd of ["", " ", "\n", "💥", "0x", "a".repeat(10_000)]) {
      expect(() => validateAddress("base", odd)).not.toThrow();
      expect(() => validateAddress("near", odd)).not.toThrow();
    }
  });
});

describe("hasStrictValidation", () => {
  it("is true for the EVM chains, Solana, NEAR, Bitcoin and Tron, and false otherwise", () => {
    for (const chain of ["eth", "base", "arb", "op", "pol", "bsc", "avax", "sol", "near", "btc", "tron", "BASE"]) {
      expect(hasStrictValidation(chain)).toBe(true);
    }
    for (const chain of ["ltc", "doge", "xrp", "ton", "stellar", "nowhere"])
      expect(hasStrictValidation(chain)).toBe(false);
  });

  it("lists exactly the chains it validates, all lowercase and without duplicates", () => {
    expect(STRICT_CHAINS.every((c) => c === c.toLowerCase())).toBe(true);
    expect(new Set(STRICT_CHAINS).size).toBe(STRICT_CHAINS.length);
    expect(STRICT_CHAINS.every(hasStrictValidation)).toBe(true);
  });
});
