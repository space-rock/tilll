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
