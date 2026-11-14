import type { Db } from "../db/index.js";
import type { Nep413Payload } from "../near/nep413.js";
import type { QuoteResponse, StatusResponse } from "../oneclick/types.js";
import type { AttemptStatus, InvoiceStatus } from "./states.js";

/** All amounts are integer strings in base units. Timestamps are ISO 8601 strings. */
export interface InvoiceRecord {
  id: string;
  /** Base units of `assetId`. */
  amount: string;
  /** The settlement asset when the invoice was made. A later change of settlement asset does not touch it. */
  assetId: string;
  /** The account that receives this invoice's payment, fixed when it was made. */
  settlementAccount: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  status: InvoiceStatus;
  paidAttemptId: string | null;
  refundedAmount: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRecord {
  id: string;
  invoiceId: string;
  originAsset: string;
  originChain: string;
  originSymbol: string;
  originDecimals: number;
  refundTo: string;
  depositAddress: string;
  depositMemo: string | null;
  /** Base units of the origin asset. */
  amountIn: string;
  minAmountIn: string;
  deadline: string;
  /** The full 1Click quote response, including its signature. */
  quote: QuoteResponse;
  /** Last raw 1Click status. */
  oneclickStatus: string;
  status: AttemptStatus;
  /** Last full /v0/status response. */
  statusResponse: StatusResponse | null;
  depositTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * awaiting_approval: asked for, not yet signed by the merchant's wallet. pending: approved, being sent to 1Click.
 * submitted: 1Click has the intent. succeeded and failed end it.
 */
export type RefundStatus = "awaiting_approval" | "pending" | "submitted" | "succeeded" | "failed";

export interface RefundRecord {
  id: string;
  invoiceId: string;
  attemptId: string;
  /** Base units of the settlement asset. */
  amount: string;
  reason: "merchant_request" | "overpayment_auto" | null;
  depositAddress: string | null;
  intentHash: string | null;
  status: RefundStatus;
  /** The merchant's key for the request. Unique per invoice. Null for automatic refunds. */
  idempotencyKey: string | null;
  /** Why the refund failed. */
  error: string | null;
  /** When the signed intent stops being usable. Null until an intent has been signed. */
  intentDeadline: string | null;
  /** The refund's own 1Click quote (the swap that pays the customer back). */
  quote: QuoteResponse | null;
  /** Last /v0/status response for the refund's deposit address. */
  statusResponse: StatusResponse | null;
  /** The intent payload the server prepared and checked for the wallet to sign. Null until it is prepared. */
  payload: Nep413Payload | null;
  createdAt: string;
  updatedAt: string;
}

// ---- invoices ----

interface InvoiceRow {
  id: string;
  amount: string;
  asset_id: string;
  settlement_account: string;
  description: string | null;
  metadata_json: string | null;
  status: InvoiceStatus;
  paid_attempt_id: string | null;
  refunded_amount: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const toInvoice = (r: InvoiceRow): InvoiceRecord => ({
  id: r.id,
  amount: r.amount,
  assetId: r.asset_id,
  settlementAccount: r.settlement_account,
  description: r.description,
  metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
  status: r.status,
  paidAttemptId: r.paid_attempt_id,
  refundedAmount: r.refunded_amount,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function insertInvoice(db: Db, inv: InvoiceRecord): void {
  db.prepare(
    `INSERT INTO invoices (id, amount, asset_id, settlement_account, description, metadata_json, status,
       paid_attempt_id, refunded_amount, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    inv.id,
    inv.amount,
    inv.assetId,
    inv.settlementAccount,
    inv.description,
    inv.metadata ? JSON.stringify(inv.metadata) : null,
    inv.status,
    inv.paidAttemptId,
    inv.refundedAmount,
    inv.expiresAt,
    inv.createdAt,
    inv.updatedAt,
  );
}

export function findInvoice(db: Db, id: string): InvoiceRecord | undefined {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
  return row && toInvoice(row);
}

/** Newest first. `cursor` is the last id of the previous page. */
export function pageInvoices(
  db: Db,
  q: { status?: InvoiceStatus | undefined; cursor?: string | undefined; search?: string | undefined; limit: number },
): InvoiceRecord[] {
  // instr() on lower-cased text, not LIKE: a search for "%" or "_" means those characters, not a wildcard.
  const rows = db
    .prepare(
      `SELECT * FROM invoices
       WHERE (@status IS NULL OR status = @status) AND (@cursor IS NULL OR id < @cursor)
         AND (@search IS NULL
              OR instr(lower(id), @search) > 0
              OR instr(lower(coalesce(description, '')), @search) > 0
              OR instr(lower(coalesce(metadata_json, '')), @search) > 0)
       ORDER BY id DESC LIMIT @limit`,
    )
    .all({
      status: q.status ?? null,
      cursor: q.cursor ?? null,
      search: q.search ? q.search.toLowerCase() : null,
      limit: q.limit,
    }) as InvoiceRow[];
  return rows.map(toInvoice);
}

/** Invoices paid since `sinceIso` (by when their paid attempt ended), and the sum of their amounts in base units. */
export function paidSince(db: Db, sinceIso: string): { count: number; total: bigint } {
  const rows = db
    .prepare(
      `SELECT i.amount AS amount FROM invoices i JOIN attempts a ON a.id = i.paid_attempt_id
       WHERE i.status = 'paid' AND a.status = 'paid' AND a.updated_at >= ?`,
    )
    .all(sinceIso) as { amount: string }[];
  return { count: rows.length, total: rows.reduce((sum, r) => sum + BigInt(r.amount), 0n) };
}

export function countInvoices(db: Db, status: InvoiceStatus): number {
  return (db.prepare("SELECT count(*) AS n FROM invoices WHERE status = ?").get(status) as { n: number }).n;
}

export function updateInvoice(
  db: Db,
  id: string,
  patch: { status?: InvoiceStatus; paidAttemptId?: string; refundedAmount?: string; updatedAt: string },
): void {
  db.prepare(
    `UPDATE invoices SET
       status = COALESCE(?, status),
       paid_attempt_id = COALESCE(?, paid_attempt_id),
       refunded_amount = COALESCE(?, refunded_amount),
       updated_at = ?
     WHERE id = ?`,
  ).run(patch.status ?? null, patch.paidAttemptId ?? null, patch.refundedAmount ?? null, patch.updatedAt, id);
}

export function countAttemptsWithStatus(db: Db, invoiceId: string, status: AttemptStatus): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM attempts WHERE invoice_id = ? AND status = ?")
    .get(invoiceId, status) as { n: number };
  return row.n;
}

// ---- attempts ----

interface AttemptRow {
  id: string;
  invoice_id: string;
  origin_asset: string;
  origin_chain: string;
  origin_symbol: string | null;
  origin_decimals: number | null;
  refund_to: string;
  deposit_address: string;
  deposit_memo: string | null;
  amount_in: string;
  min_amount_in: string;
  deadline: string;
  quote_json: string;
  oneclick_status: string;
  status: AttemptStatus;
  status_json: string | null;
  deposit_tx_hash: string | null;
  created_at: string;
  updated_at: string;
}

const toAttempt = (r: AttemptRow): AttemptRecord => {
  if (r.origin_symbol == null || r.origin_decimals == null) {
    throw new Error(`Attempt ${r.id} has no token snapshot; attempts are always written with one`);
  }
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    originAsset: r.origin_asset,
    originChain: r.origin_chain,
    originSymbol: r.origin_symbol,
    originDecimals: r.origin_decimals,
    refundTo: r.refund_to,
    depositAddress: r.deposit_address,
    depositMemo: r.deposit_memo,
    amountIn: r.amount_in,
    minAmountIn: r.min_amount_in,
    deadline: r.deadline,
    quote: JSON.parse(r.quote_json) as QuoteResponse,
    oneclickStatus: r.oneclick_status,
    status: r.status,
    statusResponse: r.status_json ? (JSON.parse(r.status_json) as StatusResponse) : null,
    depositTxHash: r.deposit_tx_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

export function insertAttempt(db: Db, a: AttemptRecord): void {
  db.prepare(
    `INSERT INTO attempts (id, invoice_id, origin_asset, origin_chain, origin_symbol, origin_decimals, refund_to,
       deposit_address, deposit_memo, amount_in, min_amount_in, deadline, quote_json, oneclick_status, status,
       status_json, deposit_tx_hash, created_at, updated_at)
     VALUES (@id, @invoiceId, @originAsset, @originChain, @originSymbol, @originDecimals, @refundTo,
       @depositAddress, @depositMemo, @amountIn, @minAmountIn, @deadline, @quote, @oneclickStatus, @status,
       @statusResponse, @depositTxHash, @createdAt, @updatedAt)`,
  ).run({
    ...a,
    quote: JSON.stringify(a.quote),
    statusResponse: a.statusResponse ? JSON.stringify(a.statusResponse) : null,
  });
}

export function findAttempt(db: Db, id: string): AttemptRecord | undefined {
  const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  return row && toAttempt(row);
}

/** Attempts created for this invoice after `sinceIso`, in any status. */
export function countAttemptsSince(db: Db, invoiceId: string, sinceIso: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM attempts WHERE invoice_id = ? AND created_at > ?")
    .get(invoiceId, sinceIso) as { n: number };
  return row.n;
}

/** Awaiting attempts other than `exceptId` become superseded. Attempts that already have money on them are left alone. */
export function supersedeAwaiting(db: Db, invoiceId: string, exceptId: string, updatedAt: string): void {
  db.prepare(
    `UPDATE attempts SET status = 'superseded', updated_at = ?
     WHERE invoice_id = ? AND status = 'awaiting' AND id != ?`,
  ).run(updatedAt, invoiceId, exceptId);
}

export function updateAttempt(
  db: Db,
  id: string,
  patch: {
    status: AttemptStatus;
    oneclickStatus: string;
    statusResponse: StatusResponse;
    depositTxHash: string | null;
    updatedAt: string;
  },
): void {
  db.prepare(
    `UPDATE attempts SET status = @status, oneclick_status = @oneclickStatus, status_json = @statusResponse,
       deposit_tx_hash = @depositTxHash, updated_at = @updatedAt
     WHERE id = @id`,
  ).run({ id, ...patch, statusResponse: JSON.stringify(patch.statusResponse) });
}

/** Every attempt that is not in a terminal state, oldest first. Insertion order, since ids created in one millisecond are not ordered. */
export function listLiveAttempts(db: Db): AttemptRecord[] {
  const rows = db
    .prepare("SELECT * FROM attempts WHERE status NOT IN ('paid', 'refunded', 'failed') ORDER BY rowid ASC")
    .all() as AttemptRow[];
  return rows.map(toAttempt);
}

export function listAttemptsForInvoice(db: Db, invoiceId: string): AttemptRecord[] {
  const rows = db
    .prepare("SELECT * FROM attempts WHERE invoice_id = ? ORDER BY rowid ASC")
    .all(invoiceId) as AttemptRow[];
  return rows.map(toAttempt);
}

/** Open invoices whose expiry time is at or before `nowIso`. */
export function listInvoicesDueToExpire(db: Db, nowIso: string): InvoiceRecord[] {
  const rows = db
    .prepare("SELECT * FROM invoices WHERE status = 'open' AND expires_at <= ? ORDER BY id ASC")
    .all(nowIso) as InvoiceRow[];
  return rows.map(toInvoice);
}

// ---- refunds ----

interface RefundRow {
  id: string;
  invoice_id: string;
  attempt_id: string;
  amount: string;
  reason: RefundRecord["reason"];
  deposit_address: string | null;
  intent_hash: string | null;
  status: RefundStatus;
  idempotency_key: string | null;
  error: string | null;
  intent_deadline: string | null;
  quote_json: string | null;
  status_json: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

const toRefund = (r: RefundRow): RefundRecord => ({
  id: r.id,
  invoiceId: r.invoice_id,
  attemptId: r.attempt_id,
  amount: r.amount,
  reason: r.reason,
  depositAddress: r.deposit_address,
  intentHash: r.intent_hash,
  status: r.status,
  idempotencyKey: r.idempotency_key,
  error: r.error,
  intentDeadline: r.intent_deadline,
  quote: r.quote_json ? (JSON.parse(r.quote_json) as QuoteResponse) : null,
  statusResponse: r.status_json ? (JSON.parse(r.status_json) as StatusResponse) : null,
  payload: r.payload_json ? (JSON.parse(r.payload_json) as Nep413Payload) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function insertRefund(db: Db, r: RefundRecord): void {
  db.prepare(
    `INSERT INTO refunds (id, invoice_id, attempt_id, amount, reason, deposit_address, quote_json, intent_hash,
       status, status_json, idempotency_key, error, intent_deadline, payload_json, created_at, updated_at)
     VALUES (@id, @invoiceId, @attemptId, @amount, @reason, @depositAddress, @quote, @intentHash,
       @status, @statusResponse, @idempotencyKey, @error, @intentDeadline, @payload, @createdAt, @updatedAt)`,
  ).run({
    ...r,
    quote: r.quote ? JSON.stringify(r.quote) : null,
    statusResponse: r.statusResponse ? JSON.stringify(r.statusResponse) : null,
    payload: r.payload ? JSON.stringify(r.payload) : null,
  });
}

export function findRefund(db: Db, id: string): RefundRecord | undefined {
  const row = db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as RefundRow | undefined;
  return row && toRefund(row);
}

export function findRefundByKey(db: Db, invoiceId: string, idempotencyKey: string): RefundRecord | undefined {
  const row = db
    .prepare("SELECT * FROM refunds WHERE invoice_id = ? AND idempotency_key = ?")
    .get(invoiceId, idempotencyKey) as RefundRow | undefined;
  return row && toRefund(row);
}

/** Fields left out (undefined) keep their stored value. */
export function updateRefund(
  db: Db,
  id: string,
  patch: {
    status?: RefundStatus;
    depositAddress?: string;
    intentHash?: string;
    error?: string;
    intentDeadline?: string;
    quote?: QuoteResponse;
    statusResponse?: StatusResponse;
    payload?: Nep413Payload;
    /** Forget the stored error (a later try worked). */
    clearError?: boolean;
    /** Forget the signed intent's deadline: 1Click turned the intent down, so nothing was accepted. */
    clearIntentDeadline?: boolean;
    /** Forget the prepared payload and its quote: the merchant has to prepare the refund again. */
    clearPrepared?: boolean;
    updatedAt: string;
  },
): void {
  db.prepare(
    `UPDATE refunds SET
       status = COALESCE(@status, status),
       deposit_address = CASE WHEN @clearPrepared = 1 THEN NULL ELSE COALESCE(@depositAddress, deposit_address) END,
       intent_hash = COALESCE(@intentHash, intent_hash),
       error = CASE WHEN @clearError = 1 THEN NULL ELSE COALESCE(@error, error) END,
       intent_deadline = CASE WHEN @clearIntentDeadline = 1 THEN NULL ELSE COALESCE(@intentDeadline, intent_deadline) END,
       quote_json = CASE WHEN @clearPrepared = 1 THEN NULL ELSE COALESCE(@quote, quote_json) END,
       status_json = COALESCE(@statusResponse, status_json),
       payload_json = CASE WHEN @clearPrepared = 1 THEN NULL ELSE COALESCE(@payload, payload_json) END,
       updated_at = @updatedAt
     WHERE id = @id`,
  ).run({
    id,
    status: patch.status ?? null,
    depositAddress: patch.depositAddress ?? null,
    intentHash: patch.intentHash ?? null,
    error: patch.error ?? null,
    intentDeadline: patch.intentDeadline ?? null,
    quote: patch.quote ? JSON.stringify(patch.quote) : null,
    statusResponse: patch.statusResponse ? JSON.stringify(patch.statusResponse) : null,
    payload: patch.payload ? JSON.stringify(patch.payload) : null,
    clearError: patch.clearError ? 1 : 0,
    clearIntentDeadline: patch.clearIntentDeadline ? 1 : 0,
    clearPrepared: patch.clearPrepared ? 1 : 0,
    updatedAt: patch.updatedAt,
  });
}

export function listRefundsForInvoice(db: Db, invoiceId: string): RefundRecord[] {
  const rows = db
    .prepare("SELECT * FROM refunds WHERE invoice_id = ? ORDER BY rowid ASC")
    .all(invoiceId) as RefundRow[];
  return rows.map(toRefund);
}

/** Newest first. `cursor` is the last id of the previous page. */
export function pageRefunds(
  db: Db,
  q: { cursor?: string | undefined; limit: number; status?: RefundStatus | undefined },
): RefundRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM refunds
       WHERE (@cursor IS NULL OR rowid < (SELECT rowid FROM refunds WHERE id = @cursor))
         AND (@status IS NULL OR status = @status)
       ORDER BY rowid DESC LIMIT @limit`,
    )
    .all({ cursor: q.cursor ?? null, limit: q.limit, status: q.status ?? null }) as RefundRow[];
  return rows.map(toRefund);
}

/** How many refunds are in each status. */
export function countRefundsByStatus(db: Db): Record<RefundStatus, number> {
  const counts: Record<RefundStatus, number> = {
    awaiting_approval: 0,
    pending: 0,
    submitted: 0,
    succeeded: 0,
    failed: 0,
  };
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM refunds GROUP BY status").all() as {
    status: RefundStatus;
    n: number;
  }[];
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** Refunds that have not ended, oldest first. */
export function listOpenRefunds(db: Db): RefundRecord[] {
  const rows = db
    .prepare("SELECT * FROM refunds WHERE status IN ('awaiting_approval', 'pending', 'submitted') ORDER BY rowid ASC")
    .all() as RefundRow[];
  return rows.map(toRefund);
}

// ---- daily refund ledger ----

/** What has been reserved for refunds of one asset on a UTC day (YYYY-MM-DD), in that asset's base units. */
export function ledgerTotal(db: Db, day: string, assetId: string): bigint {
  const row = db.prepare("SELECT total FROM refund_ledger_daily WHERE day = ? AND asset_id = ?").get(day, assetId) as
    | { total: string }
    | undefined;
  return BigInt(row?.total ?? "0");
}

/** Add `delta` (negative to give an allowance back) to a day's total. It never goes below zero. */
export function addToLedger(db: Db, day: string, assetId: string, delta: bigint): void {
  const next = ledgerTotal(db, day, assetId) + delta;
  db.prepare(
    `INSERT INTO refund_ledger_daily (day, asset_id, total) VALUES (?, ?, ?)
     ON CONFLICT (day, asset_id) DO UPDATE SET total = excluded.total`,
  ).run(day, assetId, (next < 0n ? 0n : next).toString());
}
