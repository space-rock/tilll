import type { DepositMode, QuoteRequest, Token } from "./types.js";

/** Chains whose deposits confirm slowly. PLAN section 8: they get at least a 120 minute deadline. */
const SLOW_CHAINS = new Set(["btc", "ltc", "doge", "bch", "zec", "dash"]);
const SLOW_CHAIN_MINUTES = 120;
const REFUND_DEADLINE_MINUTES = 30;

const plusMinutes = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000).toISOString();

export interface PaymentQuoteInput {
  /** Explicit on purpose: there is no default, so a caller can never get a real deposit address by accident. */
  dry: boolean;
  /** The token the payer chose. */
  originAsset: Token;
  /** Invoice amount in base units of the settlement asset. */
  invoiceAmount: string;
  /** Payer's refund address on the origin chain. */
  refundTo: string;
  settlementAssetId: string;
  settlementAccountId: string;
  slippageBps: number;
  deadlineMinutes: number;
  /** Chains that need depositMode MEMO. 1Click's token list carries no memo flag, so this is configuration. */
  memoChains: string[];
  /** Forces the deposit mode instead of guessing from `memoChains`. Used to retry after 1Click disagrees. */
  depositMode?: DepositMode;
  now: Date;
}

/** PLAN section 8: the payer funds an EXACT_OUTPUT swap that settles into the merchant's Intents balance. */
export function paymentQuoteRequest(input: PaymentQuoteInput): QuoteRequest {
  const chain = input.originAsset.blockchain.toLowerCase();
  const minutes = SLOW_CHAINS.has(chain) ? Math.max(input.deadlineMinutes, SLOW_CHAIN_MINUTES) : input.deadlineMinutes;
  const needsMemo = input.memoChains.some((c) => c.toLowerCase() === chain);
  return {
    dry: input.dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: input.slippageBps,
    originAsset: input.originAsset.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.settlementAssetId,
    amount: input.invoiceAmount,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.settlementAccountId,
    recipientType: "INTENTS",
    deadline: plusMinutes(input.now, minutes),
    depositMode: input.depositMode ?? (needsMemo ? "MEMO" : "SIMPLE"),
    referral: "tilll",
  };
}

export interface RefundQuoteInput {
  /** Preview uses true, execution false. One builder keeps the two identical. */
  dry: boolean;
  settlementAssetId: string;
  settlementAccountId: string;
  /** The asset the payer originally paid with. */
  destinationAsset: string;
  /** Refund amount in base units of the settlement asset. */
  amount: string;
  /** The payer's refund address on their origin chain. */
  refundAddress: string;
  slippageBps: number;
  now: Date;
}

/** PLAN section 9: an EXACT_INPUT swap funded from the Intents balance, paid out on the payer's origin chain. */
export function refundQuoteRequest(input: RefundQuoteInput): QuoteRequest {
  return {
    dry: input.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippageBps,
    originAsset: input.settlementAssetId,
    depositType: "INTENTS",
    destinationAsset: input.destinationAsset,
    amount: input.amount,
    refundTo: input.settlementAccountId,
    refundType: "INTENTS",
    recipient: input.refundAddress,
    recipientType: "DESTINATION_CHAIN",
    deadline: plusMinutes(input.now, REFUND_DEADLINE_MINUTES),
  };
}

/** The request fields that decide whose money moves, how much, in what, and to whom. */
const MATCHED_FIELDS = [
  "swapType",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
] as const;

const EVM_ADDRESS = /^0x[a-f0-9]{40}$/i;
/** EVM addresses are the same in any letter case; everything else must be identical. */
const sameValue = (sent: unknown, echoed: unknown) =>
  sent === echoed ||
  (typeof sent === "string" &&
    typeof echoed === "string" &&
    EVM_ADDRESS.test(sent) &&
    sent.toLowerCase() === echoed.toLowerCase());

/**
 * 1Click answers a quote with the request it priced (`quoteRequest`), and that echo is what its signature covers. This
 * names the first field of the echo that differs from what Tilll sent, or `undefined` when the quote is for the request
 * Tilll made. A quote for anyone else's account, asset, amount or address must not be used: its deposit address would
 * move the money somewhere Tilll never asked for.
 */
export function quoteMismatch(sent: QuoteRequest, echoed: unknown): (typeof MATCHED_FIELDS)[number] | undefined {
  const record = (typeof echoed === "object" && echoed !== null ? echoed : {}) as Record<string, unknown>;
  return MATCHED_FIELDS.find((field) => !sameValue(sent[field], record[field]));
}
