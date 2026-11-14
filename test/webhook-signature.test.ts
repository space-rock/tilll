import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "../src/webhooks/signature.js";

const SECRET = "whsec_test_secret";
const BODY = '{"id":"evt_1","type":"invoice.paid","data":{"invoice":{"id":"inv_1"}}}';
const T = 1_793_000_000;
const now = (seconds: number) => () => new Date(seconds * 1000);

describe("signPayload", () => {
  it("is t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<rawBody>'> exactly as PLAN section 13 says", () => {
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(signPayload(SECRET, T, BODY)).toBe(`t=${T},v1=${expected}`);
    expect(signPayload(SECRET, T, BODY)).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("changes with the secret, the timestamp and every byte of the body", () => {
    const base = signPayload(SECRET, T, BODY);
    expect(signPayload("other", T, BODY)).not.toBe(base);
    expect(signPayload(SECRET, T + 1, BODY)).not.toBe(base);
    expect(signPayload(SECRET, T, `${BODY} `)).not.toBe(base);
  });

  it("signs the bytes, so non-ASCII bodies are signed as UTF-8", () => {
    const body = '{"description":"café ☕"}';
    const expected = createHmac("sha256", SECRET)
      .update(Buffer.from(`${T}.${body}`, "utf8"))
      .digest("hex");
    expect(signPayload(SECRET, T, body)).toBe(`t=${T},v1=${expected}`);
  });
});

describe("verifySignature", () => {
  const header = signPayload(SECRET, T, BODY);

  it("accepts a fresh, correctly signed body", () => {
    expect(verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T + 5) })).toEqual({
      ok: true,
      timestamp: T,
    });
  });

  it.each([
    ["a tampered body", { rawBody: `${BODY} ` }, /does not match/],
    ["the wrong secret", { secret: "whsec_other" }, /does not match/],
    [
      "a body signed for a different timestamp",
      { header: `t=${T + 1},v1=${header.split("v1=")[1]}` },
      /does not match/,
    ],
  ])("rejects %s", (_name, override, reason) => {
    const result = verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T), ...override });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(reason);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["no timestamp", "v1=abc"],
    ["no signature", `t=${T}`],
    ["a non-numeric timestamp", "t=yesterday,v1=abc"],
    ["a signature that is not hex", `t=${T},v1=not-hex`],
    ["a signature of the wrong length", `t=${T},v1=abcd`],
  ])("rejects a header that is %s", (_name, bad) => {
    const result = verifySignature({ secret: SECRET, header: bad, rawBody: BODY, now: now(T) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/malformed|missing/i);
  });

  it("rejects a replay older than the tolerance, and a timestamp from the future", () => {
    expect(verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T + 301) })).toMatchObject({ ok: false });
    expect(verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T + 300) })).toMatchObject({ ok: true });
    expect(verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T - 301) })).toMatchObject({ ok: false });
  });

  it("lets the receiver choose the tolerance", () => {
    expect(
      verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T + 60), toleranceSeconds: 30 }),
    ).toMatchObject({ ok: false });
    expect(
      verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T + 60), toleranceSeconds: 120 }),
    ).toMatchObject({ ok: true });
  });

  it("explains a stale timestamp differently from a bad signature", () => {
    const result = verifySignature({ secret: SECRET, header, rawBody: BODY, now: now(T + 1000) });
    expect(!result.ok && result.reason).toMatch(/too old|clock/i);
  });

  it("does not throw on hostile input", () => {
    for (const bad of ["t=1,v1=" + "z".repeat(10_000), "t=" + "9".repeat(400) + ",v1=ab", ",,,", "t=1,v1=,v1="]) {
      expect(() => verifySignature({ secret: SECRET, header: bad, rawBody: BODY, now: now(T) })).not.toThrow();
    }
  });
});
