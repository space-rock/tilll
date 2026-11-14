import { describe, expect, it } from "vitest";
import type { AttemptRecord, InvoiceRecord } from "../src/invoices/repo.js";
import { serializeAttempt, serializeInvoice } from "../src/invoices/serialize.js";
import type { QuoteResponse, StatusResponse } from "../src/oneclick/types.js";
import realQuote from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import { USDC_BASE, USDC_NEAR, quoteResponseFor, statusResponseFor, tokenById } from "./helpers/oneclickData.js";

const settlement = tokenById(USDC_NEAR);

const invoice: InvoiceRecord = {
  id: "inv_1",
  amount: "5250000",
  assetId: USDC_NEAR,
  settlementAccount: "shop-pay.near",
  description: "Coffee",
  metadata: { orderId: "A-17" },
  status: "paid",
  paidAttemptId: "att_1",
  refundedAmount: "1000000",
  expiresAt: "2026-11-05T11:00:00.000Z",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:05:00.000Z",
};

const quote: QuoteResponse = quoteResponseFor(
  {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC_BASE,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR,
    amount: "5250000",
    refundTo: "0xrefund",
    refundType: "ORIGIN_CHAIN",
    recipient: "shop-pay.near",
    recipientType: "INTENTS",
    deadline: "2026-11-05T10:30:00.000Z",
  },
  1,
);

const status: StatusResponse = statusResponseFor(quote, "SUCCESS", {
  originChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
});

const attempt: AttemptRecord = {
  id: "att_1",
  invoiceId: "inv_1",
  originAsset: USDC_BASE,
  originChain: "base",
  originSymbol: "USDC",
  originDecimals: 6,
  refundTo: "0xrefund",
  depositAddress: "0xDEPOSIT1",
  depositMemo: null,
  amountIn: "5051529",
  minAmountIn: "5001013",
  deadline: "2026-11-05T10:30:00.000Z",
  quote,
  oneclickStatus: "SUCCESS",
  status: "paid",
  statusResponse: status,
  depositTxHash: "0xabc",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:05:00.000Z",
};

describe("serializeInvoice", () => {
  it("shows display amounts next to the exact base-unit amounts", () => {
    expect(serializeInvoice(invoice, settlement)).toEqual({
      id: "inv_1",
      status: "paid",
      amount: "5.25",
      amountBase: "5250000",
      refundedAmount: "1",
      refundedAmountBase: "1000000",
      settlementAccount: "shop-pay.near",
      asset: { id: USDC_NEAR, symbol: "USDC", decimals: 6 },
      description: "Coffee",
      metadata: { orderId: "A-17" },
      paidAttemptId: "att_1",
      expiresAt: "2026-11-05T11:00:00.000Z",
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:05:00.000Z",
    });
  });
});

describe("serializeAttempt", () => {
  it("formats amounts with the payer's token and lists origin-chain explorer links", () => {
    expect(serializeAttempt(attempt)).toEqual({
      id: "att_1",
      invoiceId: "inv_1",
      status: "paid",
      origin: { assetId: USDC_BASE, chain: "base", symbol: "USDC", decimals: 6 },
      refundTo: "0xrefund",
      depositAddress: "0xDEPOSIT1",
      depositMemo: null,
      amountIn: "5.051529",
      amountInBase: "5051529",
      minAmountIn: "5.001013",
      minAmountInBase: "5001013",
      deadline: "2026-11-05T10:30:00.000Z",
      oneclickStatus: "SUCCESS",
      depositTxHash: "0xabc",
      txLinks: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:05:00.000Z",
    });
  });

  it("has no txLinks before any status has been recorded", () => {
    expect(serializeAttempt({ ...attempt, statusResponse: null, depositTxHash: null }).txLinks).toEqual([]);
  });

  it("includes the raw 1Click quote and status only when asked, for the dashboard", () => {
    expect(serializeAttempt(attempt)).not.toHaveProperty("raw");
    expect(serializeAttempt(attempt, { includeRaw: true }).raw).toEqual({ quote, status, quoteVerified: false });
  });

  it("says whether the quote's signature checks out against 1Click's key, so the dashboard can show it", () => {
    const real = structuredClone(realQuote) as unknown as QuoteResponse;
    expect(serializeAttempt({ ...attempt, quote: real }, { includeRaw: true }).raw?.quoteVerified).toBe(true);
    real.quote.amountIn = "1";
    expect(serializeAttempt({ ...attempt, quote: real }, { includeRaw: true }).raw?.quoteVerified).toBe(false);
  });
});
