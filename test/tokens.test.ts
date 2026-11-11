import { describe, expect, it, vi } from "vitest";
import { OneClickError } from "../src/oneclick/client.js";
import { SettlementAssetError, createTokenCache } from "../src/oneclick/tokens.js";
import type { Token } from "../src/oneclick/types.js";
import tokensFixture from "./fixtures/tokens.json" with { type: "json" };

const TOKENS = tokensFixture as Token[];
const TEN_MINUTES = 10 * 60 * 1000;

function setup(tokens: () => Promise<Token[]> = async () => TOKENS) {
  const client = { tokens: vi.fn<() => Promise<Token[]>>(tokens) };
  let time = 1_000_000;
  const cache = createTokenCache({ client, now: () => time });
  return {
    client,
    cache,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("token cache freshness", () => {
  it("fetches once and serves repeat calls from cache within 10 minutes", async () => {
    const { client, cache, advance } = setup();

    const first = await cache.get();
    advance(TEN_MINUTES - 1);
    const second = await cache.get();

    expect(first).toHaveLength(TOKENS.length);
    expect(second).toBe(first);
    expect(client.tokens).toHaveBeenCalledTimes(1);
  });

  it("refetches once the 10 minute TTL has passed", async () => {
    const { client, cache, advance } = setup();

    await cache.get();
    advance(TEN_MINUTES);
    await cache.get();

    expect(client.tokens).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const { client, cache } = setup();

    await Promise.all([cache.get(), cache.get(), cache.get()]);

    expect(client.tokens).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the stale list when a refresh fails, so a 1Click blip does not break checkout", async () => {
    let fail = false;
    const { cache, advance } = setup(async () => {
      if (fail) throw new OneClickError(0, "network down");
      return TOKENS;
    });

    const first = await cache.get();
    fail = true;
    advance(TEN_MINUTES);

    expect(await cache.get()).toBe(first);
  });

  it("throws when the very first fetch fails, and retries on the next call", async () => {
    let fail = true;
    const { client, cache } = setup(async () => {
      if (fail) throw new OneClickError(503, "unavailable");
      return TOKENS;
    });

    await expect(cache.get()).rejects.toThrow(/unavailable/);
    fail = false;
    expect(await cache.get()).toHaveLength(TOKENS.length);
    expect(client.tokens).toHaveBeenCalledTimes(2);
  });
});

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

describe("token lookups", () => {
  it("findAsset returns the token for an assetId, or undefined", async () => {
    const { cache } = setup();
    expect(await cache.findAsset("nep141:wrap.near")).toMatchObject({ symbol: "wNEAR", decimals: 24 });
    expect(await cache.findAsset("nep141:does-not-exist")).toBeUndefined();
  });

  it("find matches chain and symbol case-insensitively", async () => {
    const { cache } = setup();
    const hits = await cache.find("BASE", "usdc");
    expect(hits.map((t) => t.assetId)).toEqual([USDC_BASE]);
  });

  it("find returns every match when the symbol is ambiguous on a chain", async () => {
    const { cache } = setup();
    expect(await cache.find("hypercore", "USDC")).toHaveLength(2);
  });

  it("find returns an empty list for an unknown route", async () => {
    const { cache } = setup();
    expect(await cache.find("nowhere", "USDC")).toEqual([]);
  });

  it("byChain puts every token under exactly one chain", async () => {
    const { cache } = setup();
    const grouped = await cache.byChain();
    expect(grouped["base"]!.map((t) => t.assetId)).toContain(USDC_BASE);
    expect(Object.values(grouped).flat()).toHaveLength(TOKENS.length);
  });
});

describe("resolveSettlementAsset", () => {
  it("returns the token when the configured asset exists", async () => {
    const { cache } = setup();
    expect(await cache.resolveSettlementAsset(USDC_NEAR)).toMatchObject({
      symbol: "USDC",
      blockchain: "near",
      decimals: 6,
    });
  });

  it("fails fast with a readable message that points at USDC on NEAR", async () => {
    const { cache } = setup();
    const err = await cache.resolveSettlementAsset("nep141:usdc.typo.near").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementAssetError);
    const message = (err as Error).message;
    expect(message).toContain("SETTLEMENT_ASSET_ID");
    expect(message).toContain("nep141:usdc.typo.near");
    expect(message).toContain(USDC_NEAR);
  });

  it("still gives a clear message when 1Click lists no USDC on NEAR to suggest", async () => {
    const { cache } = setup(async () => TOKENS.filter((t) => !(t.blockchain === "near" && t.symbol === "USDC")));
    const err = await cache.resolveSettlementAsset("nep141:usdc.typo.near").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementAssetError);
    expect((err as Error).message).toContain("nep141:usdc.typo.near");
  });
});

describe("token cache health", () => {
  it("reports reachable after a good fetch", async () => {
    const { cache } = setup();
    expect(await cache.health()).toEqual({ reachable: true });
  });

  it("reports unreachable when the first fetch fails, without throwing", async () => {
    const { cache } = setup(async () => {
      throw new OneClickError(0, "network down");
    });
    expect(await cache.health()).toEqual({ reachable: false });
  });

  it("reports unreachable when a refresh fails even though a stale list is still served, and recovers", async () => {
    let failing = false;
    const { cache, advance } = setup(async () => {
      if (failing) throw new OneClickError(0, "network down");
      return TOKENS;
    });
    await cache.get();
    failing = true;
    advance(TEN_MINUTES);
    expect(await cache.health()).toEqual({ reachable: false });
    expect(await cache.get()).toHaveLength(TOKENS.length);

    failing = false;
    advance(TEN_MINUTES);
    expect(await cache.health()).toEqual({ reachable: true });
  });
});
