import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardCsp } from "../src/routes/dashboard.js";
import { makeApp } from "./helpers/app.js";

const ID = "inv_01M6NENWVJEP82SZM993TYGJD9";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function built() {
  const root = mkdtempSync(join(tmpdir(), "tilll-csp-"));
  dirs.push(root);
  const dir = join(root, "dashboard");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, "assets", "app-1.js"), "console.log('app')");
  return dir;
}

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));

/**
 * The dashboard is the one page that holds a wallet connector. Its policy is looser than the other pages' in exactly
 * four places (a nonce, wide connections, wallet logos, wallet frames), and nowhere else.
 */
describe("the dashboard's Content-Security-Policy", () => {
  it("allows a script nonce, https connections, https images and https frames, for the wallet connector", () => {
    const csp = dashboardCsp("abc123==");
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123=='");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' https:");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: https:");
    expect(directive(csp, "frame-src")).toBe("frame-src https:");
  });

  it("is otherwise as strict as before: nothing by default, no inline or eval script, no framing, no forms", () => {
    const csp = dashboardCsp("n");
    expect(directive(csp, "default-src")).toBe("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(directive(csp, "script-src")).not.toMatch(/unsafe-inline|https?:|\*/);
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "form-action")).toBe("form-action 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
  });

  it("has no nonce when none is given", () => {
    expect(dashboardCsp()).not.toMatch(/nonce/);
  });

  it("is sent with a fresh nonce on every page response, and the same nonce is in the page for the wallet code to use", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const nonces: string[] = [];
    for (const url of ["/dashboard", "/dashboard", "/dashboard/invoices"]) {
      const response = await app.inject({ method: "GET", url });
      const csp = String(response.headers["content-security-policy"]);
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
      expect([url, nonce !== undefined]).toEqual([url, true]);
      expect(nonce!.length).toBeGreaterThanOrEqual(22); // 128 bits
      expect(response.body).toContain(`<meta name="csp-nonce" content="${nonce}" />`);
      nonces.push(nonce!);
    }
    expect(new Set(nonces).size).toBe(3);
  });

  it("sends the page uncached, so no nonce is ever served twice", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("does not put a nonce in the files the page loads, which are cached", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const response = await app.inject({ method: "GET", url: "/dashboard/assets/app-1.js" });
    expect(String(response.headers["content-security-policy"])).not.toMatch(/nonce/);
    expect(response.body).not.toMatch(/csp-nonce/);
  });

  it("is not given to the pay page or the checkout, which keep their own strict policies", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const response = await app.inject({ method: "GET", url: `/pay/${ID}` });
    const csp = String(response.headers["content-security-policy"] ?? "");
    expect(csp).not.toMatch(/nonce|https:/);
    expect(csp).toContain("connect-src 'self'");
  });
});
