import { randomBytes } from "node:crypto";
import { ApiError } from "../errors.js";
import { implicitAccountOfPublicKey, keyTypeOf, normalizePublicKey, normalizeSignature } from "../near/keys.js";
import { verifyNep413, type Nep413Payload } from "../near/nep413.js";
import { NearRpcError, viewAccessKey, type AccessKeyKind } from "../near/rpc.js";

/** How long a challenge can be answered. */
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_OPEN_CHALLENGES = 50;

/** What is signed: addressed to Tilll, so the signature cannot be used anywhere else. */
const RECIPIENT = "tilll";

export interface AccountProofDeps {
  /** What kind of key `publicKey` is for `accountId`. Defaults to a NEAR RPC call to `rpcUrl`. */
  accessKey?: (accountId: string, publicKey: string) => Promise<AccessKeyKind>;
  rpcUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface Challenge {
  accountId: string;
  payload: Nep413Payload;
  expiresAt: number;
}

/**
 * Money sent to an account nobody controls is lost, so a new settlement account is only accepted from a wallet that
 * can sign for it: the merchant is given a message to sign, and the signature must come from a full-access key of
 * that account. Each challenge works once.
 */
export function createAccountProof(deps: AccountProofDeps) {
  const now = deps.now ?? (() => new Date());
  const open = new Map<string, Challenge>();
  const accessKey =
    deps.accessKey ??
    ((accountId: string, publicKey: string) =>
      viewAccessKey({ rpcUrl: deps.rpcUrl, accountId, publicKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) }));

  const sweep = () => {
    for (const [nonce, c] of open) if (c.expiresAt <= now().getTime()) open.delete(nonce);
  };

  return {
    /** Something for the wallet to sign, to prove the merchant controls `accountId`. */
    challenge(accountId: string) {
      sweep();
      if (open.size >= MAX_OPEN_CHALLENGES) {
        throw new ApiError(
          429,
          "too_many_challenges",
          "Too many unfinished requests. Wait a few minutes and try again.",
        );
      }
      const payload: Nep413Payload = {
        message: `Use ${accountId} as the Tilll settlement account.`,
        nonce: randomBytes(32).toString("base64"),
        recipient: RECIPIENT,
        callbackUrl: null,
      };
      const expiresAt = now().getTime() + CHALLENGE_TTL_MS;
      open.set(payload.nonce, { accountId, payload, expiresAt });
      return { ...payload, expiresAt: new Date(expiresAt).toISOString() };
    },

    /** Throws unless the signature answers a challenge for `accountId` and comes from a full-access key of it. */
    async verify(accountId: string, input: { nonce: string; publicKey: string; signature: string }): Promise<void> {
      sweep();
      const challenge = open.get(input.nonce);
      if (!challenge || challenge.accountId !== accountId) {
        throw new ApiError(409, "challenge_expired", "That request has expired. Start again.");
      }
      // Used up whatever happens next: a failed try needs a fresh message.
      open.delete(input.nonce);

      const publicKey = normalizePublicKey(input.publicKey);
      const type = publicKey ? keyTypeOf(publicKey) : undefined;
      if (!publicKey || !type)
        throw new ApiError(
          422,
          "invalid_key",
          "We couldn't read the wallet's public key. Try connecting the wallet again.",
        );
      if (type !== "ed25519") {
        throw new ApiError(
          422,
          "unsupported_key_type",
          `This wallet uses a ${type} key. To confirm a new settlement account, use an account with an ed25519 key.`,
        );
      }
      const signature = normalizeSignature(input.signature, type);
      if (!signature || !verifyNep413({ payload: challenge.payload, public_key: publicKey, signature })) {
        throw new ApiError(422, "invalid_signature", "The signature doesn't match the message. Try again.");
      }

      // An implicit account is its own key. Any other account has to list the key, with full access.
      if (implicitAccountOfPublicKey(publicKey) === accountId) return;
      let kind: AccessKeyKind;
      try {
        kind = await accessKey(accountId, publicKey);
      } catch (e) {
        if (e instanceof NearRpcError) {
          throw new ApiError(503, "upstream_unavailable", `We couldn't check the wallet's key: ${e.message}`);
        }
        throw e;
      }
      if (kind === "none") {
        throw new ApiError(
          403,
          "key_not_on_account",
          `That key doesn't belong to ${accountId}. Connect a wallet signed in as ${accountId}.`,
        );
      }
      if (kind !== "full") {
        throw new ApiError(
          403,
          "key_not_full_access",
          `That key can only call certain contracts on ${accountId}. Use a wallet with a full-access key.`,
        );
      }
    },
  };
}

export type AccountProof = ReturnType<typeof createAccountProof>;
