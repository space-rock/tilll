import { describe, expect, it } from "vitest";
import { DryQuoteError, UsageError, formatQuote, parseArgs, runDryQuote } from "../src/dryQuote.js";
import { SettlementAssetError, createTokenCache } from "../src/oneclick/tokens.js";
import type { QuoteRequest, QuoteResponse, Token } from "../src/oneclick/types.js";
import quoteFixture from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "./fixtures/tokens.json" with { type: "json" };

describe("dry-quote parseArgs", () => {
  it("reads --from and --amount", () => {
    expect(parseArgs(["--from", "base:USDC", "--amount", "5"])).toEqual({ from: "base:USDC", amount: "5" });
  });

  it("ignores a bare -- that package managers forward (pnpm run dry-quote -- --from ...)", () => {
    expect(parseArgs(["--", "--from", "base:USDC", "--amount", "5"])).toEqual({ from: "base:USDC", amount: "5" });
  });

  it("accepts --flag=value and the optional --refund-to / --recipient", () => {
    expect(parseArgs(["--from=sol:SOL", "--amount=12.5", "--refund-to=9xQe", "--recipient", "shop-pay.near"])).toEqual({
      from: "sol:SOL",
      amount: "12.5",
      refundTo: "9xQe",
      recipient: "shop-pay.near",
    });
  });

  it.each([
    [[], /--from/],
    [["--from", "base:USDC"], /--amount/],
    [["--amount", "5"], /--from/],
    [["--from", "base:USDC", "--amount"], /--amount.*needs a value/i],
    [["--from", "base:USDC", "--amount", "5", "--bogus", "1"], /unknown option --bogus/i],
    [["--from", "base:USDC", "--amount", "5", "stray"], /unexpected argument "stray"/i],
  ])("rejects %j with a usage hint", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
    expect(() => parseArgs(argv)).toThrow(/Usage:/);
  });

  it("has no option that could switch off dry mode", () => {
    for (const flag of ["--no-dry", "--dry=false", "--dry", "--live"]) {
      expect(() => parseArgs(["--from", "base:USDC", "--amount", "5", flag])).toThrow(/unknown option/i);
    }
  });
});

const TOKENS = tokensFixture as Token[];
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const NOW = new Date("2026-11-05T10:00:00.000Z");

function deps(extra: { settlementAssetId?: string } = {}) {
  const requests: QuoteRequest[] = [];
  return {
    requests,
    deps: {
      client: {
        quote: async (req: QuoteRequest) => {
          requests.push(req);
          return quoteFixture as unknown as QuoteResponse;
        },
      },
      tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
      now: NOW,
      ...extra,
    },
  };
}

describe("runDryQuote", () => {
  it("quotes base:USDC for a 5 USDC invoice, always with dry: true", async () => {
    const { requests, deps: d } = deps();

    const result = await runDryQuote({ from: "base:USDC", amount: "5" }, d);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      dry: true,
      swapType: "EXACT_OUTPUT",
      originAsset: USDC_BASE,
      destinationAsset: USDC_NEAR,
      amount: "5000000",
      refundTo: "0x0000000000000000000000000000000000000001",
      recipient: "example.near",
      recipientType: "INTENTS",
      slippageTolerance: 100,
    });
    expect(result.response.quote.amountIn).toBe("5051529");
    expect(result.origin.symbol).toBe("USDC");
    expect(result.settlement.assetId).toBe(USDC_NEAR);
  });

  it("uses --refund-to and --recipient when given", async () => {
    const { requests, deps: d } = deps();
    await runDryQuote({ from: "base:USDC", amount: "5", refundTo: "0xabc", recipient: "shop-pay.near" }, d);
    expect(requests[0]).toMatchObject({ refundTo: "0xabc", recipient: "shop-pay.near", dry: true });
  });

  it("converts the amount with the settlement asset's decimals and rejects extra precision", async () => {
    const { requests, deps: d } = deps();
    await runDryQuote({ from: "base:USDC", amount: "0.01" }, d);
    expect(requests[0]!.amount).toBe("10000");
    await expect(runDryQuote({ from: "base:USDC", amount: "5.1234567" }, d)).rejects.toThrow(/at most 6 decimal/);
  });

  it("accepts a full 1Click asset id for --from", async () => {
    const { requests, deps: d } = deps();
    await runDryQuote({ from: USDC_BASE, amount: "5" }, d);
    expect(requests[0]!.originAsset).toBe(USDC_BASE);
  });

  it("validates an explicit settlement asset against the token list", async () => {
    const { deps: d } = deps({ settlementAssetId: "nep141:usdc.typo.near" });
    await expect(runDryQuote({ from: "base:USDC", amount: "5" }, d)).rejects.toBeInstanceOf(SettlementAssetError);
  });

  it("explains an unknown chain by listing the chains 1Click supports", async () => {
    const { requests, deps: d } = deps();
    const err = await runDryQuote({ from: "nowhere:USDC", amount: "5" }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DryQuoteError);
    expect((err as Error).message).toMatch(/nowhere/);
    expect((err as Error).message).toMatch(/base/);
    expect(requests).toHaveLength(0);
  });

  it("explains an unknown symbol by listing the symbols on that chain", async () => {
    const { deps: d } = deps();
    const err = await runDryQuote({ from: "base:NOPE", amount: "5" }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DryQuoteError);
    expect((err as Error).message).toMatch(/NOPE/);
    expect((err as Error).message).toMatch(/USDC/);
  });

  it("refuses an ambiguous route and lists the asset ids to choose from", async () => {
    const { requests, deps: d } = deps();
    const err = await runDryQuote({ from: "hypercore:USDC", amount: "5" }, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DryQuoteError);
    expect((err as Error).message).toMatch(/more than one/i);
    expect((err as Error).message).toContain("1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054");
    expect(requests).toHaveLength(0);
  });

  it("rejects a --from that is neither an asset id nor chain:SYMBOL", async () => {
    const { deps: d } = deps();
    await expect(runDryQuote({ from: "usdc", amount: "5" }, d)).rejects.toThrow(/<chain>:<SYMBOL>/);
  });
});

async function report() {
  const { deps: d } = deps();
  return formatQuote(await runDryQuote({ from: "base:USDC", amount: "5" }, d));
}

describe("formatQuote", () => {
  it("says it was a dry run that created no deposit address", async () => {
    expect(await report()).toMatch(/dry run/i);
    expect(await report()).toMatch(/no deposit address/i);
  });

  it("shows the route, what the merchant gets and what the payer sends, in display units", async () => {
    const text = await report();
    expect(text).toMatch(/USDC on base\s*->\s*USDC on near/);
    expect(text).toMatch(/merchant receives\s+5 USDC/i);
    expect(text).toMatch(/payer sends\s+5\.051529 USDC/i);
    expect(text).toMatch(/minimum\s+5\.001013 USDC/i);
    expect(text).toContain("$5.0507");
  });

  it("shows time estimate and the raw fee fields 1Click returned", async () => {
    const text = await report();
    expect(text).toMatch(/35 s/);
    expect(text).toMatch(/refundFee\s+2400/);
    expect(text).toMatch(/withdrawFee\s+0/);
  });

  it("surfaces appFees that 1Click echoed back, so the real fee is visible", async () => {
    expect(await report()).toMatch(/appFees.*1 bps/i);
  });

  it("includes the quote signature and correlation id for dispute proof", async () => {
    const text = await report();
    expect(text).toContain("ab73c4b1-d9cd-49bc-b552-fddfc8eb0757");
    expect(text).toContain(
      "ed25519:3j1xNTk17iTy7DuDHqGxz8fMgTt7RSyq4gBZQpuSZPCPRUfJdVjvoctBdw43Uz5YWvPEv9dFGgtKn75g82eqS8QB",
    );
  });
});
