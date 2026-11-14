/** What the merchant API (`/v1/*`) returns, as far as the dashboard uses it. */

export interface Asset {
  id: string;
  symbol: string;
  decimals: number;
}

export type InvoiceStatus = "open" | "paid" | "expired" | "canceled";
export type AttemptStatus = "awaiting" | "confirming" | "underpaid" | "paid" | "refunded" | "failed" | "superseded";
export type RefundStatus = "awaiting_approval" | "pending" | "submitted" | "succeeded" | "failed";

export interface TxLink {
  hash: string;
  explorerUrl: string;
}

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  amount: string;
  amountBase: string;
  refundedAmount: string;
  refundedAmountBase: string;
  asset: Asset;
  /** The account that received this invoice's payment. */
  settlementAccount?: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  paidAttemptId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** Only on the response to creating an invoice. */
  payUrl?: string;
}

export interface Attempt {
  id: string;
  invoiceId: string;
  status: AttemptStatus;
  origin: { assetId: string; chain: string; symbol: string; decimals: number };
  refundTo: string;
  depositAddress: string;
  depositMemo: string | null;
  amountIn: string;
  oneclickStatus: string;
  depositTxHash: string | null;
  txLinks: TxLink[];
  deadline: string;
  createdAt: string;
  updatedAt: string;
  /** The raw 1Click quote and status, and whether the quote's signature verified against 1Click's public key. */
  raw?: { quote: unknown; status: unknown; quoteVerified: boolean };
}

export interface Refund {
  id: string;
  invoiceId: string;
  attemptId: string;
  amount: string;
  amountBase: string;
  reason: "merchant_request" | "overpayment_auto" | null;
  status: RefundStatus;
  idempotencyKey: string | null;
  intentHash: string | null;
  error: string | null;
  txLinks: TxLink[];
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceDetail {
  invoice: Invoice;
  attempts: Attempt[];
  refunds: Refund[];
  /** False when the invoice was paid to a settlement account or asset the merchant has since changed. */
  refundableHere?: boolean;
}

export interface Money {
  amount: string;
  amountBase: string;
}

export interface Overview {
  asset: Asset;
  account: string;
  balance: { value: string; valueBase: string } | null;
  balanceError?: string;
  paidToday: Money & { count: number };
  openInvoices: number;
  refundedToday: Money;
  limits: { maxPerTx: string; maxPerTxBase: string; maxPerDay: string; maxPerDayBase: string };
  day: string;
  /** Refunds the merchant has asked for, or that came back from a duplicate payment, which wait for the wallet. */
  refundsAwaitingApproval: number;
}

export type RefundCounts = Record<RefundStatus, number>;

/** What the wallet signs for one refund, as the server prepared and checked it. */
export interface PreparedRefund {
  refund: Refund;
  payload: { message: string; nonce: string; recipient: string; callbackUrl?: string | null };
  /** The account that has to sign: the settlement account. */
  signerId: string;
  expiresAt: string;
  summary: Pick<RefundPreview, "amount" | "amountBase" | "destination" | "estimate">;
  note: string;
}

export interface RefundPreview {
  invoiceId: string;
  amount: string;
  amountBase: string;
  destination: { assetId: string; chain: string; symbol: string; decimals: number; address: string };
  estimate: {
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    withdrawFee: string | null;
    timeEstimate: number;
  };
  note: string;
}

export type DeliveryState = "delivered" | "pending" | "failed";

export interface Delivery {
  id: string;
  type: string;
  createdAt: string;
  attempts: number;
  nextTryAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  state: DeliveryState;
  payload: unknown;
}

export interface Settings {
  account: string;
  asset: Asset;
  intentsContract: string;
  /** The network a wallet has to be on. */
  network: "mainnet" | "testnet";
  publicBaseUrl: string;
  webhookUrl: string;
  oneclick: { baseUrl: string; apiKeySet: boolean; reachable: boolean };
  limits: { maxPerTx: string; maxPerDay: string };
  attemptDeadlineMinutes: number;
  slippageBps: number;
  /** Where each setting's value comes from: `.env`, or a change made in the dashboard. */
  sources: Record<SettingKey, SettingSource>;
  /** Why the settlement account and asset cannot be changed right now, or null. */
  settlementLocked: string | null;
  /** The latest changes made in the dashboard, newest first. */
  history: SettingChange[];
}

export type SettingKey =
  | "settlementAccount"
  | "settlementAsset"
  | "slippageBps"
  | "attemptDeadlineMinutes"
  | "webhookUrl"
  | "publicBaseUrl"
  | "refundMaxPerTx"
  | "refundMaxPerDay";

export interface SettingSource {
  source: "env" | "dashboard";
  updatedAt: string | null;
}

export interface SettingChange {
  setting: SettingKey;
  from: string | null;
  to: string | null;
  changedAt: string;
}

export interface WebhookTest {
  eventId: string;
  delivered: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}
