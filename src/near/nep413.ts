import { createHash, createPublicKey, verify } from "node:crypto";
import { base58Decode, base58Encode, publicKeyOf, signWithSecret } from "./keys.js";

/** NEP-413 (https://github.com/near/NEPs/blob/master/neps/nep-0413.md): a signed message addressed to a recipient. */
export interface Nep413Payload {
  message: string;
  /** Base64 of exactly 32 bytes. */
  nonce: string;
  recipient: string;
  /** Optional; `generate-intent` returns it as null. */
  callbackUrl?: string | null;
}

export class Nep413Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Nep413Error";
  }
}

/** 2^31 + 413, written little-endian: the prefix that keeps a NEP-413 signature from being valid as a transaction. */
const TAG = Buffer.from(new Uint32Array([2 ** 31 + 413]).buffer);

const borshString = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from(new Uint32Array([bytes.length]).buffer), bytes]);
};

function decodeNonce(nonce: string): Buffer {
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(nonce) ? Buffer.from(nonce, "base64") : Buffer.alloc(0);
  if (bytes.length !== 32) throw new Nep413Error("The nonce must be base64 of exactly 32 bytes.");
  return bytes;
}

/**
 * The 32 bytes that get signed: SHA-256 of the tag followed by the Borsh encoding of
 * `{ message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }`.
 */
export function nep413Digest(payload: Nep413Payload): Buffer {
  const callback = payload.callbackUrl
    ? Buffer.concat([Buffer.from([1]), borshString(payload.callbackUrl)])
    : Buffer.from([0]);
  return createHash("sha256")
    .update(
      Buffer.concat([
        TAG,
        borshString(payload.message),
        decodeNonce(payload.nonce),
        borshString(payload.recipient),
        callback,
      ]),
    )
    .digest();
}

/** Sign a payload exactly as given. Returns the `public_key` and `signature` a signed intent needs. */
export function signNep413(secretKey: string, payload: Nep413Payload): { public_key: string; signature: string } {
  const signature = signWithSecret(secretKey, nep413Digest(payload));
  return { public_key: publicKeyOf(secretKey), signature: `ed25519:${base58Encode(signature)}` };
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `signature` is a valid NEP-413 signature of `payload` by `public_key`. Never throws on bad input. */
export function verifyNep413(signed: { payload: Nep413Payload; public_key: string; signature: string }): boolean {
  try {
    if (!signed.public_key.startsWith("ed25519:") || !signed.signature.startsWith("ed25519:")) return false;
    const publicKey = Buffer.from(base58Decode(signed.public_key.slice("ed25519:".length)));
    const signature = Buffer.from(base58Decode(signed.signature.slice("ed25519:".length)));
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, nep413Digest(signed.payload), key, signature);
  } catch {
    return false;
  }
}
