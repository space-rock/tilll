import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A built dashboard in a temporary folder, with a file outside it that must never be served. */
function built() {
  const root = mkdtempSync(join(tmpdir(), "tilll-dash-"));
  dirs.push(root);
  const dir = join(root, "dashboard");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><div id="root"></div><script type="module" src="/dashboard/assets/app-1.js"></script>',
  );
  writeFileSync(join(dir, "assets", "app-1.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "app-1.css"), "body{color:red}");
  writeFileSync(join(root, "secret.txt"), "TOP SECRET");
  return dir;
}

describe("serving the built dashboard", () => {
  it("serves the app at /dashboard, with a strict policy and no caching", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(response.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect(response.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toContain('id="root"');
  });

  it("serves the same page for the dashboard's own routes", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    for (const url of ["/dashboard/", "/dashboard/invoices", "/dashboard/invoices/inv_123", "/dashboard/webhooks"]) {
      const response = await app.inject({ method: "GET", url });
      expect([url, response.statusCode, response.body.includes('id="root"')]).toEqual([url, 200, true]);
    }
  });

  it("serves assets with their type and long caching", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const js = await app.inject({ method: "GET", url: "/dashboard/assets/app-1.js" });
    expect(js.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.body).toBe("console.log('app')");
    const css = await app.inject({ method: "GET", url: "/dashboard/assets/app-1.css" });
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("answers 404 for a missing file, rather than the app", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    const response = await app.inject({ method: "GET", url: "/dashboard/assets/missing.js" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it.each([
    "/dashboard/..%2fsecret.txt",
    "/dashboard/%2e%2e/secret.txt",
    "/dashboard/assets/..%2f..%2fsecret.txt",
    "/dashboard/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/dashboard/..%5csecret.txt",
    "/dashboard/%00",
  ])("never serves a file outside the dashboard folder: %s", async (url) => {
    const { app } = await makeApp({ dashboardDir: built() });
    const response = await app.inject({ method: "GET", url });
    expect(response.body).not.toContain("TOP SECRET");
    expect(response.statusCode).not.toBe(500);
  });

  it("says how to build it when it is missing", async () => {
    const { app } = await makeApp({ dashboardDir: join(tmpdir(), "tilll-no-such-dashboard") });
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: "dashboard_not_built",
      message: expect.stringContaining("pnpm build:dashboard"),
    });
  });

  it("needs no login to load the app (the app asks for one), but the API behind it does", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    expect((await app.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/invoices" })).statusCode).toBe(401);
  });

  it("answers an unknown dashboard API path with a JSON 404, not with the app (which a typo in a script would read as success)", async () => {
    const { app } = await makeApp({ dashboardDir: built() });
    for (const url of ["/dashboard/api/nope", "/dashboard/api", "/dashboard/api/session/extra"]) {
      const response = await app.inject({ method: "GET", url });
      expect([
        url,
        response.statusCode,
        response.headers["content-type"]?.toString().startsWith("application/json"),
      ]).toEqual([url, 404, true]);
      expect(response.body).not.toContain('id="root"');
    }
  });
});
