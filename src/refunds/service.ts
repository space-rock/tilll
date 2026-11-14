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
  insertRefund,
  countRefundsByStatus,
  ledgerTotal,
  listOpenRefunds,
  pageRefunds,
  updateInvoice,
  updateRefund,
  type AttemptRecord,
  type InvoiceRecord,
  type RefundRecord,
  type RefundStatus,
} from "../invoices/repo.js";
import { serializeInvoice, serializeRefund } from "../invoices/serialize.js";
import { MoneyError, fromBaseUnits, toBaseUnits } from "../money.js";
import {
  INTENTS_KEY_TYPES,
  implicitAccountOfPublicKey,
  keyTypeOf,
  normalizePublicKey,
  normalizeSignature,
} from "../near/keys.js";
import { verifyNep413 } from "../near/nep413.js";
import { NearRpcError } from "../near/rpc.js";
import { mapQuoteError } from "../oneclick/apiErrors.js";
import { proofOf } from "../oneclick/signature.js";
import { OneClickError, type OneClickClient } from "../oneclick/client.js";
import { quoteMismatch, refundQuoteRequest } from "../oneclick/requests.js";
import type { QuoteResponse, StatusResponse } from "../oneclick/types.js";
import type { SettingsReader } from "../settings/store.js";
import { IntentPolicyError, assertSafeToSign } from "./intentPolicy.js";

/** How long after a signed intent expires we still wait for a deposit that was in flight. */
const UNFUNDED_GRACE_MS = 5 * 60_000;

const NOTE =
  "Refunds return the value at today's price, so the customer may receive a different amount than they paid.";

export interface RefundServiceConfig {
  /** The verifier contract the signed intent is addressed to. */
  intentsContract: string;
}

export interface RefundServiceDeps {
  db: Db;
  client: Pick<OneClickClient, "quote" | "generateIntent" | "submitIntent">;
  /** The settlement account and asset, the slippage and the refund limits: read again for every operation. */
  settings: SettingsReader;
  config: RefundServiceConfig;
  /** The settlement account's balance of the settlement asset inside the verifier, in base units. */
  readBalance: () => Promise<bigint>;
  /**
   * Whether `publicKey` (`ed25519:<base58>`) is registered on the verifier contract for the settlement account. A key
   * that is the settlement account's own implicit key needs no registration and is not asked about.
   */
  keyRegistered: (publicKey: string) => Promise<boolean>;
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
const isOpen = (r: RefundRecord) =>
  r.status === "awaiting_approval" || r.status === "pending" || r.status === "submitted";
/** A status as words: `awaiting_approval` reads as "awaiting approval" in a sentence. */
const words = (status: string) => status.replace(/_/g, " ");

const isMerchantRequest = (r: RefundRecord) => r.reason === "merchant_request";

const refundFailed = (cause: unknown) =>
  cause instanceof OneClickError
    ? new ApiError(502, "refund_failed", cause.message)
    : new ApiError(502, "refund_failed", cause instanceof Error ? cause.message : String(cause));

export function createRefundService(deps: RefundServiceDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const settings = () => deps.settings.current();
  const assetOf = (inv: InvoiceRecord) => deps.settings.tokenFor(inv.assetId);

  const requireInvoice = (id: string): InvoiceRecord => {
    const inv = findInvoice(db, id);
    if (!inv) throw new ApiError(404, "not_found", `We couldn't find invoice ${id}.`);
    return inv;
  };

  const requireRefund = (id: string): RefundRecord => {
    const refund = findRefund(db, id);
    if (!refund) throw new ApiError(404, "not_found", `We couldn't find refund ${id}.`);
    return refund;
  };

  /**
   * Refunds are paid from the settlement account's balance of the settlement asset. An invoice that was paid to another
   * account or in another asset (before the merchant changed them) is not in that balance, so Tilll cannot refund it.
   */
  const assertCurrent = (inv: InvoiceRecord) => {
    const s = settings();
    if (inv.settlementAccount === s.accountId && inv.assetId === s.asset.assetId) return;
    const was = assetOf(inv);
    throw new ApiError(
      409,
      "settlement_changed",
      `Invoice ${inv.id} was paid to ${inv.settlementAccount} in ${was.symbol}, before the settlement account or asset changed. ` +
        `Send this refund from that account's wallet.`,
    );
  };

  /** The attempt that was paid: the refund goes back to the chain, asset and address it came from. */
  const paidAttempt = (inv: InvoiceRecord): AttemptRecord => {
    const attempt = inv.status === "paid" && inv.paidAttemptId ? findAttempt(db, inv.paidAttemptId) : undefined;
    if (!attempt) {
      throw new ApiError(
        409,
        "invoice_not_paid",
        `Invoice ${inv.id} is ${inv.status}, so it can't be refunded. Only paid invoices can be refunded.`,
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
    const { asset: settlement } = settings();
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
        throw new ApiError(503, "upstream_unavailable", `We couldn't read the settlement balance: ${e.message}`);
      }
      throw e;
    }
  }

  const display = (base: bigint) => {
    const { asset } = settings();
    return `${fromBaseUnits(base.toString(), asset.decimals)} ${asset.symbol}`;
  };

  /** The limits that apply to a refund the merchant asks for. Throws; reserves nothing. */
  const assertAllowed = (inv: InvoiceRecord, amount: bigint, held: bigint) => {
    const { maxPerTx, maxPerDay, asset } = settings();
    if (amount > maxPerTx) {
      throw new ApiError(422, "refund_limit_exceeded", `A single refund is limited to ${display(maxPerTx)}.`);
    }
    if (ledgerTotal(db, day(now()), asset.assetId) + amount > maxPerDay) {
      throw new ApiError(422, "daily_refund_limit", `Refunds are limited to ${display(maxPerDay)} per day.`);
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
        asked = toBaseUnits(input.amount, settings().asset.decimals);
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

  const refundEvent = (
    type: "refund.awaiting_approval" | "refund.succeeded" | "refund.failed",
    refund: RefundRecord,
    at: Date,
  ) => {
    const proof = refund.quote ? proofOf(refund.quote) : undefined;
    const inv = requireInvoice(refund.invoiceId);
    enqueueEvent(
      db,
      {
        type,
        data: {
          invoice: serializeInvoice(inv, assetOf(inv)),
          refund: serializeRefund(refund, assetOf(inv)),
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
      if (isMerchantRequest(refund)) {
        const { assetId } = assetOf(requireInvoice(refund.invoiceId));
        addToLedger(db, day(new Date(refund.createdAt)), assetId, -BigInt(refund.amount));
      }
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

  const quoteFor = (attempt: AttemptRecord, amount: bigint, dry: boolean) => {
    const s = settings();
    return refundQuoteRequest({
      dry,
      settlementAssetId: s.asset.assetId,
      settlementAccountId: s.accountId,
      destinationAsset: attempt.originAsset,
      amount: amount.toString(),
      refundAddress: attempt.refundTo,
      slippageBps: s.slippageBps,
      now: now(),
    });
  };

  /** Remember why a refund could not move on. It stays waiting for approval, so the merchant can try again. */
  const noteError = (id: string, message: string) =>
    updateRefund(db, id, { error: message, updatedAt: now().toISOString() });

  const summaryOf = (refund: RefundRecord, attempt: AttemptRecord, quote: QuoteResponse) => ({
    amount: fromBaseUnits(refund.amount, settings().asset.decimals),
    amountBase: refund.amount,
    destination: {
      assetId: attempt.originAsset,
      chain: attempt.originChain,
      symbol: attempt.originSymbol,
      decimals: attempt.originDecimals,
      address: attempt.refundTo,
    },
    estimate: {
      amountOut: quote.quote.amountOut,
      amountOutFormatted: quote.quote.amountOutFormatted,
      amountOutUsd: quote.quote.amountOutUsd,
      withdrawFee: quote.quote.withdrawFee ?? null,
      timeEstimate: quote.quote.timeEstimate,
    },
  });

  return {
    /** The account whose balance funds refunds. */
    get account() {
      return settings().accountId;
    },

    get: requireRefund,

    /** Newest first, every invoice. `cursor` is the last id of the previous page. */
    list(q: { cursor?: string; limit?: number; status?: RefundStatus }) {
      const limit = Math.min(100, Math.max(1, Math.floor(q.limit ?? 25)));
      const rows = pageRefunds(db, { cursor: q.cursor, limit: limit + 1, status: q.status });
      const refunds = rows.slice(0, limit);
      return { refunds, nextCursor: rows.length > limit ? refunds[refunds.length - 1]!.id : null };
    },

    /** How many refunds are in each status. */
    counts: () => countRefundsByStatus(db),

    /** The merchant's refund limits, and what today's refunds have used of the daily one. */
    limits() {
      const s = settings();
      return { maxPerTx: s.maxPerTx, maxPerDay: s.maxPerDay, usedToday: ledgerTotal(db, day(now()), s.asset.assetId) };
    },

    balance,

    async preview(invoiceId: string, input: RefundInput): Promise<RefundPreview> {
      const inv = requireInvoice(invoiceId);
      assertCurrent(inv);
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
        amount: fromBaseUnits(amount.toString(), settings().asset.decimals),
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
      assertCurrent(inv);
      const attempt = paidAttempt(inv);
      const held = await balance();

      const placed = db.transaction(() => {
        // Checked again inside the transaction: a request with the same key may have got in while the balance was read.
        const raced = findRefundByKey(db, invoiceId, input.idempotencyKey);
        if (raced) return replayOf(raced, input);

        const fresh = requireInvoice(invoiceId);
        assertCurrent(fresh);
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
          status: "awaiting_approval",
          idempotencyKey: input.idempotencyKey,
          error: null,
          intentDeadline: null,
          quote: null,
          statusResponse: null,
          payload: null,
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        };
        insertRefund(db, refund);
        addToLedger(db, day(at), fresh.assetId, amount);
        refundEvent("refund.awaiting_approval", refund, at);
        return { refund, replayed: false };
      })();
      return placed;
    },

    /**
     * Step 2 of a refund: get a fresh quote and intent from 1Click for a refund waiting for approval, check the intent
     * (`assertSafeToSign`), keep it, and hand the payload to the wallet. Quotes and intents expire, so this runs when
     * the merchant is about to sign, and can be run again. A failure leaves the refund waiting, with the reason.
     */
    async prepare(id: string) {
      const refund = requireRefund(id);
      if (refund.status !== "awaiting_approval") {
        throw new ApiError(
          409,
          "not_awaiting_approval",
          `Refund ${id} is ${words(refund.status)}. Only a refund waiting for approval can be prepared.`,
        );
      }
      assertCurrent(requireInvoice(refund.invoiceId));
      const attempt = findAttempt(db, refund.attemptId);
      if (!attempt) throw new Error(`Refund ${id} points at a missing attempt ${refund.attemptId}.`);
      const amount = BigInt(refund.amount);
      const s = settings();

      const held = await balance();
      // A merchant refund is already counted in `reserved()`; an automatic one is not.
      const others = reserved() - (isMerchantRequest(refund) ? amount : 0n);
      if (held - others < amount) {
        const error = new ApiError(
          409,
          "insufficient_balance",
          `The settlement balance cannot cover ${display(amount)} for invoice ${refund.invoiceId} right now.`,
        );
        noteError(id, error.message);
        throw error;
      }

      const asked = quoteFor(attempt, amount, false);
      let quote: QuoteResponse;
      try {
        quote = await deps.client.quote(asked);
      } catch (e) {
        const mapped = mapQuoteError(e);
        noteError(id, mapped instanceof Error ? mapped.message : String(mapped));
        throw mapped;
      }
      // The wallet is about to pay this quote's deposit address, so the quote has to be for the refund we asked for.
      const field = quoteMismatch(asked, quote.quoteRequest);
      if (field) {
        const message = `We couldn't set up the refund: NEAR Intents answered with a different ${field} than was asked for. Try again in a moment.`;
        noteError(id, message);
        throw new ApiError(502, "upstream_error", message);
      }
      const depositAddress = quote.quote.depositAddress;
      if (!depositAddress) {
        const message = "We couldn't set up the refund. Try again in a moment.";
        noteError(id, message);
        throw new ApiError(502, "upstream_error", message);
      }

      let generated;
      try {
        generated = await deps.client.generateIntent({
          type: "swap_transfer",
          standard: "nep413",
          signerId: s.accountId,
          depositAddress,
        });
      } catch (e) {
        const error = refundFailed(e);
        noteError(id, error.message);
        throw error;
      }

      // The payload goes to the wallet exactly as 1Click made it, and only after it is checked against what we asked for.
      const payload = generated.intent.payload;
      let deadline: Date;
      try {
        ({ deadline } = assertSafeToSign(payload, {
          signerId: s.accountId,
          verifier: config.intentsContract,
          settlementAssetId: s.asset.assetId,
          amount,
          depositAddress,
          now: now(),
          ...(quote.quote.deadline ? { quoteDeadline: new Date(quote.quote.deadline) } : {}),
        }));
      } catch (e) {
        if (!(e instanceof IntentPolicyError)) throw e;
        noteError(id, e.message);
        throw new ApiError(
          502,
          "intent_refused",
          `We couldn't approve this refund because it doesn't match what Tilll requested. ${e.message}.`,
        );
      }

      updateRefund(db, id, { depositAddress, quote, payload, clearError: true, updatedAt: now().toISOString() });
      return {
        refund: requireRefund(id),
        /** What the wallet signs. */
        payload,
        /** The account that must sign. */
        signerId: s.accountId,
        expiresAt: deadline.toISOString(),
        summary: summaryOf(requireRefund(id), attempt, quote),
        note: NOTE,
      };
    },

    /**
     * Step 4: the wallet has signed the payload from `prepare`. The intent is built from the payload the server kept,
     * never one the browser sends, and the signature is checked before it goes to 1Click. A rejection by 1Click
     * returns the refund to waiting, so it can be prepared and signed again.
     */
    async submit(id: string, input: { publicKey: string; signature: string }): Promise<RefundRecord> {
      const refund = requireRefund(id);
      if (refund.status !== "awaiting_approval") {
        throw new ApiError(
          409,
          "not_awaiting_approval",
          `Refund ${id} is ${words(refund.status)}. Only a refund waiting for approval can be approved.`,
        );
      }
      assertCurrent(requireInvoice(refund.invoiceId));
      const s = settings();
      const payload = refund.payload;
      if (!payload || !refund.depositAddress) {
        throw new ApiError(409, "not_prepared", `Refund ${id} hasn't been prepared yet. Prepare it, then approve it.`);
      }

      const publicKey = normalizePublicKey(input.publicKey);
      const type = publicKey ? keyTypeOf(publicKey) : undefined;
      if (!publicKey || !type) {
        throw new ApiError(
          422,
          "invalid_key",
          "We couldn't read the wallet's public key. Try connecting the wallet again.",
        );
      }
      if (!INTENTS_KEY_TYPES.includes(type)) {
        throw new ApiError(
          422,
          "unsupported_key_type",
          `This wallet uses a ${type} key, which NEAR Intents doesn't support yet. Use an account with one of these key types: ${INTENTS_KEY_TYPES.join(", ")}.`,
        );
      }
      const signature = normalizeSignature(input.signature, type);
      if (!signature)
        throw new ApiError(422, "invalid_signature", "We couldn't read the wallet's signature. Try approving again.");

      // Still usable? Checked again against the stored payload, since time has passed since it was prepared.
      let deadline: Date;
      try {
        ({ deadline } = assertSafeToSign(payload, {
          signerId: s.accountId,
          verifier: config.intentsContract,
          settlementAssetId: s.asset.assetId,
          amount: BigInt(refund.amount),
          depositAddress: refund.depositAddress,
          now: now(),
          ...(refund.quote?.quote.deadline ? { quoteDeadline: new Date(refund.quote.quote.deadline) } : {}),
        }));
      } catch (e) {
        if (!(e instanceof IntentPolicyError)) throw e;
        throw new ApiError(
          409,
          "intent_expired",
          `This approval can no longer be used (${e.message}). Approve the refund again.`,
        );
      }

      // ed25519 signatures are checked here to give a clear answer; the other accepted curves are left to the verifier.
      if (type === "ed25519" && !verifyNep413({ payload, public_key: publicKey, signature })) {
        throw new ApiError(
          422,
          "invalid_signature",
          "The signature doesn't match this refund. Your wallet may have signed a different message.",
        );
      }

      // An implicit account is its ed25519 key. Any other key has to be registered on the verifier for the account.
      const implicit = type === "ed25519" && implicitAccountOfPublicKey(publicKey) === s.accountId;
      if (!implicit) {
        let registered: boolean;
        try {
          registered = await deps.keyRegistered(publicKey);
        } catch (e) {
          throw new ApiError(
            503,
            "upstream_unavailable",
            `We couldn't check whether the key is registered: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (!registered) {
          throw new ApiError(
            409,
            "key_not_registered",
            `NEAR Intents doesn't recognize this wallet's key (${publicKey}) for ${s.accountId} yet. Register the key once, then approve the refund again.`,
          );
        }
      }

      // From here the intent may land, so the refund must not be written off as unfunded until it has expired.
      const claimed = db.transaction(() => {
        if (requireRefund(id).status !== "awaiting_approval") return false;
        updateRefund(db, id, {
          status: "pending",
          intentDeadline: deadline.toISOString(),
          clearError: true,
          updatedAt: now().toISOString(),
        });
        return true;
      })();
      if (!claimed) {
        throw new ApiError(409, "not_awaiting_approval", `Refund ${id} was already approved.`);
      }

      try {
        const submitted = await deps.client.submitIntent({
          type: "swap_transfer",
          signedData: { standard: "nep413", payload, public_key: publicKey, signature },
        });
        return markSubmitted(id, submitted.intentHash);
      } catch (e) {
        // Without an answer, or after a server error, the intent may or may not have been accepted. The watcher finds out.
        if (e instanceof OneClickError && (e.status === 0 || e.status >= 500)) return requireRefund(id);
        const error = refundFailed(e);
        updateRefund(db, id, {
          status: "awaiting_approval",
          error: error.message,
          clearIntentDeadline: true,
          clearPrepared: true,
          updatedAt: now().toISOString(),
        });
        throw error;
      }
    },

    /** Give up on a refund that is still waiting for approval. Its reserved amount and daily allowance are given back. */
    cancel(id: string): RefundRecord {
      const refund = requireRefund(id);
      if (refund.status !== "awaiting_approval") {
        throw new ApiError(
          409,
          "cannot_cancel",
          `Refund ${id} is ${words(refund.status)}. Only a refund waiting for approval can be canceled.`,
        );
      }
      return failRefund(id, "Canceled.", { notify: true });
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
            failRefund(id, `NEAR Intents couldn't complete the refund${reason ? `: ${reason}` : ""}.`, {
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
              failRefund(id, "The refund wasn't completed in time, and its approval has expired.", {
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
  };
}

export type RefundService = ReturnType<typeof createRefundService>;
