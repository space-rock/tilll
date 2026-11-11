import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base58Encode, publicKeyOf, signWithSecret } from "../src/near/keys.js";
import {
  ONE_CLICK_PUBLIC_KEY,
  proofOf,
  quoteHash,
  stableStringify,
  verifyQuoteSignature,
} from "../src/oneclick/signature.js";
import type { QuoteResponse } from "../src/oneclick/types.js";
import quoteFixture from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import tidepoolQuote from "./fixtures/tidepool-quote-live.json" with { type: "json" };

/** A real response from the live 1Click API (a `dry: true` quote recorded on 2026-11-05). */
const real = (): QuoteResponse => structuredClone(quoteFixture) as unknown as QuoteResponse;

describe("stableStringify", () => {
  it("sorts keys, leaves out undefined, and writes values as JSON does", () => {
    expect(stableStringify({ b: 1, a: "x", c: undefined, d: true, e: null, f: 0.5 })).toBe(
      '{"a":"x","b":1,"d":true,"e":null,"f":0.5}',
    );
  });

  it("sorts nested objects too, and keeps array order", () => {
    expect(stableStringify({ z: { b: 2, a: 1 }, y: [3, { d: 1, c: 2 }] })).toBe(
      '{"y":[3,{"c":2,"d":1}],"z":{"a":1,"b":2}}',
    );
  });

  it("escapes strings exactly as JSON.stringify does", () => {
    const tricky = 'quote " slash \\ newline \n unicode é ☕';
    expect(stableStringify({ k: tricky })).toBe(`{"k":${JSON.stringify(tricky)}}`);
  });

  it("orders keys by code unit, as the JavaScript default sort does", () => {
    expect(stableStringify({ b: 1, B: 2, a: 3, 10: 4, 9: 5 })).toBe('{"10":4,"9":5,"B":2,"a":3,"b":1}');
  });
});

describe("a real 1Click quote", () => {
  it("verifies against 1Click's published public key (the scheme and the key, checked against live data)", () => {
    expect(verifyQuoteSignature(real())).toBe(true);
  });

  it("is signed over the base58 SHA-256 of the sorted JSON of the request fields, the quote fields and the timestamp", () => {
    const r = real();
    expect(quoteHash(r)).toBe(
      base58Encode(
        createHash("sha256")
          .update(
            stableStringify({
              ...Object.fromEntries(
                [
                  "dry",
                  "swapType",
                  "slippageTolerance",
                  "originAsset",
                  "depositType",
                  "destinationAsset",
                  "amount",
                  "refundTo",
                  "refundType",
                  "recipient",
                  "recipientType",
                  "deadline",
                  "referral",
                ].map((k) => [k, (r.quoteRequest as unknown as Record<string, unknown>)[k]]),
              ),
              amountIn: r.quote.amountIn,
              amountInFormatted: r.quote.amountInFormatted,
              amountInUsd: r.quote.amountInUsd,
              minAmountIn: r.quote.minAmountIn,
              amountOut: r.quote.amountOut,
              amountOutFormatted: r.quote.amountOutFormatted,
              amountOutUsd: r.quote.amountOutUsd,
              minAmountOut: r.quote.minAmountOut,
              timestamp: r.timestamp,
            }),
          )
          .digest(),
      ),
    );
  });

  it.each([
    ["the amount the payer sends", (r: QuoteResponse) => (r.quote.amountIn = "5051530")],
    ["the amount you receive", (r: QuoteResponse) => (r.quote.amountOut = "4999999")],
    ["the minimum", (r: QuoteResponse) => (r.quote.minAmountIn = "1")],
    ["the recipient", (r: QuoteResponse) => (r.quoteRequest.recipient = "attacker.near")],
    [
      "the refund address",
      (r: QuoteResponse) => (r.quoteRequest.refundTo = "0x0000000000000000000000000000000000000002"),
    ],
    ["the origin asset", (r: QuoteResponse) => (r.quoteRequest.originAsset = "nep141:other")],
    ["the requested amount", (r: QuoteResponse) => (r.quoteRequest.amount = "6000000")],
    ["the slippage", (r: QuoteResponse) => (r.quoteRequest.slippageTolerance = 200)],
    ["the swap type", (r: QuoteResponse) => (r.quoteRequest.swapType = "EXACT_INPUT")],
    ["the timestamp", (r: QuoteResponse) => (r.timestamp = "2026-11-05T08:15:27.832Z")],
    ["the signature itself", (r: QuoteResponse) => (r.signature = `${r.signature.slice(0, -2)}AA`)],
  ])("stops verifying when %s is changed", (_name, change) => {
    const r = real();
    change(r);
    expect(verifyQuoteSignature(r)).toBe(false);
  });

  it.each([
    ["the correlation id", (r: QuoteResponse) => (r.correlationId = "other")],
    [
      "the platform fee list",
      (r: QuoteResponse) => ((r.quoteRequest as unknown as Record<string, unknown>).appFees = []),
    ],
    [
      "the deposit mode",
      (r: QuoteResponse) => ((r.quoteRequest as unknown as Record<string, unknown>).depositMode = "MEMO"),
    ],
    [
      "a dry quote's deposit address, which a dry quote does not sign",
      (r: QuoteResponse) => (r.quote.depositAddress = "0xanything"),
    ],
  ])("still verifies when %s changes, because the signature does not cover it", (_name, change) => {
    const r = real();
    change(r);
    expect(verifyQuoteSignature(r)).toBe(true);
  });

  it("does not verify against another key", () => {
    const other = publicKeyOf(`ed25519:${base58Encode(Buffer.alloc(32, 3))}`);
    expect(verifyQuoteSignature(real(), other)).toBe(false);
    expect(ONE_CLICK_PUBLIC_KEY).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("does not verify a quote another server signed (the Tidepool testnet signs with its own key)", () => {
    expect(verifyQuoteSignature(tidepoolQuote as unknown as QuoteResponse)).toBe(false);
  });
});

describe("a quote for a real payment (dry: false)", () => {
  /** A non-dry quote, signed here with a throwaway key the same way 1Click signs, so the extra fields can be exercised. */
  const secret = `ed25519:${base58Encode(Buffer.alloc(32, 9))}`;
  const key = publicKeyOf(secret);
  const sign = (r: QuoteResponse): QuoteResponse => {
    const text = quoteHash(r);
    return { ...r, signature: `ed25519:${base58Encode(signWithSecret(secret, Buffer.from(text)))}` };
  };
  const live = (): QuoteResponse => {
    const r = real();
    r.quoteRequest.dry = false;
    r.quote.depositAddress = "0xDEPOSIT000000000000000000000000000000001";
    r.quote.depositMemo = "123";
    r.quote.deadline = "2026-11-08T08:45:26.553Z";
    r.quote.timeWhenInactive = "2026-11-08T08:45:26.553Z";
    return sign(r);
  };

  it("verifies when signed over the extra execution fields", () => {
    expect(verifyQuoteSignature(live(), key)).toBe(true);
  });

  it.each([
    [
      "the deposit address (a man in the middle swapping where the money goes)",
      (r: QuoteResponse) => (r.quote.depositAddress = "0xATTACKER"),
    ],
    ["the memo", (r: QuoteResponse) => (r.quote.depositMemo = "999")],
    ["when the address goes inactive", (r: QuoteResponse) => (r.quote.timeWhenInactive = "2027-01-01T00:00:00.000Z")],
    ["the time estimate", (r: QuoteResponse) => (r.quote.timeEstimate = 1)],
    ["the refund fee", (r: QuoteResponse) => (r.quote.refundFee = "1")],
  ])("stops verifying when %s is changed", (_name, change) => {
    const r = live();
    change(r);
    expect(verifyQuoteSignature(r, key)).toBe(false);
  });

  it("takes the quote's own deadline in place of the one that was asked for, as 1Click's own check does", () => {
    const r = live();
    r.quoteRequest.deadline = "2030-01-01T00:00:00.000Z"; // overridden by quote.deadline when the quote has one
    expect(verifyQuoteSignature(r, key)).toBe(true);
    r.quote.deadline = "2030-01-01T00:00:00.000Z";
    expect(verifyQuoteSignature(r, key)).toBe(false);
  });
});

describe("verifyQuoteSignature never throws", () => {
  it.each([
    ["no signature", (r: Record<string, unknown>) => delete r.signature],
    ["a signature that is not base58", (r: Record<string, unknown>) => (r.signature = "ed25519:0OIl")],
    ["no quote", (r: Record<string, unknown>) => delete r.quote],
    ["no request", (r: Record<string, unknown>) => delete r.quoteRequest],
    ["no timestamp", (r: Record<string, unknown>) => delete r.timestamp],
  ])("and says false for a response with %s", (_name, damage) => {
    const r = real() as unknown as Record<string, unknown>;
    damage(r);
    expect(verifyQuoteSignature(r as unknown as QuoteResponse)).toBe(false);
  });

  it("and says false for something that is not a response at all", () => {
    for (const junk of [null, undefined, 7, "x", [], {}])
      expect(verifyQuoteSignature(junk as unknown as QuoteResponse)).toBe(false);
  });
});

describe("proofOf", () => {
  it("gives what a webhook carries: the signature, the correlation id, and whether the signature checked out", () => {
    const r = real();
    expect(proofOf(r)).toEqual({
      proof: { oneclickQuoteSignature: r.signature, oneclickCorrelationId: r.correlationId },
      proofVerified: true,
    });
    r.quote.amountIn = "1";
    expect(proofOf(r).proofVerified).toBe(false);
  });
});
