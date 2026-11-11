import { createHash } from "node:crypto";
import { base58Encode, verifyEd25519 } from "../near/keys.js";
import type { EventProof } from "../events.js";
import type { QuoteResponse } from "./types.js";

/**
 * 1Click's public key for quote signatures: the "manager" key published in its TypeScript SDK
 * (`@defuse-protocol/one-click-sdk-typescript`, `verifyQuoteSignature`). A quote recorded live from the real API
 * verifies against it (`test/quote-signature.test.ts`), which checks the key and the scheme below against real data.
 */
export const ONE_CLICK_PUBLIC_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/**
 * JSON with the keys of every object sorted, as the `json-stable-stringify` package writes it (which 1Click signs):
 * no spaces, `undefined` properties left out, everything else as `JSON.stringify` writes it.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : stableStringify(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).toSorted()) {
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const orUndefined = <T>(value: T): T | undefined => (value ? value : undefined);

/** The request fields 1Click signs. Others it echoes back (appFees, depositMode, sessionId, ...) are not covered. */
function signedRequest(request: QuoteResponse["quoteRequest"]): Record<string, unknown> {
  const r = request as unknown as Record<string, unknown>;
  return {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: orUndefined(r.quoteWaitingTimeMs),
    referral: orUndefined(r.referral),
    virtualChainRecipient: orUndefined(r.virtualChainRecipient),
    virtualChainRefundRecipient: orUndefined(r.virtualChainRefundRecipient),
    customRecipientMsg: orUndefined(r.customRecipientMsg),
  };
}

/**
 * The quote fields 1Click signs. A dry quote signs only the amounts; a quote for a real payment also signs where to pay
 * (`depositAddress`, `depositMemo`) and when. Note that its own `deadline` replaces the requested one in the signed
 * object, which is how 1Click's own check builds it.
 */
function signedQuote(response: QuoteResponse): Record<string, unknown> {
  const q = response.quote as unknown as Record<string, unknown>;
  const amounts = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  if (response.quoteRequest.dry) return amounts;
  return {
    ...amounts,
    depositAddress: orUndefined(q.depositAddress),
    depositMemo: orUndefined(q.depositMemo),
    deadline: orUndefined(q.deadline),
    timeWhenInactive: orUndefined(q.timeWhenInactive),
    timeEstimate: orUndefined(q.timeEstimate),
    refundFee: orUndefined(q.refundFee),
    withdrawFee: orUndefined(q.withdrawFee),
  };
}

/** What 1Click signs: the base58 SHA-256 of the sorted JSON of the request fields, the quote fields and the timestamp. */
export function quoteHash(response: QuoteResponse): string {
  const signed = { ...signedRequest(response.quoteRequest), ...signedQuote(response), timestamp: response.timestamp };
  return base58Encode(createHash("sha256").update(stableStringify(signed), "utf8").digest());
}

/**
 * Whether `response` (a quote, or the quote inside a status) was signed by 1Click and has not been changed since. The
 * signature is over the UTF-8 text of {@link quoteHash}. It covers the amounts, where to pay and when, and the
 * request's addresses and assets; it does not cover a status value. Malformed input is `false`, never an exception.
 */
export function verifyQuoteSignature(response: QuoteResponse, publicKey: string = ONE_CLICK_PUBLIC_KEY): boolean {
  try {
    return verifyEd25519(publicKey, Buffer.from(quoteHash(response), "utf8"), response.signature);
  } catch {
    return false;
  }
}

/** What an event carries to prove where a quote came from, and whether Tilll checked it. */
export function proofOf(response: QuoteResponse): { proof: EventProof; proofVerified: boolean } {
  return {
    proof: { oneclickQuoteSignature: response.signature, oneclickCorrelationId: response.correlationId },
    proofVerified: verifyQuoteSignature(response),
  };
}
