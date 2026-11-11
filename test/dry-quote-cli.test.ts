import { describe, expect, it } from "vitest";
import { runCli } from "../src/dryQuote.js";
import quoteFixture from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "./fixtures/tokens.json" with { type: "json" };
import { fakeFetch, type RecordedCall } from "./helpers/fakeFetch.js";

const ARGS = ["--from", "base:USDC", "--amount", "5"];

function setup(
  quote: (call: RecordedCall) => { status?: number; body?: unknown } = () => ({ status: 201, body: quoteFixture }),
) {
  const out: string[] = [];
  const err: string[] = [];
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.endsWith("/v0/tokens")) return { body: tokensFixture };
    if (call.url.endsWith("/v0/quote")) return quote(call);
    return { status: 404, body: { message: "unexpected call" } };
  });
  const run = (argv: string[], env: Record<string, string | undefined> = {}) =>
    runCli(
      argv,
      env,
      { out: (s) => out.push(s), err: (s) => err.push(s) },
      { fetch, now: () => new Date("2026-11-05T10:00:00Z") },
    );
  return { run, out, err, calls };
}

describe("runCli", () => {
  it("prints the report and exits 0, asking 1Click for a dry quote only", async () => {
    const { run, out, err, calls } = setup();

    expect(await run(ARGS)).toBe(0);

    expect(out.join("\n")).toMatch(/Payer sends\s+5\.051529 USDC/);
    expect(err).toEqual([]);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v0/tokens", "/v0/quote"]);
    expect((calls[1]!.body as { dry: boolean }).dry).toBe(true);
    expect(calls[0]!.headers.has("x-api-key")).toBe(false);
  });

  it("sends ONECLICK_API_KEY when set but never prints it", async () => {
    const { run, out, err, calls } = setup();

    expect(await run(ARGS, { ONECLICK_API_KEY: "secret.jwt.value" })).toBe(0);

    expect(calls.every((c) => c.headers.get("x-api-key") === "secret.jwt.value")).toBe(true);
    expect([...out, ...err].join("\n")).not.toContain("secret.jwt.value");
  });

  it("uses SETTLEMENT_ASSET_ID from the environment, and rejects one that 1Click does not list", async () => {
    const good = setup();
    const usdc = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    expect(await good.run(ARGS, { SETTLEMENT_ASSET_ID: usdc })).toBe(0);
    expect((good.calls[1]!.body as { destinationAsset: string }).destinationAsset).toBe(usdc);

    const bad = setup();
    expect(await bad.run(ARGS, { SETTLEMENT_ASSET_ID: "nep141:usdc.typo.near" })).toBe(1);
    expect(bad.err.join("\n")).toContain("SETTLEMENT_ASSET_ID");
    expect(bad.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v0/tokens"]);
  });

  it("exits 2 with usage on bad arguments, without touching the network", async () => {
    const { run, err, calls } = setup();
    expect(await run(["--from", "base:USDC"])).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
    expect(calls).toHaveLength(0);
  });

  it("exits 1 on an unknown route and never requests a quote", async () => {
    const { run, err, calls } = setup();
    expect(await run(["--from", "nowhere:USDC", "--amount", "5"])).toBe(1);
    expect(err.join("\n")).toContain("nowhere");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v0/tokens"]);
  });

  it("exits 1 with the 1Click message, not a stack trace, when the quote is rejected", async () => {
    const { run, err } = setup(() => ({ status: 400, body: { message: "Amount is too low", correlationId: "c-1" } }));
    expect(await run(ARGS)).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("Amount is too low");
    expect(text).toContain("c-1");
    expect(text).not.toMatch(/\n\s+at /);
  });

  it("hints at --refund-to when 1Click rejects the placeholder refund address for a non-EVM chain", async () => {
    const { run, err } = setup(() => ({ status: 400, body: { message: "refundTo is not valid" } }));
    expect(await run(["--from", "sol:SOL", "--amount", "5"])).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("refundTo is not valid");
    expect(text).toMatch(/--refund-to/);
    expect(text).toMatch(/sol/);
  });

  it("does not add the refund hint to unrelated 1Click errors", async () => {
    const { run, err } = setup(() => ({ status: 400, body: { message: "Quoting for this pair is not available" } }));
    expect(await run(ARGS)).toBe(1);
    expect(err.join("\n")).not.toMatch(/--refund-to/);
  });

  it("exits 1 with a plain message when --amount has too many decimals", async () => {
    const { run, err, calls } = setup();
    expect(await run(["--from", "base:USDC", "--amount", "5.1234567"])).toBe(1);
    expect(err.join("\n")).toMatch(/at most 6 decimal/);
    expect(err.join("\n")).not.toMatch(/\n\s+at /);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v0/tokens"]);
  });

  it("exits 1 and names the variable when the environment is invalid", async () => {
    const { run, err, calls } = setup();
    expect(await run(ARGS, { ONECLICK_BASE_URL: "nope" })).toBe(1);
    expect(err.join("\n")).toContain("ONECLICK_BASE_URL");
    expect(calls).toHaveLength(0);
  });
});
