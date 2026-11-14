import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { SECRET, makeApp } from "./helpers/app.js";

type App = Awaited<ReturnType<typeof makeApp>>["app"];

const login = (app: App, secret: string = SECRET, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/dashboard/api/login", payload: { secret }, headers });

/** Log in and return the cookie header to send back and the CSRF token. */
async function session(app: App) {
  const response = await login(app);
  const setCookie = String(response.headers["set-cookie"]);
  const cookie = setCookie.split(";")[0]!;
  return { cookie, csrf: response.json().csrfToken as string, setCookie };
}

describe("logging in to the dashboard", () => {
  it("sets an HttpOnly, SameSite=Strict session cookie and hands the page its CSRF token", async () => {
    const { app } = await makeApp();
    const response = await login(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().csrfToken).toMatch(/^[0-9a-f]{64}$/);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toMatch(/Secure/); // the test server's public URL is http://localhost
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain(SECRET);
  });

  it("marks the cookie Secure when the site is served over https", async () => {
    const { app } = await makeApp({ publicBaseUrl: "https://pay.example.com" });
    expect(String((await login(app)).headers["set-cookie"])).toMatch(/; Secure$/);
  });

  it("follows a public URL changed in the settings: the next sign-in is Secure on https, and not on http", async () => {
    const { app, settings } = await makeApp();
    expect(String((await login(app)).headers["set-cookie"])).not.toMatch(/Secure/);
    await settings.update({ publicBaseUrl: "https://pay.example.com" });
    expect(String((await login(app)).headers["set-cookie"])).toMatch(/; Secure$/);
    await settings.update({ publicBaseUrl: "http://localhost:8080" });
    expect(String((await login(app)).headers["set-cookie"])).not.toMatch(/Secure/);
  });

  it.each([
    ["the wrong secret", { secret: "nope" }],
    ["an empty secret", { secret: "" }],
    ["no secret", {}],
    ["a secret that is not a string", { secret: 12 }],
  ])("refuses %s, sets no cookie, and says only that it was refused", async (_name, payload) => {
    const { app } = await makeApp();
    const response = await app.inject({ method: "POST", url: "/dashboard/api/login", payload });
    expect([400, 401]).toContain(response.statusCode);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(SECRET);
  });

  it("is limited to a few tries a minute per client, so the secret cannot be guessed", async () => {
    const { app } = await makeApp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await login(app, "wrong")).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // and the right secret is refused while limited, too
    expect((await login(app)).statusCode).toBe(429);
  });
});

describe("the session endpoint", () => {
  it("gives the CSRF token to a logged-in page and 401 to anyone else", async () => {
    const { app } = await makeApp();
    const { cookie, csrf } = await session(app);

    const ok = await app.inject({ method: "GET", url: "/dashboard/api/session", headers: { cookie } });
    expect(ok.json()).toEqual({ csrfToken: csrf });

    expect((await app.inject({ method: "GET", url: "/dashboard/api/session" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/dashboard/api/session",
          headers: { cookie: `${SESSION_COOKIE}=forged` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("logs out by clearing the cookie", async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: "POST", url: "/dashboard/api/logout" });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toMatch(/Max-Age=0/);
  });
});

describe("/v1 with a session cookie instead of the bearer secret", () => {
  it("answers a read", async () => {
    const { app } = await makeApp();
    const { cookie } = await session(app);
    const response = await app.inject({ method: "GET", url: "/v1/invoices", headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a forged or missing cookie", async () => {
    const { app } = await makeApp();
    expect(
      (await app.inject({ method: "GET", url: "/v1/invoices", headers: { cookie: `${SESSION_COOKIE}=forged` } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/invoices" })).statusCode).toBe(401);
  });

  it("refuses a write without the CSRF token, with a wrong one, and from another origin; accepts it with the right one", async () => {
    const { app } = await makeApp();
    const { cookie, csrf } = await session(app);
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        payload: { amount: "5.00" },
        headers: { cookie, host: "localhost:8080", ...headers },
      });

    for (const headers of [
      {} as Record<string, string>,
      { "x-csrf-token": "wrong" },
      { "x-csrf-token": "0".repeat(64) },
    ]) {
      const refused = await post(headers);
      expect([refused.statusCode, refused.json().error.code]).toEqual([403, "csrf_failed"]);
    }
    const crossOrigin = await post({ "x-csrf-token": csrf, origin: "https://evil.example" });
    expect([crossOrigin.statusCode, crossOrigin.json().error.code]).toEqual([403, "csrf_failed"]);

    const sameOrigin = await post({ "x-csrf-token": csrf, origin: "http://localhost:8080" });
    expect(sameOrigin.statusCode).toBe(201);
    const noOrigin = await post({ "x-csrf-token": csrf });
    expect(noOrigin.statusCode).toBe(201);
  });

  it("does not take another session's CSRF token", async () => {
    const { app } = await makeApp();
    const a = await session(app);
    const b = await session(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      payload: { amount: "5.00" },
      headers: { cookie: a.cookie, "x-csrf-token": b.csrf },
    });
    expect(response.statusCode).toBe(403);
  });

  it("needs no CSRF token with the bearer secret, which a browser never attaches by itself", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      payload: { amount: "5.00" },
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.statusCode).toBe(201);
  });

  it("does not fall back to a valid cookie when a wrong bearer secret is sent", async () => {
    const { app } = await makeApp();
    const { cookie } = await session(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: { cookie, authorization: "Bearer nope" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("ignores an Authorization header of another scheme (a proxy's Basic login, say) and uses the session cookie", async () => {
    const { app } = await makeApp();
    const { cookie } = await session(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: { cookie, authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.statusCode).toBe(200);
    const noCookie = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(noCookie.statusCode).toBe(401);
  });

  it("takes the Bearer scheme in any letter case, as HTTP does", async () => {
    const { app } = await makeApp();
    for (const scheme of ["bearer", "BEARER", "Bearer"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/invoices",
        headers: { authorization: `${scheme} ${SECRET}` },
      });
      expect([scheme, response.statusCode]).toEqual([scheme, 200]);
    }
    const empty = await app.inject({ method: "GET", url: "/v1/invoices", headers: { authorization: "Bearer " } });
    expect(empty.statusCode).toBe(401);
  });

  it("expires with the session", async () => {
    let time = Date.parse("2026-11-08T10:00:00.000Z");
    const { app } = await makeApp({ now: () => new Date(time) });
    const { cookie } = await session(app);
    time += 13 * 3_600_000;
    expect((await app.inject({ method: "GET", url: "/v1/invoices", headers: { cookie } })).statusCode).toBe(401);
  });
});
