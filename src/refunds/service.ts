import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { enqueueEvent } from "../events.js";
import { newId } from "../ids.js";
import {
  addToLedger,
  findAttempt,
  findInvoice,
  findRefund,
  findRefundByKey,
  claimAutoRefundTry,
  insertRefund,
  ledgerTotal,
  listDueAutoRefunds,
  listOpenRefunds,
  pageRefunds,
  updateInvoice,
  updateRefund,
  type AttemptRecord,
  type InvoiceRecord,
  type RefundRecord,
} from "../invoices/repo.js";
import { serializeInvoice, serializeRefund } from "../invoices/serialize.js";
import { MoneyError, fromBaseUnits, toBaseUnits } from "../money.js";
import type { Nep413Payload } from "../near/nep413.js";
import { NearRpcError } from "../near/rpc.js";
import { mapQuoteError } from "../oneclick/apiErrors.js";
import { proofOf } from "../oneclick/signature.js";
import { OneClickError, type OneClickClient } from "../oneclick/client.js";
import { refundQuoteRequest } from "../oneclick/requests.js";
import type { QuoteResponse, StatusResponse, Token } from "../oneclick/types.js";
import { IntentPolicyError, assertSafeToSign } from "./intentPolicy.js";

/** A refund that never got as far as signing, and has not moved on after this long, was cut short (a crash). */
const INTERRUPTED_AFTER_MS = 10 * 60_000;
/** How long after a signed intent expires we still wait for a deposit that was in flight. */
const UNFUNDED_GRACE_MS = 5 * 60_000;

/**
 * An automatic refund that failed before anything was signed is tried again after these pauses (PLAN section 13's
 * webhook schedule), and failed after the sixth try.
 */
const AUTO_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
/** While a try runs, nothing else may start it. A crash leaves the refund due again after this long. */
const AUTO_CLAIM_MS = 5 * 60_000;

const NOTE =
  "Refunds return the value at today's price, so the customer may receive a different amount than they paid.";

export interface RefundServiceConfig {
  settlementAccountId: string;
  /** The verifier contract the signed intent is addressed to. */
  intentsContract: string;
  slippageBps: number;
  /** Base units of the settlement asset (PLAN section 6: REFUND_MAX_PER_TX / REFUND_MAX_PER_DAY). */
  maxPerTx: bigint;
  maxPerDay: bigint;
}

export interface RefundServiceDeps {
  db: Db;
  client: Pick<OneClickClient, "quote" | "generateIntent" | "submitIntent">;
  /** The settlement asset, already resolved against /v0/tokens. */
  settlement: Token;
  config: RefundServiceConfig;
  /** The settlement account's balance of the settlement asset inside the verifier, in base units. */
  readBalance: () => Promise<bigint>;
  /** Signs a NEP-413 payload with the settlement key. The key itself never enters this service. */
  sign: (payload: Nep413Payload) => { public_key: string; signature: string };
  /** Where automatic refunds are reported. Receives no secrets. */
  log?: { info(message: string): void };
  now?: () => Date;
}

export interface RefundInput {
  /** Display units of the settlement asset, e.g. "2.50". Defaults to everything still refundable. */
  amount?: string;
}

export interface RequestRefundInput extends RefundInput {
  /** Chosen by the merchant. The same key for the same invoice always means the same refund. */
  idempotencyKey: string;
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

/** 1Click has the refund's deposit (it is being swapped), so the money has left the Intents balance. */
const depositSeen = (r: RefundRecord) =>
  r.statusResponse?.status === "KNOWN_DEPOSIT_TX" || r.statusResponse?.status === "PROCESSING";

const day = (at: Date) => at.toISOString().slice(0, 10);
const isOpen = (r: RefundRecord) => r.status === "pending" || r.status === "submitted";
const isMerchantRequest = (r: RefundRecord) => r.reason === "merchant_request";

const refundFailed = (cause: unknown) =>
  cause instanceof OneClickError
    ? new ApiError(502, "refund_failed", cause.message)
    : new ApiError(502, "refund_failed", cause instanceof Error ? cause.message : String(cause));

export function createRefundService(deps: RefundServiceDeps) {
  const { db, settlement, config } = deps;
  const now = deps.now ?? (() => new Date());

  const requireInvoice = (id: string): InvoiceRecord => {
    const inv = findInvoice(db, id);
    if (!inv) throw new ApiError(404, "not_found", `No invoice ${id}`);
    return inv;
  };

  const requireRefund = (id: string): RefundRecord => {
    const refund = findRefund(db, id);
    if (!refund) throw new ApiError(404, "not_found", `No refund ${id}`);
    return refund;
  };

  /** The attempt that was paid: the refund goes back to the chain, asset and address it came from. */
  const paidAttempt = (inv: InvoiceRecord): AttemptRecord => {
    const attempt = inv.status === "paid" && inv.paidAttemptId ? findAttempt(db, inv.paidAttemptId) : undefined;
    if (!attempt) {
      throw new ApiError(
        409,
        "invoice_not_paid",
        `Invoice ${inv.id} is ${inv.status}, only a paid invoice can be refunded.`,
      );
    }
    return attempt;
  };

  /** Merchant refunds that may still move money: they are spoken for. Automatic ones are not (Phase 6). */
  const inFlight = (invoiceId?: string): bigint =>
    listOpenRefunds(db)
      .filter((r) => isMerchantRequest(r) && (invoiceId === undefined || r.invoiceId === invoiceId))
      .reduce((sum, r) => sum + BigInt(r.amount), 0n);

  /**
   * Money spoken for in the settlement balance: merchant refunds, and any refund whose intent is already signed, until
   * 1Click has seen its deposit. From then on the balance has already gone down by that amount, and counting it again
   * would turn away refunds that the money covers.
   */
  const reserved = (): bigint =>
    listOpenRefunds(db)
      .filter((r) => (isMerchantRequest(r) || r.intentDeadline !== null) && !depositSeen(r))
      .reduce((sum, r) => sum + BigInt(r.amount), 0n);

  const remaining = (inv: InvoiceRecord): bigint => BigInt(inv.amount) - BigInt(inv.refundedAmount) - inFlight(inv.id);

  const amountFor = (inv: InvoiceRecord, input: RefundInput): bigint => {
    const left = remaining(inv);
    if (left <= 0n) throw new ApiError(409, "nothing_to_refund", `Invoice ${inv.id} has nothing left to refund.`);
    if (input.amount === undefined) return left;
    let amount: bigint;
    try {
      amount = BigInt(toBaseUnits(input.amount, settlement.decimals));
    } catch (e) {
      if (e instanceof MoneyError) throw new ApiError(400, "invalid_amount", e.message);
      throw e;
    }
    if (amount <= 0n) throw new ApiError(400, "invalid_amount", "Amount must be greater than zero.");
    if (amount > left) {
      throw new ApiError(
        409,
        "refund_exceeds_remaining",
        `Only ${fromBaseUnits(left.toString(), settlement.decimals)} ${settlement.symbol} can still be refunded on invoice ${inv.id}.`,
      );
    }
    return amount;
  };

  async function balance(): Promise<bigint> {
    try {
      return await deps.readBalance();
    } catch (e) {
      if (e instanceof NearRpcError) {
        throw new ApiError(503, "upstream_unavailable", `Could not read the settlement balance: ${e.message}`);
      }
      throw e;
    }
  }

  const display = (base: bigint) => `${fromBaseUnits(base.toString(), settlement.decimals)} ${settlement.symbol}`;

  /** The limits that apply to a refund the merchant asks for. Throws; reserves nothing. */
  const assertAllowed = (inv: InvoiceRecord, amount: bigint, held: bigint) => {
    if (amount > config.maxPerTx) {
      throw new ApiError(422, "refund_limit_exceeded", `A single refund is limited to ${display(config.maxPerTx)}.`);
    }
    if (ledgerTotal(db, day(now())) + amount > config.maxPerDay) {
      throw new ApiError(422, "daily_refund_limit", `Refunds are limited to ${display(config.maxPerDay)} per day.`);
    }
    if (held - reserved() < amount) {
      throw new ApiError(
        409,
        "insufficient_balance",
        `The settlement balance cannot cover ${display(amount)} for invoice ${inv.id} right now.`,
      );
    }
  };

  const replayOf = (existing: RefundRecord, input: RefundInput) => {
    if (input.amount !== undefined) {
      let asked: string | undefined;
      try {
        asked = toBaseUnits(input.amount, settlement.decimals);
      } catch {
        asked = undefined;
      }
      if (asked !== existing.amount) {
        throw new ApiError(
          409,
          "idempotency_key_reused",
          "This idempotency key was already used for a refund of a different amount. Use a new key.",
        );
      }
    }
    return { refund: existing, replayed: true };
  };

  const refundEvent = (type: "refund.succeeded" | "refund.failed", refund: RefundRecord, at: Date) => {
    const proof = refund.quote ? proofOf(refund.quote) : undefined;
    enqueueEvent(
      db,
      {
        type,
        data: {
          invoice: serializeInvoice(requireInvoice(refund.invoiceId), settlement),
          refund: serializeRefund(refund, settlement),
        },
        ...proof,
      },
      at,
    );
  };

  /** End a refund as failed, give its allowance back, and tell the merchant if they are not already being told. */
  const failRefund = (id: string, message: string, options: { notify: boolean; response?: StatusResponse }) =>
    db.transaction(() => {
      const refund = requireRefund(id);
      if (!isOpen(refund)) return refund;
      const at = now();
      updateRefund(db, id, {
        status: "failed",
        error: message,
        ...(options.response ? { statusResponse: options.response } : {}),
        updatedAt: at.toISOString(),
      });
      if (isMerchantRequest(refund)) addToLedger(db, day(new Date(refund.createdAt)), -BigInt(refund.amount));
      const failed = requireRefund(id);
      if (options.notify) refundEvent("refund.failed", failed, at);
      return failed;
    })();

  /** Record that 1Click has the intent. Never undoes an ending a status poll already recorded. */
  const markSubmitted = (id: string, intentHash: string) =>
    db.transaction(() => {
      const refund = requireRefund(id);
      updateRefund(db, id, {
        intentHash,
        clearError: true,
        ...(refund.status === "pending" ? { status: "submitted" as const } : {}),
        updatedAt: now().toISOString(),
      });
      return requireRefund(id);
    })();

  const quoteFor = (attempt: AttemptRecord, amount: bigint, dry: boolean) =>
    refundQuoteRequest({
      dry,
      settlementAssetId: settlement.assetId,
      settlementAccountId: config.settlementAccountId,
      destinationAsset: attempt.originAsset,
      amount: amount.toString(),
      refundAddress: attempt.refundTo,
      slippageBps: config.slippageBps,
      now: now(),
    });

  /**
   * PLAN section 9, steps 2 to 5, for a refund that has been reserved. When a step fails before the intent is
   * submitted, `abandon` is told why and the failure is thrown as an ApiError.
   */
  async function execute(
    refund: RefundRecord,
    attempt: AttemptRecord,
    amount: bigint,
    abandon: (message: string) => void,
  ) {
    let quote: QuoteResponse;
    try {
      quote = await deps.client.quote(quoteFor(attempt, amount, false));
    } catch (e) {
      const mapped = mapQuoteError(e);
      abandon(mapped instanceof Error ? mapped.message : String(mapped));
      throw mapped;
    }
    const depositAddress = quote.quote.depositAddress;
    if (!depositAddress) {
      const message = "1Click returned no deposit address for the refund.";
      abandon(message);
      throw new ApiError(502, "upstream_error", message);
    }
    updateRefund(db, refund.id, { depositAddress, quote, updatedAt: now().toISOString() });

    let generated;
    try {
      generated = await deps.client.generateIntent({
        type: "swap_transfer",
        standard: "nep413",
        signerId: config.settlementAccountId,
        depositAddress,
      });
    } catch (e) {
      const error = refundFailed(e);
      abandon(error.message);
      throw error;
    }

    // The payload is signed exactly as 1Click made it, and only after it is checked against what we asked for.
    const payload = generated.intent.payload;
    let deadline: Date;
    try {
      ({ deadline } = assertSafeToSign(payload, {
        signerId: config.settlementAccountId,
        verifier: config.intentsContract,
        settlementAssetId: settlement.assetId,
        amount,
        depositAddress,
        now: now(),
      }));
    } catch (e) {
      if (!(e instanceof IntentPolicyError)) throw e;
      abandon(e.message);
      throw new ApiError(502, "intent_refused", e.message);
    }

    let signed;
    try {
      signed = deps.sign(payload);
    } catch (e) {
      const message = `The settlement key could not sign the refund: ${e instanceof Error ? e.message : String(e)}`;
      abandon(message);
      throw new ApiError(500, "signing_failed", message);
    }
    // Recorded before the intent leaves: from here on it may land, so the refund must not be written off as unfunded
    // until the intent has expired.
    updateRefund(db, refund.id, { intentDeadline: deadline.toISOString(), updatedAt: now().toISOString() });

    let submitted;
    try {
      submitted = await deps.client.submitIntent({
        type: "swap_transfer",
        signedData: { ...generated.intent, ...signed },
      });
    } catch (e) {
      // Without an answer, or after a server error, the intent may or may not have been accepted. The watcher finds out.
      if (e instanceof OneClickError && (e.status === 0 || e.status >= 500)) return requireRefund(refund.id);
      const error = refundFailed(e);
      abandon(error.message);
      throw error;
    }
    return markSubmitted(refund.id, submitted.intentHash);
  }

  return {
    /** The account whose balance funds refunds. */
    account: config.settlementAccountId,

    get: requireRefund,

    /** Newest first, every invoice. `cursor` is the last id of the previous page. */
    list(q: { cursor?: string; limit?: number }) {
      const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 25)));
      const rows = pageRefunds(db, { cursor: q.cursor, limit: limit + 1 });
      const refunds = rows.slice(0, limit);
      return { refunds, nextCursor: rows.length > limit ? refunds[refunds.length - 1]!.id : null };
    },

    /** The merchant's refund limits, and what today's refunds have used of the daily one. */
    limits() {
      return { maxPerTx: config.maxPerTx, maxPerDay: config.maxPerDay, usedToday: ledgerTotal(db, day(now())) };
    },

    balance,

    async preview(invoiceId: string, input: RefundInput): Promise<RefundPreview> {
      const inv = requireInvoice(invoiceId);
      const attempt = paidAttempt(inv);
      const amount = amountFor(inv, input);
      assertAllowed(inv, amount, await balance());

      let response: QuoteResponse;
      try {
        response = await deps.client.quote(quoteFor(attempt, amount, true));
      } catch (e) {
        throw mapQuoteError(e);
      }
      const q = response.quote;
      return {
        invoiceId: inv.id,
        amount: fromBaseUnits(amount.toString(), settlement.decimals),
        amountBase: amount.toString(),
        destination: {
          assetId: attempt.originAsset,
          chain: attempt.originChain,
          symbol: attempt.originSymbol,
          decimals: attempt.originDecimals,
          address: attempt.refundTo,
        },
        estimate: {
          amountOut: q.amountOut,
          amountOutFormatted: q.amountOutFormatted,
          amountOutUsd: q.amountOutUsd,
          withdrawFee: q.withdrawFee ?? null,
          timeEstimate: q.timeEstimate,
        },
        note: NOTE,
      };
    },

    /**
     * PLAN section 9. Reserves the amount (against the invoice, the daily limit and the balance) in one step, before
     * anything is sent, so a repeat or a parallel request cannot pay twice. Returns once the intent is submitted.
     */
    async refund(invoiceId: string, input: RequestRefundInput): Promise<{ refund: RefundRecord; replayed: boolean }> {
      const existing = findRefundByKey(db, invoiceId, input.idempotencyKey);
      if (existing) return replayOf(existing, input);

      const inv = requireInvoice(invoiceId);
      const attempt = paidAttempt(inv);
      const held = await balance();

      const placed = db.transaction(() => {
        // Checked again inside the transaction: a request with the same key may have got in while the balance was read.
        const raced = findRefundByKey(db, invoiceId, input.idempotencyKey);
        if (raced) return replayOf(raced, input);

        const fresh = requireInvoice(invoiceId);
        paidAttempt(fresh);
        const amount = amountFor(fresh, input);
        assertAllowed(fresh, amount, held);

        const at = now();
        const refund: RefundRecord = {
          id: newId("ref", { now: at.getTime() }),
          invoiceId,
          attemptId: attempt.id,
          amount: amount.toString(),
          reason: "merchant_request",
          depositAddress: null,
          intentHash: null,
          status: "pending",
          idempotencyKey: input.idempotencyKey,
          error: null,
          intentDeadline: null,
          quote: null,
          statusResponse: null,
          tries: 0,
          nextTryAt: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        };
        insertRefund(db, refund);
        addToLedger(db, day(at), amount);
        return { refund, replayed: false };
      })();
      if (placed.replayed) return placed;

      const done = await execute(placed.refund, attempt, BigInt(placed.refund.amount), (message) =>
        failRefund(placed.refund.id, message, { notify: false }),
      );
      return { refund: done, replayed: false };
    },

    /** Automatic refunds whose time has come for a try. */
    listDueAutoRefunds(): RefundRecord[] {
      return listDueAutoRefunds(db, now().toISOString());
    },

    /**
     * One try of an automatic refund (a duplicate or late payment, PLAN section 8): the whole amount goes back to
     * the address that payment came from, outside the merchant's per-refund and daily limits. A failure before
     * anything is signed schedules another try, and the sixth failure ends the refund and tells the merchant. A try
     * whose outcome is unknown is not repeated: the signed intent may still land, and the watcher finds out.
     */
    async executeAutoRefund(id: string): Promise<RefundRecord> {
      const refund = requireRefund(id);
      if (refund.reason !== "overpayment_auto") {
        throw new Error(`Refund ${id} is not an automatic refund.`);
      }
      const at = now();
      if (!claimAutoRefundTry(db, id, at.toISOString(), new Date(at.getTime() + AUTO_CLAIM_MS).toISOString())) {
        return requireRefund(id);
      }
      const attempt = findAttempt(db, refund.attemptId);
      if (!attempt) throw new Error(`Refund ${id} points at a missing attempt ${refund.attemptId}.`);
      const amount = BigInt(refund.amount);
      try {
        const held = await balance();
        if (held - reserved() < amount) {
          throw new ApiError(
            409,
            "insufficient_balance",
            `The settlement balance cannot cover the automatic refund of ${display(amount)} yet.`,
          );
        }
        deps.log?.info(
          `Automatic refund ${id} of ${display(amount)} for invoice ${refund.invoiceId} (a payment it could not take) is being sent.`,
        );
        return await execute(refund, attempt, amount, () => undefined);
      } catch (e) {
        // Whatever went wrong counts as one of the six tries; an ApiError is a definite answer (nothing moved, even if an
        // intent had been signed), anything else is an unexpected failure and is still thrown, so it reaches the log.
        const definite = e instanceof ApiError;
        const message = e instanceof Error ? e.message : String(e);
        const recorded = db.transaction(() => {
          const current = requireRefund(id);
          if (!isOpen(current)) return current;
          // A signed intent that may have been accepted is the watcher's to resolve, never a reason to send another.
          if (current.intentDeadline !== null && !definite) return current;
          if (current.tries >= AUTO_RETRY_DELAYS_MS.length + 1) return failRefund(id, message, { notify: true });
          const wait = AUTO_RETRY_DELAYS_MS[current.tries - 1]!;
          updateRefund(db, id, {
            error: message,
            nextTryAt: new Date(now().getTime() + wait).toISOString(),
            ...(current.intentDeadline !== null ? { clearIntentDeadline: true } : {}),
            updatedAt: now().toISOString(),
          });
          return requireRefund(id);
        })();
        if (!definite) throw e;
        return recorded;
      }
    },

    /** Refunds whose signed intent is out, which the watcher should ask 1Click about. */
    listPollableRefunds(): RefundRecord[] {
      return listOpenRefunds(db).filter((r) => r.depositAddress !== null && r.intentDeadline !== null);
    },

    /** Fold a 1Click status for a refund's deposit address into our records. Only a change has effects. */
    applyRefundStatus(id: string, response: StatusResponse): RefundRecord {
      return db.transaction(() => {
        const refund = requireRefund(id);
        if (!isOpen(refund)) return refund;
        const at = now();
        const seen = { statusResponse: response, updatedAt: at.toISOString() };

        switch (response.status) {
          case "SUCCESS": {
            updateRefund(db, id, { status: "succeeded", ...seen });
            if (isMerchantRequest(refund)) {
              const inv = requireInvoice(refund.invoiceId);
              updateInvoice(db, inv.id, {
                refundedAmount: (BigInt(inv.refundedAmount) + BigInt(refund.amount)).toString(),
                updatedAt: at.toISOString(),
              });
            }
            refundEvent("refund.succeeded", requireRefund(id), at);
            break;
          }
          case "FAILED":
          case "REFUNDED": {
            const reason = response.swapDetails.refundReason;
            failRefund(id, `1Click reported ${response.status}${reason ? `: ${reason}` : ""}.`, {
              notify: true,
              response,
            });
            break;
          }
          case "KNOWN_DEPOSIT_TX":
          case "PROCESSING":
            updateRefund(db, id, { status: "submitted", ...seen });
            break;
          default: {
            const expiry = refund.intentDeadline ? Date.parse(refund.intentDeadline) + UNFUNDED_GRACE_MS : Infinity;
            if (at.getTime() > expiry) {
              failRefund(id, "The refund was never funded and its signed intent has expired.", {
                notify: true,
                response,
              });
            } else {
              updateRefund(db, id, seen);
            }
          }
        }
        return requireRefund(id);
      })();
    },

    /**
     * Fail merchant refunds that were cut short before anything was signed (nothing moved, so this is safe).
     * Returns how many. A refund with a signed intent is never touched here: that intent may still land.
     */
    failInterrupted(): number {
      const cutoff = now().getTime() - INTERRUPTED_AFTER_MS;
      let failed = 0;
      for (const refund of listOpenRefunds(db)) {
        if (!isMerchantRequest(refund) || refund.intentDeadline !== null) continue;
        if (Date.parse(refund.createdAt) >= cutoff) continue;
        failRefund(
          refund.id,
          "The refund was interrupted before it was signed, and nothing was sent. Request it again.",
          {
            notify: true,
          },
        );
        failed++;
      }
      return failed;
    },
  };
}

export type RefundService = ReturnType<typeof createRefundService>;
