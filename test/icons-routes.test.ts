import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIconService } from "../src/icons.js";
import { makeApp } from "./helpers/app.js";
import { PNG, SVG, fakeExplorer } from "./helpers/fakeExplorer.js";
import { TOKENS } from "./helpers/world.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function appWithIcons(options: Parameters<typeof makeApp>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tilll-icons-"));
  dirs.push(dir);
  const fake = fakeExplorer();
  const icons = createIconService({ dir, tokens: { get: async () => TOKENS }, fetch: fake.fetcher });
  const t = await makeApp({ ...options, icons });
  return { ...t, fake };
}

describe("GET /pay/icons/token/:symbol", () => {
  it("serves the image with headers that keep it a picture and nothing else", async () => {
    const t = await appWithIcons();
    const response = await t.app.inject({ method: "GET", url: "/pay/icons/token/usdc" });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(PNG)).toBe(true);
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("is a plain 404 for a symbol that no listed token has, or that is not written plainly, and asks nobody", async () => {
    const t = await appWithIcons();
    for (const id of ["nosuchtoken", "..%2F..%2Fetc%2Fpasswd", "USDC"]) {
      const response = await t.app.inject({ method: "GET", url: `/pay/icons/token/${id}` });
      expect([id, response.statusCode, response.json().error.code]).toEqual([id, 404, "not_found"]);
    }
    expect(t.fake.calls).toHaveLength(0);
  });

  it("is not counted against the limit on the other checkout calls, so a long token list loads whole", async () => {
    const t = await appWithIcons({ rateLimit: { max: 2, timeWindow: "1 minute" } });
    for (let i = 0; i < 8; i++) {
      const response = await t.app.inject({ method: "GET", url: "/pay/icons/token/usdc" });
      expect([i, response.statusCode]).toEqual([i, 200]);
    }
    expect((await t.app.inject({ method: "GET", url: "/pay/tokens" })).statusCode).toBe(200);
  });
});

describe("GET /pay/icons/chain/:code", () => {
  it("serves an offered network's picture as an SVG that cannot run anything, even if it is opened on its own", async () => {
    const t = await appWithIcons();
    const response = await t.app.inject({ method: "GET", url: "/pay/icons/chain/base" });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "image/svg+xml",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    expect(response.body).toBe(SVG());
  });

  it("is a 404 for a network that is not offered or has no image", async () => {
    const t = await appWithIcons();
    for (const code of ["aptos", "nowhere", "ltc"]) {
      expect([code, (await t.app.inject({ method: "GET", url: `/pay/icons/chain/${code}` })).statusCode]).toEqual([
        code,
        404,
      ]);
    }
    expect(t.fake.calls).toHaveLength(0);
  });
});

describe("GET /pay/tokens with images", () => {
  it("names each token's image by its lowercase symbol, and lists the networks that have one", async () => {
    const t = await appWithIcons();
    const body = (await t.app.inject({ method: "GET", url: "/pay/tokens" })).json();
    const usdc = body.chains.base.find((x: { symbol: string }) => x.symbol === "USDC");
    expect(usdc.icon).toBe("usdc");
    expect(body.chainIcons).toEqual(expect.arrayContaining(["base", "sol", "btc", "eth"]));
    expect(body.chainIcons.every((c: string) => body.enabledChains.includes(c))).toBe(true);
  });

  it("names each token's image from the explorer's table, so a wrapped token shows the token it wraps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tilll-icons-"));
    dirs.push(dir);
    const wnear = TOKENS.find((x) => x.symbol === "wNEAR" && x.blockchain === "near")!;
    const frax = TOKENS.find((x) => x.symbol === "FRAX")!;
    const assetIcons = { [wnear.assetId]: "near.png", [frax.assetId]: null };
    const fake = fakeExplorer();
    const icons = createIconService({ dir, assetIcons, tokens: { get: async () => TOKENS }, fetch: fake.fetcher });
    const t = await makeApp({ icons });
    const body = (await t.app.inject({ method: "GET", url: "/pay/tokens" })).json();
    expect(body.chains.near.find((x: { symbol: string }) => x.symbol === "wNEAR").icon).toBe("near");
    expect(body.chains.near.find((x: { symbol: string }) => x.symbol === "FRAX")).not.toHaveProperty("icon");
    const image = await t.app.inject({ method: "GET", url: "/pay/icons/token/near" });
    expect(image.statusCode).toBe(200);
    expect(fake.urls()).toEqual(["https://explorer.near-intents.org/icons/token/near.png"]);
  });

  it("is unchanged when no image service is wired in", async () => {
    const t = await makeApp();
    const body = (await t.app.inject({ method: "GET", url: "/pay/tokens" })).json();
    expect(body).not.toHaveProperty("chainIcons");
    expect(JSON.stringify(body.chains)).not.toContain('"icon"');
  });
});
