import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { createInvoiceService } from "../src/invoices/service.js";
import { createTokenCache } from "../src/oneclick/tokens.js";
import type { QuoteRequest, QuoteResponse, StatusResponse, Token } from "../src/oneclick/types.js";
import quoteLive from "./fixtures/tidepool-quote-live.json" with { type: "json" };
import statusSuccess from "./fixtures/tidepool-status-success.json" with { type: "json" };
import tokensFixture from "./fixtures/tidepool-tokens.json" with { type: "json" };

/**
 * A real quote and a real SUCCESS status recorded from a payment on the Tidepool testnet (a community copy of the
 * 1Click API), run through Tilll's own code. They guard against Tilll only working with payloads shaped the way
 * its own fakes happen to shape them.
 */
const TOKENS = tokensFixture as Token[];
const QUOTE = quoteLive as unknown as QuoteResponse;
const STATUS = statusSuccess as unknown as StatusResponse;
const SETTLEMENT = TOKENS.find((t) => t.assetId === "nep141:usdc.tidepool-sandbox.testnet")!;
const ORIGIN = QUOTE.quoteRequest.originAsset;

function setup() {
  const db = openDb(":memory:");
  const requests: QuoteRequest[] = [];
  const service = createInvoiceService({
    db,
    client: {
      quote: async (req: QuoteRequest) => {
        requests.push(req);
        return QUOTE;
      },
    },
    tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    settlement: SETTLEMENT,
    config: {
      settlementAccountId: QUOTE.quoteRequest.recipient,
      slippageBps: 100,
      attemptDeadlineMinutes: 30,
      memoChains: ["stellar"],
    },
    now: () => new Date(Date.parse(QUOTE.timestamp)),
  });
  const events = () =>
    (db.prepare("SELECT payload_json FROM webhook_deliveries ORDER BY rowid").all() as { payload_json: string }[]).map(
      (r) => JSON.parse(r.payload_json) as { type: string; data: Record<string, any>; proof?: Record<string, string> },
    );
  return { service, requests, events };
}

describe("a real Tidepool quote", () => {
  it("has the fields Tilll relies on, and its deadline is the one that was asked for (no 3 day window)", () => {
    expect(QUOTE.quote.depositAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(QUOTE.signature).toMatch(/^ed25519:/);
    expect(QUOTE.correlationId).toBeTruthy();
    expect(QUOTE.quote.deadline).toBe(QUOTE.quoteRequest.deadline);
    expect(QUOTE.quote.timeWhenInactive).toBe(QUOTE.quoteRequest.deadline);
    expect(QUOTE.quoteRequest).toMatchObject({
      swapType: "EXACT_OUTPUT",
      depositType: "ORIGIN_CHAIN",
      recipientType: "INTENTS",
      // Recorded data: the quote was requested before the project was renamed from Till to Tilll.
      referral: "till",
    });
  });

  it("becomes an attempt: the deposit address, the exact amounts and the requested deadline are stored", async () => {
    const { service } = setup();
    const invoice = service.createInvoice({ amount: "3.00" });

    const attempt = await service.createAttempt(invoice.id, {
      originAsset: ORIGIN,
      refundTo: QUOTE.quoteRequest.refundTo,
    });

    expect(attempt).toMatchObject({
      depositAddress: QUOTE.quote.depositAddress,
      amountIn: QUOTE.quote.amountIn,
      minAmountIn: QUOTE.quote.minAmountIn,
      deadline: QUOTE.quoteRequest.deadline,
      originChain: "near",
      status: "awaiting",
    });
  });
});

describe("a real Tidepool SUCCESS status", () => {
  it("marks the invoice paid, records the origin transaction, and queues invoice.paid with the explorer link and proof", async () => {
    const { service, events } = setup();
    const invoice = service.createInvoice({ amount: "3.00" });
    const attempt = await service.createAttempt(invoice.id, {
      originAsset: ORIGIN,
      refundTo: QUOTE.quoteRequest.refundTo,
    });

    service.applyStatus(attempt.id, STATUS);

    expect(service.getAttempt(attempt.id)).toMatchObject({
      status: "paid",
      oneclickStatus: "SUCCESS",
      depositTxHash: STATUS.swapDetails.originChainTxHashes![0]!.hash,
    });
    expect(service.getInvoice(invoice.id)).toMatchObject({ status: "paid", paidAttemptId: attempt.id });
    const [paid, ...rest] = events();
    expect(rest).toEqual([]);
    expect(paid!.type).toBe("invoice.paid");
    expect(paid!.data.attempt.txLinks).toEqual(STATUS.swapDetails.originChainTxHashes);
    expect(paid!.proof).toEqual({
      oneclickQuoteSignature: QUOTE.signature,
      oneclickCorrelationId: QUOTE.correlationId,
    });
  });

  it("is the shape the types promise: plain-string near and intent hashes, tx links with explorer URLs", () => {
    expect(STATUS.status).toBe("SUCCESS");
    expect(STATUS.swapDetails.nearTxHashes!.every((h) => typeof h === "string")).toBe(true);
    expect(STATUS.swapDetails.intentHashes!.every((h) => typeof h === "string")).toBe(true);
    for (const link of STATUS.swapDetails.originChainTxHashes!)
      expect(link).toMatchObject({ hash: expect.any(String), explorerUrl: expect.stringMatching(/^https:\/\//) });
  });

  it("shows the slippage buffer coming back: the payer deposited more than the swap used, and the merchant got exactly the invoice", () => {
    const d = STATUS.swapDetails;
    expect(BigInt(d.depositedAmount!)).toBeGreaterThan(BigInt(d.amountIn!));
    expect(BigInt(d.refundedAmount!)).toBe(BigInt(d.depositedAmount!) - BigInt(d.amountIn!));
    expect(d.amountOut).toBe(QUOTE.quote.amountOut);
  });
});
