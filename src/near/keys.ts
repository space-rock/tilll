import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A key that cannot be read. Messages never contain key material. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let digits = "";
  while (n > 0n) {
    digits = ALPHABET[Number(n % 58n)]! + digits;
    n /= 58n;
  }
  return "1".repeat(zeros) + digits;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit === -1) throw new KeyError("Not a valid base58 string.");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 255n));
  return Uint8Array.from([...Array.from({ length: zeros }, () => 0), ...bytes]);
}

/** DER prefix of an SPKI Ed25519 public key; the 32 byte key follows. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** DER prefix of a PKCS#8 Ed25519 private key; the 32 byte seed follows. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const privateKeyOf = (seed: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });

function publicKeyBytes(seed: Uint8Array): Buffer {
  // The last 32 bytes of the SPKI encoding are the raw public key.
  return createPublicKey(privateKeyOf(seed)).export({ format: "der", type: "spki" }).subarray(-32);
}

/** Read an `ed25519:<base58>` secret key in either NEAR form and check it is internally consistent. */
function parseSecret(secretKey: string): { seed: Uint8Array; publicKey: Buffer } {
  const encoded = /^ed25519:(.+)$/.exec(secretKey)?.[1];
  if (!encoded) throw new KeyError('A secret key must look like "ed25519:<base58>".');
  const raw = base58Decode(encoded);
  if (raw.length !== 32 && raw.length !== 64) {
    throw new KeyError(`An ed25519 secret key is 32 or 64 bytes; this one is ${raw.length}.`);
  }
  const seed = raw.subarray(0, 32);
  const publicKey = publicKeyBytes(seed);
  if (raw.length === 64 && !publicKey.equals(raw.subarray(32))) {
    throw new KeyError("The public half of the secret key does not match its seed.");
  }
  return { seed, publicKey };
}

const publicKeyBytesOf = (secretKey: string): Buffer => parseSecret(secretKey).publicKey;

/** An ed25519 signature (64 bytes) of `data` with an `ed25519:<base58>` secret key. */
export function signWithSecret(secretKey: string, data: Uint8Array): Buffer {
  return sign(null, data, privateKeyOf(parseSecret(secretKey).seed));
}

/**
 * The `ed25519:<base58>` public key for an `ed25519:<base58>` secret key, in either NEAR form: the 32 byte
 * seed, or the usual 64 bytes (seed then public key). This is the key to register on the verifier contract.
 */
export function publicKeyOf(secretKey: string): string {
  return `ed25519:${base58Encode(publicKeyBytesOf(secretKey))}`;
}

/**
 * The NEAR implicit account id of a secret key: its public key as 64 lowercase hex characters. An implicit
 * account can sign NEAR Intents with this key without registering it first.
 */
export function implicitAccountOf(secretKey: string): string {
  return publicKeyBytesOf(secretKey).toString("hex");
}

const strip = (value: string) => (value.startsWith("ed25519:") ? value.slice("ed25519:".length) : value);

/**
 * Whether `signature` (`ed25519:<base58>`, 64 bytes) is `publicKey`'s (`ed25519:<base58>`, 32 bytes) signature of `data`.
 * Anything malformed is simply `false`: this is asked about data from outside, and never throws.
 */
export function verifyEd25519(publicKey: string, data: Uint8Array, signature: string): boolean {
  try {
    const key = Buffer.from(base58Decode(strip(publicKey)));
    const sig = Buffer.from(base58Decode(strip(signature)));
    if (key.length !== 32 || sig.length !== 64) return false;
    const spki = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, key]), format: "der", type: "spki" });
    return verify(null, data, spki, sig);
  } catch {
    return false;
  }
}

/** The NEAR implicit account id of an `ed25519:<base58>` public key: its 32 bytes as 64 lowercase hex characters. */
export function implicitAccountOfPublicKey(publicKey: string): string {
  const bytes = Buffer.from(base58Decode(strip(publicKey)));
  if (bytes.length !== 32) throw new KeyError("An ed25519 public key is 32 bytes.");
  return bytes.toString("hex");
}

/**
 * The key types the NEAR Intents verifier accepts (its documented curves). NEAR itself also has post-quantum account
 * keys (ML-DSA-65, protocol 85), which the verifier does not list. When it does, adding the type here is the change.
 */
export const INTENTS_KEY_TYPES: readonly string[] = ["ed25519", "secp256k1", "p256"];

/** Byte lengths of a public key and a signature, for the curves whose sizes are fixed and known. */
const CURVES: Record<string, { key: number; signature: number }> = {
  ed25519: { key: 32, signature: 64 },
  secp256k1: { key: 64, signature: 65 },
  p256: { key: 64, signature: 64 },
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TYPE = /^[a-z][a-z0-9_-]{0,31}$/;

const decodeBase58 = (text: string): Buffer | undefined => {
  if (!BASE58.test(text)) return undefined;
  try {
    return Buffer.from(base58Decode(text));
  } catch {
    return undefined;
  }
};

const decodeBase64 = (text: string): Buffer | undefined =>
  BASE64.test(text) ? Buffer.from(text, "base64") : undefined;

/** The curve prefix of a `<type>:<base58>` key or signature (`ed25519`), or `undefined` when it has none. */
export function keyTypeOf(value: string): string | undefined {
  const type = /^([^:]+):/.exec(value.trim())?.[1]?.toLowerCase();
  return type && TYPE.test(type) ? type : undefined;
}

/**
 * A wallet's public key as `<type>:<base58>`. Wallets differ: some return the prefixed form, some a bare ed25519 key as
 * base58 or base64. A key with no prefix is read as ed25519. For the curves with known sizes the length is checked;
 * a type this code does not know is kept as it is, for the caller to accept or refuse. Anything else is `undefined`.
 */
export function normalizePublicKey(input: string): string | undefined {
  const text = input.trim();
  const type = keyTypeOf(text);
  if (type) {
    const bytes = decodeBase58(text.slice(type.length + 1));
    const size = CURVES[type]?.key;
    if (!bytes || bytes.length === 0 || (size !== undefined && bytes.length !== size)) return undefined;
    return `${type}:${base58Encode(bytes)}`;
  }
  const bytes = decodeBase58(text) ?? decodeBase64(text);
  return bytes?.length === CURVES.ed25519!.key ? `ed25519:${base58Encode(bytes)}` : undefined;
}

/**
 * A wallet's signature as `<type>:<base58>`, for a key of `type`. NEP-413 specifies base64, but wallets also return the
 * prefixed base58 form. Without a prefix only a curve with a known signature size can be read. Anything that is not
 * exactly that size is `undefined`.
 */
export function normalizeSignature(input: string, type: string): string | undefined {
  const text = input.trim();
  const size = CURVES[type]?.signature;
  const prefix = keyTypeOf(text);
  if (prefix) {
    if (prefix !== type) return undefined;
    const bytes = decodeBase58(text.slice(prefix.length + 1));
    return bytes && bytes.length > 0 && (size === undefined || bytes.length === size)
      ? `${type}:${base58Encode(bytes)}`
      : undefined;
  }
  if (size === undefined) return undefined;
  const bytes = [decodeBase64(text), decodeBase58(text)].find((candidate) => candidate?.length === size);
  return bytes ? `${type}:${base58Encode(bytes)}` : undefined;
}
