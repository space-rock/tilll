import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NearTxError, callFunction, serializeFunctionCallTx, signTransaction } from "../scripts/testnet/nearTx.js";
import { base58Decode, base58Encode, publicKeyOf } from "../src/near/keys.js";
import { failureOf } from "./helpers/failure.js";
import { fakeFetch, type RecordedCall } from "./helpers/fakeFetch.js";

const u32 = (n: number) => Buffer.from(new Uint32Array([n]).buffer);
const u64 = (n: bigint) => Buffer.from(new BigUint64Array([n]).buffer);
const u128 = (n: bigint) => Buffer.concat([u64(n & ((1n << 64n) - 1n)), u64(n >> 64n)]);
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

const PK_BYTES = Buffer.alloc(32, 0x11);
const BLOCK_HASH_BYTES = Buffer.alloc(32, 0x22);
const SECRET = `ed25519:${base58Encode(Buffer.alloc(32, 7))}`;

describe("serializeFunctionCallTx", () => {
  it("is the NEAR Borsh Transaction layout with one FunctionCall action, byte for byte", () => {
    const bytes = serializeFunctionCallTx({
      signerId: "a.testnet",
      publicKey: `ed25519:${base58Encode(PK_BYTES)}`,
      nonce: 5n,
      receiverId: "token.testnet",
      blockHash: base58Encode(BLOCK_HASH_BYTES),
      method: "ft_transfer",
      args: '{"x":1}',
      gas: 30_000_000_000_000n,
      deposit: 1n,
    });

    const expected = Buffer.concat([
      str("a.testnet"), // signer_id
      Buffer.from([0]), // public key type: ed25519
      PK_BYTES,
      u64(5n), // nonce
      str("token.testnet"), // receiver_id
      BLOCK_HASH_BYTES,
      u32(1), // one action
      Buffer.from([2]), // Action::FunctionCall
      str("ft_transfer"),
      u32(7),
      Buffer.from('{"x":1}'),
      u64(30_000_000_000_000n), // gas
      u128(1n), // deposit
    ]);
    expect(bytes.toString("hex")).toBe(expected.toString("hex"));
  });

  it("encodes a deposit above 2^64 (0.00125 NEAR is 1.25e21 yocto) across the full 16 bytes", () => {
    const deposit = 1_250_000_000_000_000_000_000n;
    const bytes = serializeFunctionCallTx({
      signerId: "a.testnet",
      publicKey: `ed25519:${base58Encode(PK_BYTES)}`,
      nonce: 1n,
      receiverId: "t.testnet",
      blockHash: base58Encode(BLOCK_HASH_BYTES),
      method: "m",
      args: "{}",
      gas: 1n,
      deposit,
    });
    expect(bytes.subarray(-16).toString("hex")).toBe(u128(deposit).toString("hex"));
    expect(bytes.subarray(-16).readBigUInt64LE(8)).toBeGreaterThan(0n);
  });

  it.each([
    ["a public key of the wrong type", { publicKey: "secp256k1:abc" }],
    ["a block hash that is not 32 bytes", { blockHash: base58Encode(Buffer.alloc(31)) }],
    ["a negative deposit", { deposit: -1n }],
    ["a deposit above 2^128", { deposit: 1n << 128n }],
  ])("refuses %s", (_name, override) => {
    expect(() =>
      serializeFunctionCallTx({
        signerId: "a.testnet",
        publicKey: `ed25519:${base58Encode(PK_BYTES)}`,
        nonce: 1n,
        receiverId: "t.testnet",
        blockHash: base58Encode(BLOCK_HASH_BYTES),
        method: "m",
        args: "{}",
        gas: 1n,
        deposit: 1n,
        ...override,
      }),
    ).toThrow(NearTxError);
  });
});

describe("signTransaction", () => {
  it("appends an ed25519 signature over the SHA-256 of the transaction, and returns that hash as the tx hash", () => {
    const tx = Buffer.from("pretend transaction bytes");

    const { signedBase64, hash } = signTransaction(SECRET, tx);

    const signed = Buffer.from(signedBase64, "base64");
    expect(signed.subarray(0, tx.length).equals(tx)).toBe(true);
    expect(signed[tx.length]).toBe(0); // signature type: ed25519
    const signature = signed.subarray(tx.length + 1);
    expect(signature).toHaveLength(64);

    const digest = createHash("sha256").update(tx).digest();
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(base58Decode(publicKeyOf(SECRET).slice(8))),
    ]);
    expect(verify(null, digest, createPublicKey({ key: spki, format: "der", type: "spki" }), signature)).toBe(true);
    expect(hash).toBe(base58Encode(digest));
  });
});

const RPC = "https://test.rpc.fastnear.com";
const blockHash = base58Encode(BLOCK_HASH_BYTES);

/** A node that knows one access key and accepts transactions, recording what was asked. */
function node(options: { nonce?: number; txResult?: unknown } = {}) {
  return fakeFetch((call: RecordedCall) => {
    const { method, params } = call.body as { method: string; params: Record<string, unknown> };
    if (method === "query" && params.request_type === "view_access_key")
      return { body: { result: { nonce: options.nonce ?? 41, permission: "FullAccess" } } };
    if (method === "block") return { body: { result: { header: { hash: blockHash } } } };
    if (method === "send_tx") {
      return {
        body: {
          result: options.txResult ?? { status: { SuccessValue: "" }, transaction_outcome: { id: "TXHASH123" } },
        },
      };
    }
    return { status: 500, body: { error: `unexpected ${method}` } };
  });
}

const call = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  callFunction({
    rpcUrl: RPC,
    signerId: "payer.testnet",
    secretKey: SECRET,
    receiverId: "usdt.tidepool-sandbox.testnet",
    method: "ft_transfer",
    args: { receiver_id: "abc", amount: "5000000" },
    gas: 30_000_000_000_000n,
    deposit: 1n,
    fetch,
    ...extra,
  });

describe("callFunction", () => {
  it("looks up the next nonce and a recent block, signs, sends, and waits for the final result", async () => {
    const { fetch, calls } = node({ nonce: 41 });

    const result = await call(fetch);

    expect(result.txHash).toBe("TXHASH123");
    const bodies = calls.map((c) => c.body as { method: string; params: Record<string, unknown> });
    expect(bodies.map((b) => b.method)).toEqual(["query", "block", "send_tx"]);
    expect(bodies[0]!.params).toMatchObject({
      request_type: "view_access_key",
      finality: "final",
      account_id: "payer.testnet",
      public_key: publicKeyOf(SECRET),
    });
    expect(bodies[2]!.params).toMatchObject({ wait_until: "FINAL" });

    const sent = Buffer.from(String(bodies[2]!.params.signed_tx_base64), "base64");
    expect(sent.includes(Buffer.from("ft_transfer"))).toBe(true);
    expect(sent.includes(Buffer.from('{"receiver_id":"abc","amount":"5000000"}'))).toBe(true);
    // nonce 42 (the key's nonce 41, plus one) directly after signer id, public key type and key
    const nonceAt = 4 + "payer.testnet".length + 1 + 32;
    expect(sent.readBigUInt64LE(nonceAt)).toBe(42n);
  });

  it("reports a failed transaction with the chain's reason", async () => {
    const { fetch } = node({
      txResult: {
        status: {
          Failure: {
            ActionError: {
              kind: {
                FunctionCallError: { ExecutionError: "Smart contract panicked: The account abc is not registered" },
              },
            },
          },
        },
        transaction_outcome: { id: "T" },
      },
    });
    const err = await failureOf(NearTxError, () => call(fetch));
    expect(err.message).toContain("is not registered");
  });

  it("reports a transaction whose receipt failed even when the top-level status looks fine", async () => {
    const { fetch } = node({
      txResult: {
        status: { SuccessValue: "" },
        transaction_outcome: { id: "T" },
        receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "LackBalanceForState" } } } } }],
      },
    });
    const err = await failureOf(NearTxError, () => call(fetch));
    expect(err.message).toContain("LackBalanceForState");
  });

  it("reports an unknown access key", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } },
    }));
    const err = await failureOf(NearTxError, () => call(fetch));
    expect(err.message).toMatch(/UNKNOWN_ACCESS_KEY|access key/i);
  });

  it("wraps a network failure", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await failureOf(NearTxError, () => call(fetch));
    expect(err.message).toContain("fetch failed");
  });

  it("never puts the secret key on the wire or in an error", async () => {
    const { fetch, calls } = node({ txResult: { status: { Failure: "boom" }, transaction_outcome: { id: "T" } } });
    const err = await failureOf(NearTxError, () => call(fetch));
    const everything = JSON.stringify(calls.map((c) => c.rawBody)) + err.message;
    expect(everything).not.toContain(SECRET.slice(8));
  });
});
