import { describe, expect, it } from "vitest";
import { STRICT_CHAINS } from "../src/validate/addresses.js";
import { buildChoices, chainName, filterChains, filterTokens, type TokensPayload } from "../widget/src/tokens.js";
import { TOKENS } from "./helpers/oneclickData.js";

/** The /pay/tokens payload for the real token list. */
function payloadFor(extra: string[] = []): TokensPayload {
  const chains: TokensPayload["chains"] = {};
  for (const t of TOKENS)
    (chains[t.blockchain] ??= []).push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals });
  const enabledChains = [...new Set([...STRICT_CHAINS, ...extra])].filter((c) => c in chains);
  return { chains, enabledChains };
}

const symbols = (choices: ReturnType<typeof buildChoices>, chain: string) =>
  choices.find((c) => c.chain === chain)!.tokens.map((t) => t.symbol);

describe("chainName", () => {
  it("gives popular chains a readable name and falls back to the upper-case id", () => {
    expect(["base", "arb", "eth", "sol", "near", "btc", "tron", "op", "pol", "bsc", "avax"].map(chainName)).toEqual([
      "Base",
      "Arbitrum",
      "Ethereum",
      "Solana",
      "NEAR",
      "Bitcoin",
      "Tron",
      "Optimism",
      "Polygon",
      "BNB Chain",
      "Avalanche",
    ]);
    expect(chainName("ltc")).toBe("LTC");
  });
});

describe("buildChoices", () => {
  it("offers only the enabled chains", () => {
    const chains = buildChoices(payloadFor()).map((c) => c.chain);
    expect(chains).not.toContain("doge");
    expect(chains).not.toContain("ton");
    expect(chains).toEqual(expect.arrayContaining(["base", "eth", "sol", "near", "btc", "tron"]));
  });

  it("puts the popular chains first, in the PLAN order, then the rest alphabetically by name", () => {
    const names = buildChoices(payloadFor()).map((c) => c.chain);
    expect(names.slice(0, 7)).toEqual(["base", "arb", "eth", "sol", "near", "btc", "tron"]);
    const rest = buildChoices(payloadFor())
      .slice(7)
      .map((c) => c.name);
    expect(rest).toEqual(rest.toSorted((a, b) => a.localeCompare(b)));
  });

  it("includes extra chains from configuration, after the others", () => {
    const chains = buildChoices(payloadFor(["ltc"])).map((c) => c.chain);
    expect(chains).toContain("ltc");
  });

  it("leads each chain with its stablecoins and native coin, then the rest alphabetically", () => {
    const choices = buildChoices(payloadFor());
    expect(symbols(choices, "base").slice(0, 2)).toEqual(["USDC", "ETH"]);
    expect(symbols(choices, "arb").slice(0, 3)).toEqual(["USDC", "USDT0", "ETH"]);
    expect(symbols(choices, "eth").slice(0, 3)).toEqual(["USDC", "USDT", "ETH"]);
    expect(symbols(choices, "sol").slice(0, 3)).toEqual(["USDC", "USDT", "SOL"]);
    // NEAR lists two different USDT contracts; look-alikes stay next to each other.
    expect(symbols(choices, "near").slice(0, 4)).toEqual(["USDC", "USDT", "USDT", "wNEAR"]);
    expect(symbols(choices, "btc")[0]).toBe("BTC");
    const rest = symbols(choices, "base").slice(2);
    expect(rest).toEqual(rest.toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
  });

  it("flags tokens that share a symbol on a chain and shows which contract each is", () => {
    const near = buildChoices(payloadFor()).find((c) => c.chain === "near")!;
    const usdt = near.tokens.filter((t) => t.symbol === "USDT");
    expect(usdt).toHaveLength(2);
    expect(usdt.every((t) => t.ambiguous)).toBe(true);
    expect(usdt[0]!.detail).toBe("usdt.tether-token.near");
    expect(usdt[1]!.detail).toMatch(/^miden-0x5cb7/);
    expect(near.tokens.find((t) => t.symbol === "USDC")!.ambiguous).toBe(false);
  });

  it("drops a chain whose token list is empty", () => {
    const choices = buildChoices({
      chains: { base: [], sol: [{ assetId: "a", symbol: "SOL", decimals: 9 }] },
      enabledChains: ["base", "sol"],
    });
    expect(choices.map((c) => c.chain)).toEqual(["sol"]);
  });
});

describe("filterChains", () => {
  const choices = buildChoices(payloadFor());

  it("returns the same list for an empty search", () => {
    expect(filterChains(choices, "")).toBe(choices);
    expect(filterChains(choices, "   ")).toBe(choices);
  });

  it("matches the network's name or id, ignoring case and spaces", () => {
    expect(filterChains(choices, "  SoLaNa ").map((c) => c.chain)).toEqual(["sol"]);
    expect(filterChains(choices, "arb").map((c) => c.chain)).toContain("arb");
  });

  it("returns nothing for gibberish, and does not search token names", () => {
    expect(filterChains(choices, "zzzzqqq")).toEqual([]);
    expect(filterChains(choices, "usdc")).toEqual([]);
  });
});

describe("filterTokens", () => {
  const tokens = buildChoices(payloadFor()).find((c) => c.chain === "base")!.tokens;

  it("returns the same list for an empty search", () => {
    expect(filterTokens(tokens, "")).toBe(tokens);
  });

  it("matches the symbol, ignoring case and spaces", () => {
    const hits = filterTokens(tokens, "  usDC ");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((t) => /usdc/i.test(t.symbol))).toBe(true);
    expect(filterTokens(tokens, "zzzzqqq")).toEqual([]);
  });
});

describe("images", () => {
  it("carries each token's image id through, and marks the networks that have an image", () => {
    const base = payloadFor();
    const withIcons: TokensPayload = {
      ...base,
      chains: Object.fromEntries(
        Object.entries(base.chains).map(([chain, list]) => [
          chain,
          list.map((t) => ({ ...t, icon: `id-${t.symbol}` })),
        ]),
      ),
      chainIcons: ["base", "sol"],
    };
    const choices = buildChoices(withIcons);
    expect(choices.find((c) => c.chain === "base")!.hasIcon).toBe(true);
    expect(choices.find((c) => c.chain === "arb")!.hasIcon).toBe(false);
    expect(choices.find((c) => c.chain === "base")!.tokens.every((t) => t.icon === `id-${t.symbol}`)).toBe(true);
  });

  it("is plain when the server names no images", () => {
    const choices = buildChoices(payloadFor());
    expect(choices.every((c) => !c.hasIcon && c.tokens.every((t) => t.icon === undefined))).toBe(true);
  });
});
