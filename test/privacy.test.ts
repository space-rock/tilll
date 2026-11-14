import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app.js";
import { REFUND_ADDRESS, USDC_BASE } from "./helpers/world.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The project site and the README say the checkout asks for no account, sets no cookie and keeps nothing in the
 * browser. These tests are what that claim rests on.
 */
describe("what the checkout leaves in a payer's browser", () => {
  it("sets no cookie on any page or call a payer makes", async () => {
    const publicDir = mkdtempSync(join(tmpdir(), "tilll-public-"));
    dirs.push(publicDir);
    writeFileSync(join(publicDir, "checkout.js"), "window.Tilll={};");
    const t = await makeApp({ publicDir });
    const invoice = t.service.createInvoice({ amount: "5", description: "Coffee" });

    const created = await t.app.inject({
      method: "POST",
      url: `/pay/invoices/${invoice.id}/attempts`,
      payload: { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS },
    });
    expect(created.statusCode).toBe(201);

    const urls = [
      "/checkout.js",
      `/pay/${invoice.id}`,
      "/pay/tokens",
      `/pay/invoices/${invoice.id}`,
      `/pay/attempts/${created.json().id}`,
    ];
    for (const url of urls) {
      const response = await t.app.inject({ method: "GET", url });
      expect([url, response.statusCode]).toEqual([url, 200]);
      expect([url, response.headers["set-cookie"]]).toEqual([url, undefined]);
    }
    expect(created.headers["set-cookie"]).toBeUndefined();
  });

  it("is code that never touches cookies or browser storage, and loads nothing from elsewhere", () => {
    const files = readdirSync(join(root, "widget", "src")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(join(root, "widget", "src", file), "utf8");
      // Comments may show an example address; code may not contain one.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const storage = /document\.cookie|localStorage|sessionStorage|indexedDB/.exec(code)?.[0];
      const elsewhere = /https?:\/\/(?!www\.w3\.org)[^\s"'`]*/.exec(code)?.[0];
      expect({ file, storage, elsewhere }).toEqual({ file, storage: undefined, elsewhere: undefined });
    }
  });

  it("is told by the hosted page's policy to talk only to the server it came from", async () => {
    const t = await makeApp();
    const response = await t.app.inject({ method: "GET", url: "/pay/inv_01M6NENWVJEP82SZM993TYGJD9" });
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    // Images come from the Tilll server too: its own copies, never the picture's original address.
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toMatch(/https?:/);
  });
});
