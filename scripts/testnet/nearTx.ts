/**
 * Just enough NEAR transaction signing to call a contract function from a throwaway testnet account: Borsh
 * encoding of a one-action Transaction, an ed25519 signature over its SHA-256, and the three RPC calls needed to
 * send it. Development harness only; the product never signs NEAR transactions.
 */
import { createHash } from "node:crypto";
import { base58Decode, base58Encode, publicKeyOf, signWithSecret } from "../../src/near/keys.js";

export class NearTxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NearTxError";
  }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u128 = (n: bigint) => Buffer.concat([u64(n & ((1n << 64n) - 1n)), u64(n >> 64n)]);
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

function decodeKey(text: string, bytes: number, what: string): Buffer {
  const encoded = text.startsWith("ed25519:") ? text.slice("ed25519:".length) : text;
  if (what === "public key" && !text.startsWith("ed25519:"))
    throw new NearTxError("Only ed25519 public keys are supported.");
  let raw: Uint8Array;
  try {
    raw = base58Decode(encoded);
  } catch {
    throw new NearTxError(`The ${what} is not valid base58.`);
  }
  if (raw.length !== bytes) throw new NearTxError(`The ${what} must be ${bytes} bytes, got ${raw.length}.`);
  return Buffer.from(raw);
}

export interface FunctionCallTx {
  signerId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  /** Base58 hash of a recent block. */
  blockHash: string;
  method: string;
  /** The call arguments, already JSON encoded. */
  args: string;
  gas: bigint;
  /** In yoctoNEAR. */
  deposit: bigint;
}

/** The Borsh bytes of a Transaction holding a single FunctionCall action. */
export function serializeFunctionCallTx(tx: FunctionCallTx): Buffer {
  if (tx.deposit < 0n || tx.deposit >= 1n << 128n)
    throw new NearTxError("Deposit must fit in 128 bits and not be negative.");
  if (tx.gas < 0n || tx.gas >= 1n << 64n) throw new NearTxError("Gas must fit in 64 bits and not be negative.");
  if (tx.nonce < 0n || tx.nonce >= 1n << 64n) throw new NearTxError("Nonce must fit in 64 bits and not be negative.");
  return Buffer.concat([
    str(tx.signerId),
    Buffer.from([0]), // key type: ed25519
    decodeKey(tx.publicKey, 32, "public key"),
    u64(tx.nonce),
    str(tx.receiverId),
    decodeKey(tx.blockHash, 32, "block hash"),
    u32(1), // one action
    Buffer.from([2]), // Action::FunctionCall
    str(tx.method),
    u32(Buffer.byteLength(tx.args)),
    Buffer.from(tx.args),
    u64(tx.gas),
    u128(tx.deposit),
  ]);
}

/** Sign the SHA-256 of the transaction bytes. `hash` is the transaction hash the chain will report. */
export function signTransaction(secretKey: string, txBytes: Buffer): { signedBase64: string; hash: string } {
  const digest = createHash("sha256").update(txBytes).digest();
  const signature = signWithSecret(secretKey, digest);
  const signed = Buffer.concat([txBytes, Buffer.from([0]), signature]); // signature type: ed25519
  return { signedBase64: signed.toString("base64"), hash: base58Encode(digest) };
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown,
  doFetch: typeof fetch,
): Promise<Record<string, any>> {
  let body: { result?: Record<string, any>; error?: unknown };
  try {
    const response = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "tilll", method, params }),
    });
    if (!response.ok) throw new NearTxError(`NEAR RPC ${method} failed (HTTP ${response.status}).`);
    body = JSON.parse(await response.text());
  } catch (cause) {
    if (cause instanceof NearTxError) throw cause;
    throw new NearTxError(`NEAR RPC ${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
  if (body.error) throw new NearTxError(`NEAR RPC ${method} failed: ${JSON.stringify(body.error).slice(0, 400)}`);
  if (!body.result) throw new NearTxError(`NEAR RPC ${method} returned no result.`);
  return body.result;
}

/** Any failure anywhere in the transaction's execution tree, as text, or undefined if it all succeeded. */
function failureOf(result: Record<string, any>): string | undefined {
  if (result.status?.Failure) return JSON.stringify(result.status.Failure);
  for (const receipt of result.receipts_outcome ?? []) {
    if (receipt?.outcome?.status?.Failure) return JSON.stringify(receipt.outcome.status.Failure);
  }
  return undefined;
}

export interface CallFunction {
  rpcUrl: string;
  signerId: string;
  /** The signer's `ed25519:<base58>` secret key. Used locally to sign; never sent anywhere. */
  secretKey: string;
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
  fetch?: typeof fetch;
}

/** Call a contract function from `signerId`, wait for the final result, and throw if any part of it failed. */
export async function callFunction(options: CallFunction): Promise<{ txHash: string }> {
  const doFetch = options.fetch ?? fetch;
  const publicKey = publicKeyOf(options.secretKey);

  const key = await rpc(
    options.rpcUrl,
    "query",
    { request_type: "view_access_key", finality: "final", account_id: options.signerId, public_key: publicKey },
    doFetch,
  );
  const block = await rpc(options.rpcUrl, "block", { finality: "final" }, doFetch);
  const blockHash = block.header?.hash;
  if (typeof blockHash !== "string") throw new NearTxError("NEAR RPC block returned no hash.");

  const tx = serializeFunctionCallTx({
    signerId: options.signerId,
    publicKey,
    nonce: BigInt(key.nonce) + 1n,
    receiverId: options.receiverId,
    blockHash,
    method: options.method,
    args: JSON.stringify(options.args),
    gas: options.gas,
    deposit: options.deposit,
  });
  const { signedBase64, hash } = signTransaction(options.secretKey, tx);

  const result = await rpc(options.rpcUrl, "send_tx", { signed_tx_base64: signedBase64, wait_until: "FINAL" }, doFetch);
  const failure = failureOf(result);
  if (failure)
    throw new NearTxError(`${options.receiverId}.${options.method} failed on chain: ${failure.slice(0, 500)}`);
  return { txHash: (result.transaction_outcome?.id as string | undefined) ?? hash };
}
