import { describe, expect, it } from "vitest";
import { chainOfAssetId, withExplorerLinks } from "../src/oneclick/explorers.js";
import { USDC_BASE, USDC_NEAR } from "./helpers/oneclickData.js";

const HASH = "0xcc1b58a67691fa3abe1a5849d62810c8478e604a4b7c57f9882e4fd3a6a72e15";

describe("explorer links", () => {
  it("reads the chain from an asset id", () => {
    expect(chainOfAssetId(USDC_BASE)).toBe("base");
    expect(chainOfAssetId(USDC_NEAR)).toBe("near");
    expect(chainOfAssetId("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near")).toBe("sol");
    expect(chainOfAssetId("nep245:v2_1.omni.hot.tg:8453_abc")).toBeNull();
    expect(chainOfAssetId(undefined)).toBeNull();
  });

  it("fills an empty link from the chain (what mainnet 1Click returns)", () => {
    expect(withExplorerLinks([{ hash: HASH, explorerUrl: "" }], "base")).toEqual([
      { hash: HASH, explorerUrl: `https://basescan.org/tx/${HASH}` },
    ]);
    expect(
      withExplorerLinks([{ hash: "GLjw1TDRqLqYyoLFhnC6HwEnKf9J1e6pXjbHPxj2zj5L", explorerUrl: "" }], "near")[0]!
        .explorerUrl,
    ).toBe("https://nearblocks.io/txns/GLjw1TDRqLqYyoLFhnC6HwEnKf9J1e6pXjbHPxj2zj5L");
  });

  it("keeps a link 1Click gave, and leaves an unknown chain or an odd hash alone", () => {
    const given = { hash: HASH, explorerUrl: "https://basescan.org/tx/0xabc" };
    expect(withExplorerLinks([given], "arb")).toEqual([given]);
    expect(withExplorerLinks([{ hash: HASH, explorerUrl: "" }], "stellar")[0]!.explorerUrl).toBe("");
    expect(withExplorerLinks([{ hash: HASH, explorerUrl: "" }], null)[0]!.explorerUrl).toBe("");
    expect(withExplorerLinks([{ hash: "../../x?y=1", explorerUrl: "" }], "base")[0]!.explorerUrl).toBe("");
    expect(withExplorerLinks([{ hash: HASH, explorerUrl: "javascript:alert(1)" }], "base")[0]!.explorerUrl).toBe(
      `https://basescan.org/tx/${HASH}`,
    );
  });
});
