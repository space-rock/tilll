import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app.js";
import { makeDemoApp } from "./helpers/liveDemo.js";

/** A stand-in for `site/dist`: two pages, one hashed asset, one loose file. */
function builtSite() {
  const dir = mkdtempSync(join(tmpdir(), "tilll-site-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Landing</title>");
  writeFileSync(join(dir, "docs.html"), "<!doctype html><title>Docs</title>");
  writeFileSync(join(dir, "assets", "site-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "site-abc123.css"), "body{}");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dir, "secret.html"), "<title>Not a listed page</title>");
  return dir;
}
const get = (t: Awaited<ReturnType<typeof makeApp>>, url: string) => t.app.inject({ method: "GET", url });

describe("the live demo's project site", () => {
  it("serves the landing page at / and the docs at /docs and /docs.html", async () => {
    const t = await makeDemoApp({ siteDir: builtSite() });
    for (const [url, title] of [
      ["/", "Landing"],
      ["/docs", "Docs"],
      ["/docs.html", "Docs"],
    ] as const) {
      const res = await get(t, url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain(title);
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("serves the landing page when the link carries a query string", async () => {
    const t = await makeDemoApp({ siteDir: builtSite() });
    const res = await get(t, "/?ref=somewhere");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Landing");
  });

  it("sends pages with a policy that loads only from itself and forbids framing", async () => {
    const t = await makeDemoApp({ siteDir: builtSite() });
    const res = await get(t, "/");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves built assets with the right type, kept for good because their names carry a hash", async () => {
    const t = await makeDemoApp({ siteDir: builtSite() });
    const js = await get(t, "/assets/site-abc123.js");
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.headers["cache-control"]).toContain("immutable");
    expect((await get(t, "/assets/site-abc123.css")).headers["content-type"]).toMatch(/css/);
    expect((await get(t, "/favicon.svg")).headers["content-type"]).toBe("image/svg+xml");
  });

  it("serves nothing outside the built site, and no page it did not list", async () => {
    const t = await makeDemoApp({ siteDir: builtSite() });
    for (const url of [
      "/assets/../index.html",
      "/assets/%2e%2e/index.html",
      "/assets/missing.js",
      "/secret.html",
      "/nope",
    ]) {
      const res = await get(t, url);
      expect([url, res.statusCode]).toEqual([url, 404]);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("leaves the checkout, the dashboard and the API where they are", async () => {
    const t = await makeDemoApp({ siteDir: builtSite() });
    expect((await get(t, "/checkout.js")).statusCode).toBe(200);
    expect((await get(t, "/dashboard")).statusCode).not.toBe(404);
    expect((await get(t, "/v1/balance")).statusCode).toBe(401);
    expect((await get(t, "/pay/tokens")).statusCode).toBe(200);
  });

  it("answers with a 404 instead of failing when the site was never built", async () => {
    const t = await makeDemoApp({ siteDir: join(tmpdir(), "tilll-no-such-site") });
    expect((await get(t, "/")).statusCode).toBe(404);
  });
});
