import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSessionManager,
  parseCookies,
  sessionCookie,
} from "../src/auth/session.js";

const SECRET = "sk_test_secret";
const START = new Date("2026-11-08T10:00:00.000Z");
const HOUR = 3_600_000;

function manager(secret = SECRET, ttlMs?: number) {
  let time = START.getTime();
  const m = createSessionManager(secret, { now: () => new Date(time), ...(ttlMs ? { ttlMs } : {}) });
  return { m, advance: (ms: number) => void (time += ms) };
}

describe("sessions", () => {
  it("accepts a token it made, until it expires", () => {
    const { m, advance } = manager(SECRET, 2 * HOUR);
    const { token, maxAgeSeconds } = m.create();
    expect(maxAgeSeconds).toBe(7200);

    expect(m.verify(token)).toBeDefined();
    advance(2 * HOUR - 1);
    expect(m.verify(token)).toBeDefined();
    advance(1);
    expect(m.verify(token)).toBeUndefined();
  });

  it("makes a different token every time", () => {
    const { m } = manager();
    expect(m.create().token).not.toBe(m.create().token);
  });

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["garbage", "not-a-token"],
    ["a token with a part missing", "v1.1.2"],
  ])("rejects %s", (_name, token) => {
    expect(manager().m.verify(token)).toBeUndefined();
  });

  it("rejects a token whose expiry was moved later", () => {
    const { m } = manager(SECRET, HOUR);
    const [version, expires, nonce, mac] = m.create().token.split(".");
    const forged = [version, String(Number(expires) + 100 * HOUR), nonce, mac].join(".");
    expect(m.verify(forged)).toBeUndefined();
  });

  it("rejects a token with a changed signature", () => {
    const { m } = manager();
    const token = m.create().token;
    const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(m.verify(flipped)).toBeUndefined();
  });

  it("rejects a token made with another merchant secret, so changing the secret ends every session", () => {
    const { token } = manager("sk_other").m.create();
    expect(manager().m.verify(token)).toBeUndefined();
  });

  it("derives a CSRF token from the session: stable for it, different for another, useless without the secret", () => {
    const { m } = manager();
    const a = m.create().token;
    const b = m.create().token;
    expect(m.verify(a)!.csrf).toBe(m.verify(a)!.csrf);
    expect(m.verify(a)!.csrf).not.toBe(m.verify(b)!.csrf);
    expect(m.verify(a)!.csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain(m.verify(a)!.csrf); // nothing in the cookie reveals it
  });
});

describe("cookies", () => {
  it("sets an HttpOnly, SameSite=Strict cookie for the whole site, expiring with the session", () => {
    const header = sessionCookie("TOKEN", 3600, { secure: false });
    expect(header).toBe(`${SESSION_COOKIE}=TOKEN; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict`);
  });

  it("adds Secure when the site is served over https", () => {
    expect(sessionCookie("TOKEN", 3600, { secure: true })).toMatch(/; Secure$/);
  });

  it("clears the cookie with the same attributes", () => {
    expect(clearSessionCookie({ secure: false })).toBe(
      `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`,
    );
  });

  it("reads cookies out of a Cookie header", () => {
    expect(parseCookies("a=1; tilll_session=abc.def; b=two=2")).toEqual({
      a: "1",
      tilll_session: "abc.def",
      b: "two=2",
    });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("garbage")).toEqual({});
  });
});
