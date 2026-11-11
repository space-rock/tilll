import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { enqueueEvent } from "../events.js";
import { newId } from "../ids.js";
import { MoneyError, toBaseUnits } from "../money.js";
import { OneClickError, type OneClickClient } from "../oneclick/client.js";
import { mapQuoteError } from "../oneclick/apiErrors.js";
import { proofOf } from "../oneclick/signature.js";
import { paymentQuoteRequest } from "../oneclick/requests.js";
import { validateAddress } from "../validate/addresses.js";
import type { TokenCache } from "../oneclick/tokens.js";
import type { QuoteResponse, StatusResponse, Token } from "../oneclick/types.js";
import {
  countAttemptsSince,
  countAttemptsWithStatus,
  findAttempt,
  findInvoice,
  insertAttempt,
  insertInvoice,
  insertRefund,
  listAttemptsForInvoice,
  countInvoices,
  listInvoicesDueToExpire,
  listLiveAttempts,
  listRefundsForInvoice,
  pageInvoices,
  paidSince,
  supersedeAwaiting,
  updateAttempt,
  updateInvoice,
  type AttemptRecord,
  type InvoiceRecord,
  type RefundRecord,
} from "./repo.js";
import { serializeAttempt, serializeInvoice, serializeRefund } from "./serialize.js";
import { isTerminalAttempt, nextAttemptStatus, type InvoiceStatus } from "./states.js";

const DEFAULT_EXPIRY_MINUTES = 60;
const MAX_EXPIRY_MINUTES = 7 * 24 * 60;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
/**
 * How long past its own deadline an attempt is still polled. With money on it: a day. Without: until the deposit
 * address goes inactive (1Click says when, and returned 3 days after the deadline in the live run), so a payer who is
 * late is still seen and refunded. Two hours if the quote does not say, and never more than a week.
 */
const WATCH_UNFUNDED_FALLBACK_MS = 2 * 60 * 60_000;
const WATCH_UNFUNDED_MAX_MS = 7 * 24 * 60 * 60_000;
const WATCH_FUNDED_MS = 24 * 60 * 60_000;

function stopWatchingAt(a: AttemptRecord, unfunded: boolean): number {
  const deadline = Date.parse(a.deadline);
  if (!unfunded) return deadline + WATCH_FUNDED_MS;
  const inactive = a.quote.quote.timeWhenInactive ? Date.parse(a.quote.quote.timeWhenInactive) : Number.NaN;
  const until = Number.isNaN(inactive) ? deadline + WATCH_UNFUNDED_FALLBACK_MS : inactive;
  return Math.min(Math.max(until, deadline + WATCH_UNFUNDED_FALLBACK_MS), deadline + WATCH_UNFUNDED_MAX_MS);
}

export interface InvoiceServiceConfig {
  settlementAccountId: string;
  slippageBps: number;
  attemptDeadlineMinutes: number;
  memoChains: string[];
}

export interface InvoiceServiceDeps {
  db: Db;
  client: Pick<OneClickClient, "quote">;
  tokens: TokenCache;
  /** The settlement asset, already resolved against /v0/tokens. */
  settlement: Token;
  config: InvoiceServiceConfig;
  now?: () => Date;
}

export interface CreateInvoiceInput {
  /** Display units of the settlement asset, e.g. "5.00". */
  amount: string;
  description?: string;
  metadata?: Record<string, unknown>;
  expiresInMinutes?: number;
}

export interface CreateAttemptInput {
  /** 1Click assetId the payer chose. */
  originAsset: string;
  /** Where 1Click returns the money if the swap fails, and where a merchant refund goes. */
  refundTo: string;
}

const isDepositModeError = (e: unknown): boolean =>
  e instanceof OneClickError && e.status === 400 && /Incorrect depositMode/i.test(e.message);

export function createInvoiceService(deps: InvoiceServiceDeps) {
  const { db, settlement } = deps;
  const now = deps.now ?? (() => new Date());

  const requireInvoice = (id: string): InvoiceRecord => {
    const inv = findInvoice(db, id);
    if (!inv) throw new ApiError(404, "not_found", `No invoice ${id}`);
    return inv;
  };

  const requireAttempt = (id: string): AttemptRecord => {
    const attempt = findAttempt(db, id);
    if (!attempt) throw new ApiError(404, "not_found", `No attempt ${id}`);
    return attempt;
  };

  const assertAcceptsAttempts = (inv: InvoiceRecord) => {
    if (inv.status !== "open") {
      throw new ApiError(409, "invoice_not_open", `Invoice ${inv.id} is ${inv.status} and cannot be paid.`);
    }
    if (now().toISOString() >= inv.expiresAt) {
      throw new ApiError(409, "invoice_expired", `Invoice ${inv.id} has expired.`);
    }
  };

  /** Ask 1Click for a deposit address. If it says the deposit mode is wrong for the chain, retry once the other way. */
  async function requestQuote(inv: InvoiceRecord, origin: Token, refundTo: string): Promise<QuoteResponse> {
    const build = (depositMode?: "SIMPLE" | "MEMO") =>
      paymentQuoteRequest({
        dry: false,
        originAsset: origin,
        invoiceAmount: inv.amount,
        refundTo,
        settlementAssetId: settlement.assetId,
        settlementAccountId: deps.config.settlementAccountId,
        slippageBps: deps.config.slippageBps,
        deadlineMinutes: deps.config.attemptDeadlineMinutes,
        memoChains: deps.config.memoChains,
        ...(depositMode ? { depositMode } : {}),
        now: now(),
      });
    const first = build();
    try {
      return await deps.client.quote(first);
    } catch (e) {
      if (!isDepositModeError(e)) throw mapQuoteError(e);
      try {
        return await deps.client.quote(build(first.depositMode === "MEMO" ? "SIMPLE" : "MEMO"));
      } catch (retryError) {
        throw mapQuoteError(retryError);
      }
    }
  }

  return {
    async createAttempt(invoiceId: string, input: CreateAttemptInput): Promise<AttemptRecord> {
      assertAcceptsAttempts(requireInvoice(invoiceId));

      const origin = await deps.tokens.findAsset(input.originAsset);
      if (!origin) throw new ApiError(400, "unsupported_asset", `1Click does not list ${input.originAsset}.`);
      const refundTo = input.refundTo.trim();
      const addressCheck = validateAddress(origin.blockchain, refundTo);
      if (!addressCheck.ok) throw new ApiError(400, "invalid_refund_address", addressCheck.reason);

      const since = new Date(now().getTime() - ATTEMPT_WINDOW_MS).toISOString();
      if (countAttemptsSince(db, invoiceId, since) >= ATTEMPT_LIMIT) {
        throw new ApiError(429, "too_many_attempts", "Too many payment attempts for this invoice. Wait a few minutes.");
      }

      const response = await requestQuote(requireInvoice(invoiceId), origin, refundTo);
      const q = response.quote;
      if (!q.depositAddress) throw new ApiError(502, "upstream_error", "1Click returned no deposit address.");

      return db.transaction(() => {
        // The invoice may have been paid or canceled while the quote was in flight; the unused address is simply dropped.
        const inv = requireInvoice(invoiceId);
        assertAcceptsAttempts(inv);
        const at = now();
        const attempt: AttemptRecord = {
          id: newId("att", { now: at.getTime() }),
          invoiceId,
          originAsset: origin.assetId,
          originChain: origin.blockchain,
          originSymbol: origin.symbol,
          originDecimals: origin.decimals,
          refundTo,
          depositAddress: q.depositAddress!,
          depositMemo: q.depositMemo ?? null,
          amountIn: q.amountIn,
          minAmountIn: q.minAmountIn,
          // The deadline we asked for. 1Click's own quote.deadline / timeWhenInactive is days later: it is when the
          // deposit address goes inactive, not when the payer should pay by.
          deadline: response.quoteRequest.deadline,
          quote: response,
          oneclickStatus: "PENDING_DEPOSIT",
          status: "awaiting",
          statusResponse: null,
          depositTxHash: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        };
        insertAttempt(db, attempt);
        supersedeAwaiting(db, invoiceId, attempt.id, at.toISOString());
        return attempt;
      })();
    },

    getAttempt: requireAttempt,

    /**
     * Fold a 1Click status into our records: the attempt status (PLAN section 8), the invoice when this is its
     * first successful payment, and an automatic refund when money arrives for an invoice that cannot take it.
     * Idempotent: only a change of attempt status has effects.
     */
    applyStatus(attemptId: string, response: StatusResponse): AttemptRecord {
      return db.transaction(() => {
        const attempt = requireAttempt(attemptId);
        if (isTerminalAttempt(attempt.status)) return attempt;

        const next = nextAttemptStatus(attempt.status, response.status);
        const at = now();
        updateAttempt(db, attempt.id, {
          status: next,
          oneclickStatus: response.status,
          statusResponse: response,
          depositTxHash: response.swapDetails.originChainTxHashes?.[0]?.hash ?? attempt.depositTxHash,
          updatedAt: at.toISOString(),
        });
        const updated = requireAttempt(attempt.id);
        if (next === attempt.status) return updated;

        const inv = requireInvoice(attempt.invoiceId);
        const proof = proofOf(attempt.quote);
        const base = { invoice: serializeInvoice(inv, settlement), attempt: serializeAttempt(updated) };
        switch (next) {
          case "underpaid":
            enqueueEvent(db, { type: "payment.underpaid", data: base, ...proof }, at);
            break;
          case "refunded":
            enqueueEvent(db, { type: "payment.refunded_by_network", data: base, ...proof }, at);
            break;
          case "failed":
            enqueueEvent(db, { type: "payment.failed", data: base, ...proof }, at);
            break;
          case "paid":
            if (inv.status === "open") {
              updateInvoice(db, inv.id, { status: "paid", paidAttemptId: updated.id, updatedAt: at.toISOString() });
              const paid = requireInvoice(inv.id);
              enqueueEvent(
                db,
                {
                  type: "invoice.paid",
                  data: { invoice: serializeInvoice(paid, settlement), attempt: serializeAttempt(updated) },
                  ...proof,
                },
                at,
              );
            } else {
              // Money arrived for an invoice that is already settled, expired or canceled. Record a refund for
              // the full amount; the refund executor sends it.
              const refund: RefundRecord = {
                id: newId("ref", { now: at.getTime() }),
                invoiceId: inv.id,
                attemptId: updated.id,
                amount: response.swapDetails.amountOut ?? attempt.quote.quote.amountOut,
                reason: "overpayment_auto",
                depositAddress: null,
                intentHash: null,
                status: "pending",
                idempotencyKey: null,
                error: null,
                intentDeadline: null,
                quote: null,
                statusResponse: null,
                tries: 0,
                nextTryAt: at.toISOString(),
                createdAt: at.toISOString(),
                updatedAt: at.toISOString(),
              };
              insertRefund(db, refund);
              const cause = { paid: "invoice_already_paid", expired: "invoice_expired", canceled: "invoice_canceled" }[
                inv.status
              ];
              enqueueEvent(
                db,
                {
                  type: "payment.duplicate_refunded",
                  data: { cause, ...base, refund: serializeRefund(refund, settlement) },
                  ...proof,
                },
                at,
              );
            }
            break;
          default:
            break;
        }
        return updated;
      })();
    },

    /**
     * Expire open invoices past their time that have no payment on the way. An invoice with a confirming
     * attempt waits, so a deposit already in flight is not refunded just for being slow. Returns how many expired.
     */
    expireInvoices(): number {
      let expired = 0;
      for (const due of listInvoicesDueToExpire(db, now().toISOString())) {
        db.transaction(() => {
          const inv = requireInvoice(due.id);
          if (inv.status !== "open" || countAttemptsWithStatus(db, inv.id, "confirming") > 0) return;
          updateInvoice(db, inv.id, { status: "expired", updatedAt: now().toISOString() });
          enqueueEvent(
            db,
            { type: "invoice.expired", data: { invoice: serializeInvoice(requireInvoice(inv.id), settlement) } },
            now(),
          );
          expired++;
        })();
      }
      return expired;
    },

    /** Attempts the watcher should still poll, oldest first. */
    listPollableAttempts(): AttemptRecord[] {
      const nowMs = now().getTime();
      return listLiveAttempts(db).filter((a) => {
        const unfunded = a.status === "awaiting" || a.status === "superseded";
        return nowMs < stopWatchingAt(a, unfunded);
      });
    },

    createInvoice(input: CreateInvoiceInput): InvoiceRecord {
      let amount: string;
      try {
        amount = toBaseUnits(input.amount, settlement.decimals);
      } catch (e) {
        if (e instanceof MoneyError) throw new ApiError(400, "invalid_amount", e.message);
        throw e;
      }
      if (BigInt(amount) <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");

      const minutes = input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRY_MINUTES) {
        throw new ApiError(
          400,
          "invalid_expiry",
          `expiresInMinutes must be a whole number from 1 to ${MAX_EXPIRY_MINUTES}.`,
        );
      }

      const created = now();
      const inv: InvoiceRecord = {
        id: newId("inv", { now: created.getTime() }),
        amount,
        assetId: settlement.assetId,
        description: input.description ?? null,
        metadata: input.metadata ?? null,
        status: "open",
        paidAttemptId: null,
        refundedAmount: "0",
        expiresAt: new Date(created.getTime() + minutes * 60_000).toISOString(),
        createdAt: created.toISOString(),
        updatedAt: created.toISOString(),
      };
      insertInvoice(db, inv);
      return inv;
    },

    getInvoice: requireInvoice,

    /** The invoice with every attempt and refund, for the merchant's detail view. */
    getInvoiceDetail(id: string) {
      return {
        invoice: requireInvoice(id),
        attempts: listAttemptsForInvoice(db, id),
        refunds: listRefundsForInvoice(db, id),
      };
    },

    /** For the dashboard's overview: what was paid since midnight UTC, and how many invoices are open. */
    stats() {
      const at = now();
      const paid = paidSince(db, `${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return { day: at.toISOString().slice(0, 10), paidToday: paid, open: countInvoices(db, "open") };
    },

    listInvoices(q: { status?: InvoiceStatus; limit?: number; cursor?: string; search?: string }) {
      const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(q.limit ?? DEFAULT_PAGE)));
      const rows = pageInvoices(db, { status: q.status, cursor: q.cursor, search: q.search, limit: limit + 1 });
      const invoices = rows.slice(0, limit);
      return { invoices, nextCursor: rows.length > limit ? invoices[invoices.length - 1]!.id : null };
    },

    cancelInvoice(id: string): InvoiceRecord {
      return db.transaction(() => {
        const inv = requireInvoice(id);
        if (inv.status !== "open") {
          throw new ApiError(
            409,
            "invoice_not_open",
            `Invoice ${id} is ${inv.status}, only open invoices can be canceled.`,
          );
        }
        if (countAttemptsWithStatus(db, id, "confirming") > 0) {
          throw new ApiError(
            409,
            "payment_in_progress",
            "A payment for this invoice is being processed and cannot be canceled.",
          );
        }
        const at = now().toISOString();
        updateInvoice(db, id, { status: "canceled", updatedAt: at });
        const canceled = requireInvoice(id);
        enqueueEvent(
          db,
          { type: "invoice.canceled", data: { invoice: serializeInvoice(canceled, settlement) } },
          now(),
        );
        return canceled;
      })();
    },
  };
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;
