import { fromBaseUnits } from "../money.js";
import { chainOfAssetId, withExplorerLinks } from "../oneclick/explorers.js";
import { verifyQuoteSignature } from "../oneclick/signature.js";
import type { Token } from "../oneclick/types.js";
import type { AttemptRecord, InvoiceRecord, RefundRecord } from "./repo.js";
import type { InvoiceStatus } from "./states.js";

/** The invoice as merchants and webhooks see it: display amounts next to the exact base-unit amounts. */
export function serializeInvoice(inv: InvoiceRecord, settlement: Pick<Token, "symbol" | "decimals">) {
  return {
    id: inv.id,
    status: inv.status,
    amount: fromBaseUnits(inv.amount, settlement.decimals),
    amountBase: inv.amount,
    refundedAmount: fromBaseUnits(inv.refundedAmount, settlement.decimals),
    refundedAmountBase: inv.refundedAmount,
    asset: { id: inv.assetId, symbol: settlement.symbol, decimals: settlement.decimals },
    /** The account that receives this invoice's payment. */
    settlementAccount: inv.settlementAccount,
    description: inv.description,
    metadata: inv.metadata,
    paidAttemptId: inv.paidAttemptId,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

export interface SerializeAttemptOptions {
  /** Add the raw 1Click quote and last status, and whether the quote's signature verified, for the dashboard. */
  includeRaw?: boolean;
}

export function serializeAttempt(att: AttemptRecord, options: SerializeAttemptOptions = {}) {
  return {
    id: att.id,
    invoiceId: att.invoiceId,
    status: att.status,
    origin: {
      assetId: att.originAsset,
      chain: att.originChain,
      symbol: att.originSymbol,
      decimals: att.originDecimals,
    },
    refundTo: att.refundTo,
    depositAddress: att.depositAddress,
    depositMemo: att.depositMemo,
    amountIn: fromBaseUnits(att.amountIn, att.originDecimals),
    amountInBase: att.amountIn,
    minAmountIn: fromBaseUnits(att.minAmountIn, att.originDecimals),
    minAmountInBase: att.minAmountIn,
    deadline: att.deadline,
    oneclickStatus: att.oneclickStatus,
    depositTxHash: att.depositTxHash,
    txLinks: withExplorerLinks(att.statusResponse?.swapDetails.originChainTxHashes ?? [], att.originChain),
    createdAt: att.createdAt,
    updatedAt: att.updatedAt,
    ...(options.includeRaw
      ? { raw: { quote: att.quote, status: att.statusResponse, quoteVerified: verifyQuoteSignature(att.quote) } }
      : {}),
  };
}

export function serializeRefund(r: RefundRecord, settlement: Pick<Token, "symbol" | "decimals">) {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    attemptId: r.attemptId,
    amount: fromBaseUnits(r.amount, settlement.decimals),
    amountBase: r.amount,
    reason: r.reason,
    status: r.status,
    idempotencyKey: r.idempotencyKey,
    intentHash: r.intentHash,
    error: r.error,
    /** Links to the transfer that paid the customer back, once there is one. */
    txLinks: withExplorerLinks(
      r.statusResponse?.swapDetails.destinationChainTxHashes ?? [],
      chainOfAssetId(r.quote?.quoteRequest.destinationAsset),
    ),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The invoice as the payer sees it: no metadata, no internal ids. */
export function serializePublicInvoice(inv: InvoiceRecord, settlement: Pick<Token, "symbol" | "decimals">) {
  return {
    id: inv.id,
    status: inv.status,
    amount: fromBaseUnits(inv.amount, settlement.decimals),
    asset: { id: inv.assetId, symbol: settlement.symbol, decimals: settlement.decimals },
    description: inv.description,
    expiresAt: inv.expiresAt,
  };
}

/** The attempt as the payer's browser sees it. The refund address and the raw quote stay server side. */
export function serializePublicAttempt(att: AttemptRecord, invoiceStatus: InvoiceStatus) {
  return {
    id: att.id,
    invoiceId: att.invoiceId,
    status: att.status,
    invoiceStatus,
    depositAddress: att.depositAddress,
    depositMemo: att.depositMemo,
    amountIn: fromBaseUnits(att.amountIn, att.originDecimals),
    symbol: att.originSymbol,
    chain: att.originChain,
    deadline: att.deadline,
    timeEstimate: att.quote.quote.timeEstimate,
    txLinks: withExplorerLinks(att.statusResponse?.swapDetails.originChainTxHashes ?? [], att.originChain),
  };
}
