import type {
  QuoteRequest,
  QuoteResponse,
  StatusResponse,
  SwapDetails,
  SwapStatus,
  Token,
} from "../../src/oneclick/types.js";
import quoteFixture from "../fixtures/quote-dry-exact-output.json" with { type: "json" };
import tokensFixture from "../fixtures/tokens.json" with { type: "json" };

export const TOKENS = tokensFixture as Token[];
export const START = new Date("2026-11-05T10:00:00.000Z");
/** A well-formed EVM address for tests that go through refund-address validation. */
export const REFUND_ADDRESS = "0x1111111111111111111111111111111111111111";
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export const tokenById = (assetId: string): Token => {
  const t = TOKENS.find((x) => x.assetId === assetId);
  if (!t) throw new Error(`fixture has no ${assetId}`);
  return t;
};

const addressInactiveAt = (requestedDeadline: string) =>
  new Date(Date.parse(requestedDeadline) + 3 * 24 * 60 * 60_000).toISOString();

/** A non-dry quote response for `req`, with a unique deposit address, as 1Click would return it. */
export function quoteResponseFor(req: QuoteRequest, n: number, extra: { depositMemo?: string } = {}): QuoteResponse {
  const base = quoteFixture as unknown as QuoteResponse;
  return {
    ...base,
    correlationId: `corr-${n}`,
    signature: `ed25519:SIG${n}`,
    quoteRequest: { ...base.quoteRequest, ...req },
    quote: {
      ...base.quote,
      depositAddress: `0xDEPOSIT${n}`,
      // Observed live: 1Click returns these 3 days after the deadline we ask for. They say when the deposit
      // address goes inactive, not when the payer should pay by.
      deadline: addressInactiveAt(req.deadline),
      timeWhenInactive: addressInactiveAt(req.deadline),
      ...(extra.depositMemo ? { depositMemo: extra.depositMemo } : {}),
    },
  };
}

/** A /v0/status response for a stored quote. */
export function statusResponseFor(
  quote: QuoteResponse,
  status: SwapStatus,
  swapDetails: SwapDetails = {},
): StatusResponse {
  return { correlationId: "status-corr", quoteResponse: quote, status, updatedAt: START.toISOString(), swapDetails };
}
