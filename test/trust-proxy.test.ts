import { describe, expect, it } from "vitest";
import { SECRET, makeApp } from "./helpers/app.js";

type App = Awaited<ReturnType<typeof makeApp>>["app"];

const TINY = { max: 2, timeWindow: "1 minute" };
const PROXY = "10.0.0.5";

/** One request to a rate-limited public route, as the reverse proxy would send it for a visitor. */
const visit = (app: App, forwardedFor: string | undefined, from = PROXY) =>
  app.inject({
    method: "GET",
    url: "/pay/tokens",
    remoteAddress: from,
    ...(forwardedFor ? { headers: { "x-forwarded-for": forwardedFor } } : {}),
  });

const login = (app: App, forwardedFor: string | undefined, secret = "wrong", from = PROXY) =>
  app.inject({
    method: "POST",
    url: "/dashboard/api/login",
    payload: { secret },
    remoteAddress: from,
    ...(forwardedFor ? { headers: { "x-forwarded-for": forwardedFor } } : {}),
  });

describe("rate limits behind a reverse proxy", () => {
  it("without TRUST_PROXY every visitor counts as the proxy: one visitor uses up everyone's budget (why the setting exists)", async () => {
    const { app } = await makeApp({ rateLimit: TINY });
    expect((await visit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await visit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await visit(app, "198.51.100.9")).statusCode).toBe(429);
  });

  it("with one trusted hop, each visitor has a budget of their own", async () => {
    const { app } = await makeApp({ rateLimit: TINY, trustProxy: 1 });
    expect((await visit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await visit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await visit(app, "203.0.113.1")).statusCode).toBe(429);
    expect((await visit(app, "198.51.100.9")).statusCode).toBe(200);
  });

  it("limits each visitor's login tries separately, so one person cannot lock the merchant out", async () => {
    const { app } = await makeApp({ trustProxy: 1 });
    for (let i = 0; i < 10; i++) expect((await login(app, "203.0.113.1")).statusCode).toBe(401);
    expect((await login(app, "203.0.113.1")).statusCode).toBe(429);
    expect((await login(app, "198.51.100.9", SECRET)).statusCode).toBe(200);
  });

  it("does not let a visitor choose their own address by adding to X-Forwarded-For: the proxy's entry is the one used", async () => {
    const { app } = await makeApp({ rateLimit: TINY, trustProxy: 1 });
    // the proxy appends the address it really saw; whatever the visitor put first is ignored
    for (const fake of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      const response = await visit(app, `${fake}, 203.0.113.1`);
      expect([fake, response.statusCode === 429]).toEqual([fake, fake === "3.3.3.3"]);
    }
  });

  it("with a list of trusted proxies, believes X-Forwarded-For only from them", async () => {
    const { app } = await makeApp({ rateLimit: TINY, trustProxy: ["10.0.0.0/8"] });
    // from the proxy: believed, so visitors are told apart
    expect((await visit(app, "203.0.113.1", "10.1.2.3")).statusCode).toBe(200);
    expect((await visit(app, "203.0.113.1", "10.1.2.3")).statusCode).toBe(200);
    expect((await visit(app, "198.51.100.9", "10.1.2.3")).statusCode).toBe(200);
    // from anyone else: ignored, so a visitor who reaches Tilll directly cannot pretend to be many
    const direct = "192.0.2.77";
    expect((await visit(app, "7.7.7.1", direct)).statusCode).toBe(200);
    expect((await visit(app, "7.7.7.2", direct)).statusCode).toBe(200);
    expect((await visit(app, "7.7.7.3", direct)).statusCode).toBe(429);
  });

  it("works the same for a request with no forwarding header", async () => {
    const { app } = await makeApp({ rateLimit: TINY, trustProxy: 1 });
    expect((await visit(app, undefined)).statusCode).toBe(200);
    expect((await visit(app, undefined)).statusCode).toBe(200);
    expect((await visit(app, undefined)).statusCode).toBe(429);
  });
});

const post = async (app: App, headers: Record<string, string>) => {
  const loggedIn = await app.inject({
    method: "POST",
    url: "/dashboard/api/login",
    payload: { secret: SECRET },
    remoteAddress: PROXY,
  });
  const cookie = String(loggedIn.headers["set-cookie"]).split(";")[0]!;
  return app.inject({
    method: "POST",
    url: "/v1/invoices",
    payload: { amount: "5.00" },
    remoteAddress: PROXY,
    headers: { cookie, "x-csrf-token": loggedIn.json().csrfToken, ...headers },
  });
};

describe("the dashboard's same-site check behind a reverse proxy", () => {
  it("accepts the public host the proxy reports, when the proxy is trusted and rewrites Host", async () => {
    const { app } = await makeApp({ trustProxy: 1 });
    const response = await post(app, {
      host: "tilll:8080",
      "x-forwarded-host": "pay.example.com",
      origin: "https://pay.example.com",
    });
    expect(response.statusCode).toBe(201);
  });

  it("without TRUST_PROXY ignores X-Forwarded-Host, so a request cannot vouch for itself", async () => {
    const { app } = await makeApp();
    const response = await post(app, {
      host: "tilll:8080",
      "x-forwarded-host": "evil.example",
      origin: "https://evil.example",
    });
    expect([response.statusCode, response.json().error.code]).toEqual([403, "csrf_failed"]);
  });

  it("still refuses another site's origin when the proxy is trusted", async () => {
    const { app } = await makeApp({ trustProxy: 1 });
    const response = await post(app, {
      host: "tilll:8080",
      "x-forwarded-host": "pay.example.com",
      origin: "https://evil.example",
    });
    expect([response.statusCode, response.json().error.code]).toEqual([403, "csrf_failed"]);
  });
});
