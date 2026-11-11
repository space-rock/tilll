import { describe, expect, it } from "vitest";
import { paymentQuoteRequest, refundQuoteRequest } from "../src/oneclick/requests.js";
import type { Token } from "../src/oneclick/types.js";
import quoteFixture from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "./fixtures/tokens.json" with { type: "json" };

const TOKENS = tokensFixture as Token[];
const tokenOn = (blockchain: string, symbol: string) => {
  const t = TOKENS.find((x) => x.blockchain === blockchain && x.symbol === symbol);
  if (!t) throw new Error(`fixture has no ${symbol} on ${blockchain}`);
  return t;
};

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NOW = new Date("2026-11-05T10:00:00.000Z");

const baseInput = {
  dry: false,
  originAsset: tokenOn("base", "USDC"),
  invoiceAmount: "5000000",
  refundTo: "0x0000000000000000000000000000000000000001",
  settlementAssetId: USDC_NEAR,
  settlementAccountId: "shop-pay.near",
  slippageBps: 100,
  deadlineMinutes: 30,
  memoChains: ["stellar"],
  now: NOW,
};

describe("paymentQuoteRequest", () => {
  it("builds the PLAN section 8 EXACT_OUTPUT request settling into the Intents account", () => {
    expect(paymentQuoteRequest(baseInput)).toEqual({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_NEAR,
      amount: "5000000",
      refundTo: "0x0000000000000000000000000000000000000001",
      refundType: "ORIGIN_CHAIN",
      recipient: "shop-pay.near",
      recipientType: "INTENTS",
      deadline: "2026-11-05T10:30:00.000Z",
      depositMode: "SIMPLE",
      referral: "tilll",
    });
  });

  it("matches what the live API accepted in the recorded dry quote", () => {
    const {
      deadline: _deadline,
      referral,
      ...mine
    } = paymentQuoteRequest({
      ...baseInput,
      dry: true,
      settlementAccountId: "example.near",
    });
    expect(quoteFixture.quoteRequest).toMatchObject(mine);
    // Recorded data: the quote was requested before the project was renamed from Till to Tilll.
    expect(quoteFixture.quoteRequest.referral).toBe("till");
    expect(referral).toBe("tilll");
  });

  it.each(["btc", "ltc", "doge", "bch", "zec", "dash"])("gives %s a 120 minute deadline", (chain) => {
    const token = TOKENS.find((t) => t.blockchain === chain);
    expect(token, `fixture should list a token on ${chain}`).toBeDefined();
    const req = paymentQuoteRequest({ ...baseInput, originAsset: token! });
    expect(req.deadline).toBe("2026-11-05T12:00:00.000Z");
  });

  it("keeps a configured deadline longer than 120 minutes on slow chains", () => {
    const btc = TOKENS.find((t) => t.blockchain === "btc")!;
    const req = paymentQuoteRequest({ ...baseInput, originAsset: btc, deadlineMinutes: 180 });
    expect(req.deadline).toBe("2026-11-05T13:00:00.000Z");
  });

  it("does not stretch the deadline for fast chains", () => {
    expect(paymentQuoteRequest({ ...baseInput, deadlineMinutes: 45 }).deadline).toBe("2026-11-05T10:45:00.000Z");
  });

  it("uses MEMO deposit mode only for configured memo chains, case-insensitively", () => {
    const stellar = TOKENS.find((t) => t.blockchain === "stellar")!;
    expect(paymentQuoteRequest({ ...baseInput, originAsset: stellar }).depositMode).toBe("MEMO");
    expect(paymentQuoteRequest({ ...baseInput, originAsset: stellar, memoChains: ["Stellar"] }).depositMode).toBe(
      "MEMO",
    );
    expect(paymentQuoteRequest({ ...baseInput, originAsset: stellar, memoChains: [] }).depositMode).toBe("SIMPLE");
    expect(paymentQuoteRequest(baseInput).depositMode).toBe("SIMPLE");
  });

  it("lets an explicit depositMode override the memoChains guess, for retrying after 1Click disagrees", () => {
    const stellar = TOKENS.find((t) => t.blockchain === "stellar")!;
    expect(paymentQuoteRequest({ ...baseInput, originAsset: stellar, depositMode: "SIMPLE" }).depositMode).toBe(
      "SIMPLE",
    );
    expect(paymentQuoteRequest({ ...baseInput, depositMode: "MEMO" }).depositMode).toBe("MEMO");
  });

  it("passes the dry flag through unchanged", () => {
    expect(paymentQuoteRequest({ ...baseInput, dry: true }).dry).toBe(true);
    expect(paymentQuoteRequest({ ...baseInput, dry: false }).dry).toBe(false);
  });
});

describe("refundQuoteRequest", () => {
  const refundInput = {
    dry: true,
    settlementAssetId: USDC_NEAR,
    settlementAccountId: "shop-pay.near",
    destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    amount: "2500000",
    refundAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    slippageBps: 100,
    now: NOW,
  };

  it("builds the PLAN section 9 EXACT_INPUT request funded from the Intents balance", () => {
    expect(refundQuoteRequest(refundInput)).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: USDC_NEAR,
      depositType: "INTENTS",
      destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
      amount: "2500000",
      refundTo: "shop-pay.near",
      refundType: "INTENTS",
      recipient: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-05T10:30:00.000Z",
    });
  });

  it("passes the dry flag through, so preview and execute share one builder", () => {
    expect(refundQuoteRequest({ ...refundInput, dry: false }).dry).toBe(false);
  });
});
