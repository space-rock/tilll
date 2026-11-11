import type { Nep413Payload } from "../near/nep413.js";

/**
 * The last check before the settlement key signs anything.
 *
 * The refund intent is built by a third party (1Click's `generate-intent`). Signing it spends the
 * merchant's money, so Tilll does not trust it: it signs only a message that moves at most the refund
 * amount of the settlement asset, and, for a plain transfer, only to the deposit address of the refund
 * quote Tilll itself requested. Anything else is refused, and an unknown intent kind is refused by default.
 */

export class IntentPolicyError extends Error {
  constructor(message: string) {
    super(`Refusing to sign: ${message}`);
    this.name = "IntentPolicyError";
  }
}

export interface IntentExpectation {
  /** The account whose key signs; the message must name it as signer. */
  signerId: string;
  /** The verifier contract the signed message is addressed to (`intents.near` on mainnet). */
  verifier: string;
  /** The asset being refunded out of the settlement balance, as a 1Click asset id. */
  settlementAssetId: string;
  /** The most the signed message may spend, in base units of the settlement asset. */
  amount: bigint;
  /** The deposit address of the refund quote; the only receiver a transfer may name. */
  depositAddress: string;
  now: Date;
}

const MAX_INTENTS = 5;
const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
const INTEGER = /^\d+$/;
const SIGNED_INTEGER = /^-?\d+$/;

const TRANSFER_FIELDS = new Set(["intent", "receiver_id", "tokens", "memo"]);
const TOKEN_DIFF_FIELDS = new Set(["intent", "diff", "memo", "referral"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseMessage = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IntentPolicyError("the message is not JSON");
  }
  if (!isRecord(parsed)) throw new IntentPolicyError("the message is not a JSON object");
  return parsed;
};

const checkDeadline = (deadline: unknown, now: Date): Date => {
  if (typeof deadline !== "string") throw new IntentPolicyError("the message has no deadline");
  const at = Date.parse(deadline);
  if (Number.isNaN(at)) throw new IntentPolicyError(`the deadline "${deadline}" is not a date`);
  if (at <= now.getTime()) throw new IntentPolicyError("the deadline has already passed");
  if (at - now.getTime() > MAX_DEADLINE_MS) throw new IntentPolicyError("the deadline is more than 24 hours away");
  return new Date(at);
};

const checkFields = (intent: Record<string, unknown>, allowed: Set<string>, kind: string): void => {
  for (const field of Object.keys(intent)) {
    if (!allowed.has(field)) throw new IntentPolicyError(`the ${kind} intent has an unexpected field "${field}"`);
  }
};

/** What a `transfer` intent spends, after proving it is exactly the refund to the quote's deposit address. */
const spentByTransfer = (intent: Record<string, unknown>, expected: IntentExpectation): bigint => {
  checkFields(intent, TRANSFER_FIELDS, "transfer");
  if (intent.receiver_id !== expected.depositAddress) {
    throw new IntentPolicyError("a transfer goes to an address other than the refund quote's deposit address");
  }
  const tokens = intent.tokens;
  if (!isRecord(tokens)) throw new IntentPolicyError("a transfer has no tokens");
  const entries = Object.entries(tokens);
  const [only] = entries;
  if (entries.length !== 1 || only === undefined || only[0] !== expected.settlementAssetId) {
    throw new IntentPolicyError(`a transfer must move only ${expected.settlementAssetId}`);
  }
  const value = only[1];
  if (typeof value !== "string" || !INTEGER.test(value) || BigInt(value) !== expected.amount) {
    throw new IntentPolicyError(`a transfer must move exactly ${expected.amount} base units`);
  }
  return expected.amount;
};

/** What a `token_diff` intent gives up: only the settlement asset may go down. */
const spentByTokenDiff = (intent: Record<string, unknown>, expected: IntentExpectation): bigint => {
  checkFields(intent, TOKEN_DIFF_FIELDS, "token_diff");
  const diff = intent.diff;
  if (!isRecord(diff)) throw new IntentPolicyError("a token_diff has no diff");
  let spent = 0n;
  for (const [token, value] of Object.entries(diff)) {
    if (typeof value !== "string" || !SIGNED_INTEGER.test(value)) {
      throw new IntentPolicyError(`the token_diff amount for ${token} is not an integer`);
    }
    const delta = BigInt(value);
    if (delta >= 0n) continue;
    if (token !== expected.settlementAssetId) {
      throw new IntentPolicyError(`a token_diff would spend ${token}, which is not the settlement asset`);
    }
    spent -= delta;
  }
  if (spent === 0n) throw new IntentPolicyError("a token_diff spends none of the settlement asset");
  return spent;
};

const spentBy = (intent: unknown, expected: IntentExpectation): bigint => {
  if (!isRecord(intent) || typeof intent.intent !== "string") throw new IntentPolicyError("an intent has no kind");
  switch (intent.intent) {
    case "transfer":
      return spentByTransfer(intent, expected);
    case "token_diff":
      return spentByTokenDiff(intent, expected);
    default:
      throw new IntentPolicyError(`the intent kind "${intent.intent}" is not allowed in a refund`);
  }
};

/**
 * Throws {@link IntentPolicyError} unless signing `payload` moves at most `expected.amount` of the
 * settlement asset out of `expected.signerId`'s balance, only in the ways a refund needs. Returns the
 * message's deadline, after which the signed intent can no longer be executed.
 */
export function assertSafeToSign(payload: Nep413Payload, expected: IntentExpectation): { deadline: Date } {
  if (payload.recipient !== expected.verifier) {
    throw new IntentPolicyError(`the recipient is ${payload.recipient}, not the verifier ${expected.verifier}`);
  }
  const message = parseMessage(payload.message);
  if (message.signer_id !== expected.signerId) {
    throw new IntentPolicyError(`the signer is ${String(message.signer_id)}, not ${expected.signerId}`);
  }
  const deadline = checkDeadline(message.deadline, expected.now);

  const intents = message.intents;
  if (!Array.isArray(intents) || intents.length === 0 || intents.length > MAX_INTENTS) {
    throw new IntentPolicyError(`the message must hold between 1 and ${MAX_INTENTS} intents`);
  }
  let total = 0n;
  for (const intent of intents) total += spentBy(intent, expected);
  if (total > expected.amount) {
    throw new IntentPolicyError(`the intents spend ${total} in total, more than the refund of ${expected.amount}`);
  }
  return { deadline };
}
