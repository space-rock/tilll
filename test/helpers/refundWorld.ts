import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { base58Encode, publicKeyOf } from "../../src/near/keys.js";
import { signNep413 } from "../../src/near/nep413.js";
import { NearRpcError } from "../../src/near/rpc.js";
import { OneClickError } from "../../src/oneclick/client.js";
import type {
  GenerateIntentRequest,
  GenerateIntentResponse,
  QuoteRequest,
  QuoteResponse,
  SubmitIntentRequest,
  SubmitIntentResponse,
  SwapDetails,
  SwapStatus,
} from "../../src/oneclick/types.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import { fromBaseUnits } from "../../src/money.js";
import { createRefundService } from "../../src/refunds/service.js";
import { buildServer } from "../../src/server.js";
import { createWebhookLog } from "../../src/webhooks/log.js";
import type { DeliveryResult } from "../../src/webhooks/dispatcher.js";
import { AUTH, INFO, SECRET, makeAccountProof } from "./app.js";
import {
  REFUND_ADDRESS,
  TOKENS,
  USDC_BASE,
  USDC_NEAR,
  makeWorld,
  quoteResponseFor,
  statusResponseFor,
} from "./world.js";

export const VERIFIER = "intents.near";
/** A throwaway key made for the test run; it protects nothing. It plays the merchant's wallet. */
export const TEST_SECRET = `ed25519:${base58Encode(randomBytes(32))}`;
export const WALLET_KEY = publicKeyOf(TEST_SECRET);

export interface RefundWorldOptions {
  balance?: bigint;
  maxPerTx?: bigint;
  maxPerDay?: bigint;
}

/**
 * The invoice world plus a refund service whose 1Click calls are stubs. `intent` builds what generate-intent answers;
 * replace it to play a hostile or broken 1Click. `approve` plays the merchant's wallet: it prepares a refund, signs
 * the payload with a test key and submits the signature.
 */
export function makeRefundWorld(options: RefundWorldOptions = {}) {
  // The limits are given in base units of USDC (6 decimals); the settings hold them as the merchant types them.
  const world = makeWorld({
    refundMaxPerTx: fromBaseUnits((options.maxPerTx ?? 50_000_000n).toString(), 6),
    refundMaxPerDay: fromBaseUnits((options.maxPerDay ?? 200_000_000n).toString(), 6),
  });
  let quotes = 0;
  const balance = { value: options.balance ?? 1_000_000_000n };
  const fail = { readBalance: false, /** A failure that is a bug, not a network problem. */ crash: false };

  /** What a well-behaved 1Click answers to generate-intent: a transfer of the refund to the quote's deposit address. */
  const honestIntent = (req: GenerateIntentRequest, quote: QuoteResponse): GenerateIntentResponse => ({
    intent: {
      standard: "nep413",
      payload: {
        recipient: VERIFIER,
        nonce: randomBytes(32).toString("base64"),
        message: JSON.stringify({
          signer_id: req.signerId,
          deadline: new Date(world.clock.now().getTime() + 15 * 60_000).toISOString(),
          intents: [
            {
              intent: "transfer",
              receiver_id: req.depositAddress,
              tokens: { [quote.quoteRequest.originAsset]: quote.quoteRequest.amount },
            },
          ],
        }),
      },
    },
    correlationId: "intent-corr",
  });
  const behaviour = { intent: honestIntent, honest: honestIntent };

  const quoteByAddress = new Map<string, QuoteResponse>();
  const client = {
    quote: vi.fn<(req: QuoteRequest) => Promise<QuoteResponse>>(async (req) => {
      const response = quoteResponseFor(req, 1000 + ++quotes);
      if (!req.dry) quoteByAddress.set(response.quote.depositAddress!, response);
      return response;
    }),
    generateIntent: vi.fn<(req: GenerateIntentRequest) => Promise<GenerateIntentResponse>>(async (req) =>
      behaviour.intent(req, quoteByAddress.get(req.depositAddress)!),
    ),
    submitIntent: vi.fn<(req: SubmitIntentRequest) => Promise<SubmitIntentResponse>>(async () => ({
      intentHash: `hash-${quotes}`,
      correlationId: "submit-corr",
    })),
  };

  /** Whether the verifier knows the wallet's key. A named account has to register it once. */
  const keys = { registered: true, checkFails: false };
  const refunds = createRefundService({
    db: world.db,
    client,
    settings: world.settings,
    config: { intentsContract: VERIFIER },
    readBalance: async () => {
      if (fail.crash) throw new TypeError("a bug");
      if (fail.readBalance) throw new NearRpcError("rpc down");
      return balance.value;
    },
    keyRegistered: async () => {
      if (keys.checkFails) throw new NearRpcError("rpc down");
      return keys.registered;
    },
    now: world.clock.now,
  });

  /** The merchant's wallet: prepare the refund, sign what the server prepared, submit the signature. */
  async function approve(refundId: string, wallet: { secret?: string; sign?: boolean } = {}) {
    const prepared = await refunds.prepare(refundId);
    const secret = wallet.secret ?? TEST_SECRET;
    const signed = signNep413(secret, prepared.payload);
    const refund = await refunds.submit(refundId, { publicKey: signed.public_key, signature: signed.signature });
    return { refund, prepared };
  }

  /**
   * An invoice paid twice: the first attempt settles it, the second arrives for an invoice that is already paid and
   * is recorded as an automatic refund. The second payer has a different refund address.
   */
  async function duplicatePayment(amount = "5.00") {
    const invoice = world.service.createInvoice({ amount });
    const second = "0x2222222222222222222222222222222222222222";
    const first = await world.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    const duplicate = await world.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: second });
    for (const attempt of [first, duplicate]) {
      world.service.applyStatus(attempt.id, statusResponseFor(attempt.quote, "SUCCESS", { amountOut: invoice.amount }));
    }
    const [auto] = world.service.getInvoiceDetail(invoice.id).refunds;
    return { invoice: world.service.getInvoice(invoice.id), first, duplicate, auto: auto!, duplicateRefundTo: second };
  }

  /** An invoice paid by a Base USDC attempt, as the poller would leave it. */
  async function paidInvoice(amount = "5.00") {
    const invoice = world.service.createInvoice({ amount });
    const attempt = await world.service.createAttempt(invoice.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    world.service.applyStatus(attempt.id, statusResponseFor(attempt.quote, "SUCCESS", { amountOut: invoice.amount }));
    return { invoice: world.service.getInvoice(invoice.id), attempt: world.service.getAttempt(attempt.id) };
  }

  /** What 1Click reports for a refund's deposit address. */
  const statusOf = (refundId: string, status: SwapStatus, details: SwapDetails = {}) => {
    const refund = refunds.get(refundId);
    return statusResponseFor(quoteByAddress.get(refund.depositAddress!)!, status, details);
  };

  return {
    ...world,
    client,
    refunds,
    approve,
    keys,
    balance,
    fail,
    behaviour,
    paidInvoice,
    duplicatePayment,
    statusOf,
    quoteByAddress,
  };
}

export type RefundWorld = ReturnType<typeof makeRefundWorld>;

/** A refund world with the HTTP server on top. Requests go through `app.inject`. */
export async function makeRefundApp(options: RefundWorldOptions = {}) {
  const world = makeRefundWorld(options);
  const dispatcher = {
    sendPing: vi.fn<() => Promise<DeliveryResult>>(async () => {
      throw new Error("not used");
    }),
    deliver: vi.fn<(id: string, options?: { force?: boolean }) => Promise<DeliveryResult>>(async () => {
      throw new Error("not scripted");
    }),
  };
  const tokens = { fail: false };
  const proof = makeAccountProof();
  const info = { ...INFO };
  const app = await buildServer({
    merchantSecret: SECRET,
    allowedOrigins: ["*"],
    service: world.service,
    refunds: world.refunds,
    client: {
      depositSubmit: async () => {
        throw new Error("not used");
      },
    },
    webhooks: dispatcher,
    webhookLog: createWebhookLog(world.db),
    info,
    tokens: createTokenCache({
      client: {
        tokens: async () => {
          if (tokens.fail) throw new Error("1Click is down");
          return TOKENS;
        },
      },
    }),
    settings: world.settings,
    accountProof: proof.accountProof,
  });
  const merchant = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { ...world, app, merchant, dispatcher, tokens, info, accessKeys: proof.accessKeys };
}

export const SETTLEMENT = USDC_NEAR;

/** A 1Click failure of the kind submit-intent can produce. */
export const oneClickFailure = (status: number, message = "boom") => new OneClickError(status, message);
