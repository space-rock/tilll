import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MAX_ICON_BYTES, createIconService, isSafeSvg, readAssetIcons } from "../src/icons.js";
import { TOKENS } from "./helpers/oneclickData.js";

/**
 * Share of the test fixture's tokens (an older copy of 1Click's list) that must get a picture. The fixture predates the
 * snapshot, so it is a floor, not the snapshot's own coverage (the map-based tests below are exact).
 */
const MIN_COVERAGE = 0.9;
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const files = (kind: string) =>
  readdirSync(join(dir, kind)).map((name) => ({ kind, name, path: join(dir, kind, name) }));
const all = [...files("token"), ...files("chain")];
const table = readAssetIcons(dir);
const stems = new Set(files("token").map((f) => f.name.replace(/\.\w+$/, "")));
const stemOf = (file: string) => file.slice(0, file.lastIndexOf("."));

/** The shipped snapshot of token and network images (public/icons): what `pnpm icons:update` leaves behind. */
describe("public/icons, the snapshot of token and network images", () => {
  it("holds only real png, jpeg, webp and plain SVG pictures, small, with names that cannot point anywhere else", () => {
    expect(all.length).toBeGreaterThan(80);
    for (const { kind, name, path } of all) {
      const pattern =
        kind === "token" ? /^[a-z0-9]{1,40}\.(png|jpeg|webp|svg)$/ : /^[a-z0-9]{2,12}\.(png|jpeg|webp|svg)$/;
      const bytes = readFileSync(path);
      const magic =
        (name.endsWith(".svg") && isSafeSvg(bytes)) ||
        bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
        bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
        (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP");
      expect({ name, ok: pattern.test(name), magic, small: statSync(path).size <= MAX_ICON_BYTES }).toEqual({
        name,
        ok: true,
        magic: true,
        small: true,
      });
    }
  });

  it("has no network logo that is only white, which would vanish on the light badge", () => {
    for (const { name, path } of files("chain").filter((f) => f.name.endsWith(".svg"))) {
      const fills = [...readFileSync(path, "utf8").matchAll(/fill="([^"]*)"/gi)].map((m) => m[1]!.toLowerCase());
      const colours = fills.filter((f) => !["none", "#fff", "#ffffff", "white"].includes(f));
      expect([name, fills.length === 0 || colours.length > 0]).toEqual([name, true]);
    }
  });

  it("has a picture for every file the explorer's table names, so no token the table pictures is left with a letter", () => {
    const named = Object.values(table).filter((f): f is string => typeof f === "string");
    expect(named.length).toBeGreaterThan(150);
    expect(named.filter((file) => !stems.has(stemOf(file)))).toEqual([]);
  });

  it("holds the table's choices: wNEAR shows NEAR, USDT0 shows USDT, and the tokens it leaves without a picture stay without", () => {
    expect(table["nep141:wrap.near"]).toBe("near.png");
    const usdt0 = TOKENS.find((t) => t.symbol === "USDT0" && t.blockchain === "arb")!;
    expect(table[usdt0.assetId]).toBe("usdt.png");
    const frax = TOKENS.find((t) => t.symbol === "FRAX")!;
    expect(table[frax.assetId]).toBeNull();
    for (const stem of ["usdc", "usdt", "eth", "btc", "sol", "near"]) expect(stems.has(stem)).toBe(true);
  });

  it("covers nearly all of the tokens in the test fixture, and the networks the checkout lists", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const icons = createIconService({
      dir: "/nonexistent/tilll-cache",
      bundledDir: dir,
      assetIcons: table,
      tokens: { get: async () => TOKENS },
      fetch: offline,
    });
    const shown = TOKENS.filter((t) => {
      const name = icons.iconNameOf(t);
      return name !== undefined && stems.has(name);
    });
    expect(shown.length / TOKENS.length).toBeGreaterThan(MIN_COVERAGE);
    const chains = new Set(files("chain").map((f) => f.name.replace(/\.\w+$/, "")));
    for (const chain of ["eth", "base", "arb", "op", "pol", "bsc", "avax", "sol", "near", "tron", "btc"]) {
      expect(chains.has(chain)).toBe(true);
    }
  });

  it("is enough for a server with no way out: the demo and an air-gapped install show real images", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    const icons = createIconService({
      dir: "/nonexistent/tilll-cache",
      bundledDir: dir,
      assetIcons: table,
      tokens: { get: async () => TOKENS },
      fetch: offline,
    });
    const wnear = TOKENS.find((t) => t.symbol === "wNEAR" && t.blockchain === "near")!;
    expect(icons.iconNameOf(wnear)).toBe("near");
    expect((await icons.tokenIcon("near"))?.type).toBe("image/png");
    expect((await icons.tokenIcon("usdc"))?.type).toBe("image/png");
    expect((await icons.chainIcon("base"))?.type).toMatch(/^image\//);
    expect((await icons.chainIcon("btc"))?.type).toMatch(/^image\//);
    expect(offline).not.toHaveBeenCalled();
  });
});
