import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function publicDirWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "tilll-public-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("GET /checkout.js", () => {
  it("serves the built widget as JavaScript with a short cache lifetime", async () => {
    const t = await makeApp({ publicDir: publicDirWith({ "checkout.js": "window.Tilll={open(){}};" }) });
    const res = await t.app.inject({ method: "GET", url: "/checkout.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toBe("window.Tilll={open(){}};");
  });

  it("says how to build it when it has not been built", async () => {
    const t = await makeApp({ publicDir: publicDirWith({}) });
    const res = await t.app.inject({ method: "GET", url: "/checkout.js" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("widget_not_built");
    expect(res.json().error.message).toContain("pnpm build:widget");
  });
});

describe("GET /pay/:invoiceId (hosted checkout page)", () => {
  const ID = "inv_01M6NENWVJEP82SZM993TYGJD9";

  it("is an HTML page that mounts the widget inline for that invoice, with no inline script", async () => {
    const t = await makeApp();
    const res = await t.app.inject({ method: "GET", url: `/pay/${ID}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.body).toContain(`data-tilll-inline="${ID}"`);
    expect(res.body).toContain('<script src="/checkout.js"></script>');
    expect(res.body).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(res.body).toContain("<noscript>");
  });

  it("sends a strict content security policy and privacy headers", async () => {
    const t = await makeApp();
    const res = await t.app.inject({ method: "GET", url: `/pay/${ID}` });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it.each(["inv_short", "nope", "inv_01M6NENWVJEP82SZM993TYGJD9<script>", "INV_01M6NENWVJEP82SZM993TYGJD9"])(
    "never echoes %j: anything that is not an invoice id is a 404",
    async (bad) => {
      const t = await makeApp();
      const res = await t.app.inject({ method: "GET", url: `/pay/${encodeURIComponent(bad)}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
      expect(res.body).not.toContain("script");
    },
  );

  it("does not shadow the JSON routes under /pay", async () => {
    const t = await makeApp();
    expect((await t.app.inject({ method: "GET", url: "/pay/tokens" })).headers["content-type"]).toMatch(/json/);
  });
});
