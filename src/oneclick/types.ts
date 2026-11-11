/**
 * Types for the 1Click Swap API (OpenAPI v0.1.10, https://1click.chaindefuser.com/docs/v0/openapi.yaml),
 * limited to the fields Tilll uses. Shapes checked against a recorded live response in test/fixtures.
 */

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = DepositType;
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type DepositMode = "SIMPLE" | "MEMO";

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

/** An entry of GET /v0/tokens. `assetId` is not always `nep141:`; nep245 and 1cs_v1 ids exist too. */
export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export interface AppFee {
  recipient: string;
  /** Basis points. */
  fee: number;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  /** Basis points. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** Integer string in base units (of the origin asset for EXACT_INPUT, destination asset for EXACT_OUTPUT). */
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO 8601 timestamp. */
  deadline: string;
  depositMode?: DepositMode;
  referral?: string;
  quoteWaitingTimeMs?: number;
  connectedWallets?: string[];
  sessionId?: string;
  appFees?: AppFee[];
}

export interface Quote {
  /** Absent on dry quotes. */
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /**
   * Absent on dry quotes. NOT the payment deadline: observed live, 1Click returns this (and timeWhenInactive)
   * 3 days after the `deadline` we request, as the time the deposit address goes inactive.
   */
  deadline?: string;
  /** Absent on dry quotes. Same value as `deadline` when observed. */
  timeWhenInactive?: string;
  /** Seconds. */
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  quote: Quote;
  /** The server's echo of the request, including fields it filled in (appFees, confidentiality, insured). */
  quoteRequest: QuoteRequest & { confidentiality?: string; insured?: boolean };
  /** Proof of the quote. Store the whole response. */
  signature: string;
  timestamp: string;
  correlationId: string;
}

export interface TransactionDetails {
  hash: string;
  explorerUrl: string;
}

export interface SwapDetails {
  /** Plain strings, unlike the chain tx hash arrays below. */
  intentHashes?: string[];
  /** Plain strings, unlike the chain tx hash arrays below. */
  nearTxHashes?: string[];
  amountIn?: string;
  amountInFormatted?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  slippage?: number;
  originChainTxHashes?: TransactionDetails[];
  destinationChainTxHashes?: TransactionDetails[];
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundedAmountUsd?: string;
  refundReason?: string;
  depositedAmount?: string;
  depositedAmountFormatted?: string;
  depositedAmountUsd?: string;
  withdrawFee?: string;
  referral?: string;
}

/** Response of GET /v0/status and POST /v0/deposit/submit. */
export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: SwapStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
}

export interface StatusQuery {
  depositAddress: string;
  /** Required by the API whenever the quote returned a depositMemo. */
  depositMemo?: string;
}

export interface DepositSubmitRequest {
  txHash: string;
  depositAddress: string;
  /** Only for NEAR deposits. */
  nearSenderAccount?: string;
  /** Use if the deposit was sent with a memo. */
  memo?: string;
}

export interface Nep413Payload {
  message: string;
  /** Base64, 32 bytes. */
  nonce: string;
  recipient: string;
  callbackUrl?: string | null;
}

export interface GenerateIntentRequest {
  type: "swap_transfer";
  standard: "nep413";
  signerId: string;
  depositAddress: string;
}

export interface GenerateIntentResponse {
  intent: { standard: "nep413"; payload: Nep413Payload };
  correlationId: string;
}

export interface SignedNep413Intent {
  standard: "nep413";
  payload: Nep413Payload;
  /** `ed25519:<base58>` */
  public_key: string;
  /** `ed25519:<base58>` */
  signature: string;
}

export interface SubmitIntentRequest {
  type: "swap_transfer";
  signedData: SignedNep413Intent;
}

export interface SubmitIntentResponse {
  intentHash: string;
  correlationId: string;
}
