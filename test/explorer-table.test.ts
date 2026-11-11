import { describe, expect, it } from "vitest";
import { chunkUrls, extractIconTable } from "../scripts/explorer-table.js";

/** A stand-in for the explorer's script: the asset table is a JSON string, followed by the icons folder. */
const table = {
  "nep141:wrap.near": { chain: "near", symbol: "wNEAR", decimals: 24, icon: "near.png" },
  "nep141:eth-0xabc.omft.near": { chain: "eth", symbol: "USDT0", decimals: 6, icon: "usdt.png" },
  "nep141:853d.factory.bridge.near": { chain: "near", symbol: "FRAX", decimals: 18 },
};
const bundle = (json: string) =>
  `var a=1;let t=JSON.parse('${json}'),l="/icons/token/",c=["x"];function u(e){return e}`;

describe("reading the explorer's table of token images", () => {
  it("gets each asset's image file from the script, and keeps an asset that has none as null", () => {
    expect(extractIconTable(bundle(JSON.stringify(table)))).toEqual({
      "nep141:wrap.near": "near.png",
      "nep141:eth-0xabc.omft.near": "usdt.png",
      "nep141:853d.factory.bridge.near": null,
    });
  });

  it("reads a table that has an apostrophe escaped inside it", () => {
    const withQuote = { "nep141:a.near": { chain: "near", symbol: "It's", decimals: 1, icon: "its.png" } };
    const json = JSON.stringify(withQuote).replaceAll("'", "\\'");
    expect(extractIconTable(bundle(json))).toEqual({ "nep141:a.near": "its.png" });
  });

  it("is nothing when the script has no such table, so an update says so instead of guessing", () => {
    expect(extractIconTable("var a=1;")).toBeUndefined();
    expect(extractIconTable(bundle("{not json"))).toBeUndefined();
    expect(extractIconTable(bundle("[1,2]"))).toBeUndefined();
    expect(extractIconTable(bundle("{}"))).toBeUndefined();
  });

  it("drops a file name that is not a plain picture name, which is never put into an address", () => {
    const bad = {
      "nep141:a": { chain: "x", symbol: "A", decimals: 1, icon: "../x.png" },
      "nep141:b": { chain: "x", symbol: "B", decimals: 1, icon: "b.exe" },
      "nep141:c": { chain: "x", symbol: "C", decimals: 1, icon: "c d.png" },
      "nep141:d": { chain: "x", symbol: "D", decimals: 1, icon: "d.webp" },
    };
    expect(extractIconTable(bundle(JSON.stringify(bad)))).toEqual({
      "nep141:a": null,
      "nep141:b": null,
      "nep141:c": null,
      "nep141:d": "d.webp",
    });
  });
});

describe("finding the explorer's scripts", () => {
  it("lists the script files a page loads, once each, and only ones on the same site", () => {
    const html = `<script src="/_next/static/a.js" async></script><script src="/_next/static/a.js"></script>
      <script src="/_next/static/b.js"></script><script src="https://evil.example/x.js"></script><script>inline()</script>`;
    expect(chunkUrls(html, "https://explorer.near-intents.org")).toEqual([
      "https://explorer.near-intents.org/_next/static/a.js",
      "https://explorer.near-intents.org/_next/static/b.js",
    ]);
  });
});
