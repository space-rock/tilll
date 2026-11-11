/** The shapes the server sends to the payer's browser. Kept in step with serializePublicInvoice / serializePublicAttempt. */

export type InvoiceStatus = "open" | "paid" | "expired" | "canceled";
export type AttemptStatus = "awaiting" | "confirming" | "underpaid" | "paid" | "refunded" | "failed" | "superseded";

export interface PublicInvoice {
  id: string;
  status: InvoiceStatus;
  /** Display units of the settlement asset, e.g. "5". */
  amount: string;
  asset: { id: string; symbol: string; decimals: number };
  description: string | null;
  expiresAt: string;
}

export interface TxLink {
  hash: string;
  explorerUrl: string;
}

export interface PublicAttempt {
  id: string;
  invoiceId: string;
  status: AttemptStatus;
  invoiceStatus: InvoiceStatus;
  depositAddress: string;
  depositMemo: string | null;
  /** Exactly what to send, in display units of the payer's token. */
  amountIn: string;
  symbol: string;
  chain: string;
  deadline: string;
  /** Seconds the swap takes once the deposit is confirmed. */
  timeEstimate: number;
  txLinks: TxLink[];
}
