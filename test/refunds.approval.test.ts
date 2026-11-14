import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { base58Decode, base58Encode, publicKeyOf, signWithSecret } from "../src/near/keys.js";
import { nep413Digest, signNep413 } from "../src/near/nep413.js";
import { failureOf } from "./helpers/failure.js";
import { TEST_SECRET, WALLET_KEY, makeRefundWorld, oneClickFailure, type RefundWorld } from "./helpers/refundWorld.js";

const MINUTE = 60_000;

const refusal = (fn: () => unknown) => failureOf(ApiError, fn);

/** A merchant refund that has been requested and is waiting for the wallet. */
async function waiting(w: RefundWorld, amount = "2.00") {
  const { invoice } = await w.paidInvoice("5.00");
  const { refund } = await w.refunds.refund(invoice.id, { idempotencyKey: "key-1", amount });
  return { invoice, refund };
}

const signedWith = (secret: string, payload: Parameters<typeof signNep413>[1]) => signNep413(secret, payload);

describe("asking for a refund", () => {
  it("only reserves it: nothing is quoted, signed or sent until the wallet approves", async () => {
    const w = makeRefundWorld();
    const { invoice, refund } = await waiting(w);

    expect(refund).toMatchObject({
      status: "awaiting_approval",
      payload: null,
      depositAddress: null,
      intentHash: null,
    });
    expect(w.client.quote).not.toHaveBeenCalled();
    expect(w.client.generateIntent).not.toHaveBeenCalled();
    expect(w.client.submitIntent).not.toHaveBeenCalled();
    expect(w.events().map((e) => e.type)).toContain("refund.awaiting_approval");
    // The amount is already spoken for, so it cannot be asked for twice.
    expect(
      await refusal(() => w.refunds.refund(invoice.id, { idempotencyKey: "key-2", amount: "3.01" })),
    ).toMatchObject({ code: "refund_exceeds_remaining" });
  });

  it("counts toward the daily limit straight away, and gives it back when canceled", async () => {
    const w = makeRefundWorld({ maxPerDay: 4_000_000n });
    const a = await w.paidInvoice();
    const b = await w.paidInvoice();
    const first = await w.refunds.refund(a.invoice.id, { idempotencyKey: "k1", amount: "4.00" });
    expect(await refusal(() => w.refunds.refund(b.invoice.id, { idempotencyKey: "k2", amount: "1.00" }))).toMatchObject(
      {
        code: "daily_refund_limit",
      },
    );

    const canceled = w.refunds.cancel(first.refund.id);

    expect(canceled).toMatchObject({ status: "failed", error: "Canceled." });
    expect(w.events().at(-1)).toMatchObject({ type: "refund.failed" });
    expect((await w.refunds.refund(b.invoice.id, { idempotencyKey: "k3", amount: "4.00" })).refund.status).toBe(
      "awaiting_approval",
    );
  });
});

describe("preparing a refund for the wallet", () => {
  it("gets a fresh quote and intent, checks it, keeps it, and returns what the wallet signs", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);

    const prepared = await w.refunds.prepare(refund.id);

    const kept = w.refunds.get(refund.id);
    expect(kept.status).toBe("awaiting_approval");
    expect(kept.payload).toEqual(prepared.payload);
    expect(kept.depositAddress).toBeTruthy();
    expect(prepared.signerId).toBe("shop-pay.near");
    expect(prepared.payload.recipient).toBe("intents.near");
    expect(prepared.summary).toMatchObject({
      amount: "2",
      destination: { chain: "base", symbol: "USDC" },
      estimate: { amountOutFormatted: expect.any(String), timeEstimate: expect.any(Number) },
    });
    expect(Date.parse(prepared.expiresAt)).toBeGreaterThan(w.clock.now().getTime());
    expect(w.client.submitIntent).not.toHaveBeenCalled();
  });

  it("makes a new quote each time, because quotes and intents expire", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    const first = await w.refunds.prepare(refund.id);
    const second = await w.refunds.prepare(refund.id);
    expect(second.payload.nonce).not.toBe(first.payload.nonce);
    expect(w.client.quote).toHaveBeenCalledTimes(2);
  });

  it("refuses when the balance can no longer cover the refund, and leaves it waiting with the reason", async () => {
    const w = makeRefundWorld({ balance: 5_000_000n });
    const { refund } = await waiting(w, "2.00");
    w.balance.value = 1_000_000n;
    expect(await refusal(() => w.refunds.prepare(refund.id))).toMatchObject({ code: "insufficient_balance" });
    expect(w.refunds.get(refund.id)).toMatchObject({ status: "awaiting_approval", error: expect.any(String) });
  });

  it("refuses a refund quote that pays another address than the customer's, before any intent is made", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    const honest = w.client.quote.getMockImplementation()!;
    w.client.quote.mockImplementationOnce(async (req) => {
      const q = await honest(req);
      q.quoteRequest.recipient = "0x2222222222222222222222222222222222222222";
      return q;
    });

    expect(await refusal(() => w.refunds.prepare(refund.id))).toMatchObject({ status: 502, code: "upstream_error" });
    expect(w.client.generateIntent).not.toHaveBeenCalled();
    expect(w.refunds.get(refund.id)).toMatchObject({
      status: "awaiting_approval",
      payload: null,
      depositAddress: null,
      error: expect.stringContaining("recipient"),
    });
  });

  it("only prepares a refund that is waiting", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    await w.approve(refund.id);
    expect(await refusal(() => w.refunds.prepare(refund.id))).toMatchObject({
      code: "not_awaiting_approval",
      status: 409,
    });
  });
});

describe("submitting the wallet's signature", () => {
  it("sends the intent the server kept, signed by the wallet, and follows the refund from there", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);

    const { refund: approved, prepared } = await w.approve(refund.id);

    expect(approved).toMatchObject({ status: "submitted", intentHash: expect.stringMatching(/^hash-/), error: null });
    const request = w.client.submitIntent.mock.calls[0]![0];
    expect(request.signedData.payload).toEqual(prepared.payload);
    expect(request.signedData.public_key).toBe(WALLET_KEY);
    expect(approved.intentDeadline).not.toBeNull();
    expect(w.refunds.listPollableRefunds().map((r) => r.id)).toEqual([refund.id]);
  });

  it("accepts the signature in either encoding wallets use: base64 and prefixed base58", async () => {
    for (const encode of [
      (signature: Buffer) => signature.toString("base64"),
      (signature: Buffer) => `ed25519:${base58Encode(signature)}`,
    ]) {
      const w = makeRefundWorld();
      const { refund } = await waiting(w);
      const prepared = await w.refunds.prepare(refund.id);
      const signature = signWithSecret(TEST_SECRET, nep413Digest(prepared.payload));

      const approved = await w.refunds.submit(refund.id, { publicKey: WALLET_KEY, signature: encode(signature) });

      expect(approved.status).toBe("submitted");
      expect(w.client.submitIntent.mock.calls[0]![0].signedData.signature).toBe(`ed25519:${base58Encode(signature)}`);
    }
  });

  it("accepts the public key bare or as base64, as well as prefixed", async () => {
    const bare = base58Decode(WALLET_KEY.slice("ed25519:".length));
    for (const publicKey of [WALLET_KEY.slice("ed25519:".length), Buffer.from(bare).toString("base64")]) {
      const w = makeRefundWorld();
      const { refund } = await waiting(w);
      const prepared = await w.refunds.prepare(refund.id);
      const signed = signedWith(TEST_SECRET, prepared.payload);
      const approved = await w.refunds.submit(refund.id, { publicKey, signature: signed.signature });
      expect(approved.status).toBe("submitted");
    }
  });

  it("refuses a signature that is not for the prepared payload, and submits nothing", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    const prepared = await w.refunds.prepare(refund.id);
    const other = signedWith(TEST_SECRET, { ...prepared.payload, nonce: randomBytes(32).toString("base64") });

    expect(
      await refusal(() => w.refunds.submit(refund.id, { publicKey: other.public_key, signature: other.signature })),
    ).toMatchObject({ code: "invalid_signature", status: 422 });
    expect(w.client.submitIntent).not.toHaveBeenCalled();
    expect(w.refunds.get(refund.id).status).toBe("awaiting_approval");
  });

  it("refuses a signature by a different key than the one it claims", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    const prepared = await w.refunds.prepare(refund.id);
    const signed = signedWith(TEST_SECRET, prepared.payload);
    const stranger = publicKeyOf(`ed25519:${base58Encode(randomBytes(32))}`);

    expect(
      await refusal(() => w.refunds.submit(refund.id, { publicKey: stranger, signature: signed.signature })),
    ).toMatchObject({ code: "invalid_signature" });
    expect(w.client.submitIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["not base58 at all", "!!!"],
    ["the wrong length", "ed25519:3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ])("refuses a public key that is %s", async (_name, publicKey) => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    await w.refunds.prepare(refund.id);
    expect(await refusal(() => w.refunds.submit(refund.id, { publicKey, signature: "x" }))).toMatchObject({
      code: "invalid_key",
      status: 422,
    });
  });

  it("refuses a signature that is not 64 bytes", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    await w.refunds.prepare(refund.id);
    expect(
      await refusal(() => w.refunds.submit(refund.id, { publicKey: WALLET_KEY, signature: "AAAA" })),
    ).toMatchObject({ code: "invalid_signature", status: 422 });
  });

  it("will not submit a refund that was never prepared", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    expect(
      await refusal(() => w.refunds.submit(refund.id, { publicKey: WALLET_KEY, signature: "AAAA" })),
    ).toMatchObject({ code: "not_prepared", status: 409 });
  });

  it("refuses once the prepared intent has expired, and asks to prepare again", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    const prepared = await w.refunds.prepare(refund.id);
    const signed = signedWith(TEST_SECRET, prepared.payload);
    w.clock.advance(16 * MINUTE);

    expect(
      await refusal(() => w.refunds.submit(refund.id, { publicKey: signed.public_key, signature: signed.signature })),
    ).toMatchObject({ code: "intent_expired", status: 409 });
    expect(w.client.submitIntent).not.toHaveBeenCalled();
    expect(w.refunds.get(refund.id).status).toBe("awaiting_approval");
  });

  it("does not submit twice: a second approval of the same refund is refused", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    const { prepared } = await w.approve(refund.id);
    const signed = signedWith(TEST_SECRET, prepared.payload);
    expect(
      await refusal(() => w.refunds.submit(refund.id, { publicKey: signed.public_key, signature: signed.signature })),
    ).toMatchObject({ code: "not_awaiting_approval", status: 409 });
    expect(w.client.submitIntent).toHaveBeenCalledTimes(1);
  });

  it("leaves a refund pending when it is unknown whether 1Click accepted the intent, so the watcher finds out", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    w.client.submitIntent.mockRejectedValueOnce(oneClickFailure(0));
    const { refund: after } = await w.approve(refund.id);
    expect(after).toMatchObject({ status: "pending", intentHash: null });
    expect(w.refunds.listPollableRefunds().map((r) => r.id)).toEqual([refund.id]);
  });
});

describe("which keys can approve a refund", () => {
  it("refuses a key that is not registered for the settlement account, and says which key to register", async () => {
    const w = makeRefundWorld();
    w.keys.registered = false;
    const { refund } = await waiting(w);
    expect(await refusal(() => w.approve(refund.id))).toMatchObject({
      code: "key_not_registered",
      status: 409,
      message: expect.stringContaining(WALLET_KEY),
    });
    expect(w.client.submitIntent).not.toHaveBeenCalled();
    expect(w.refunds.get(refund.id).status).toBe("awaiting_approval");
  });

  it("reports 503 when the registration cannot be checked", async () => {
    const w = makeRefundWorld();
    w.keys.checkFails = true;
    const { refund } = await waiting(w);
    expect(await refusal(() => w.approve(refund.id))).toMatchObject({ code: "upstream_unavailable", status: 503 });
  });

  it.each([
    ["ML-DSA-65, NEAR's post-quantum key type", "mldsa65"],
    ["an unknown key type", "falcon512"],
  ])("refuses %s, which the NEAR Intents verifier does not accept yet", async (_name, type) => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    await w.refunds.prepare(refund.id);
    const publicKey = `${type}:${base58Encode(randomBytes(40))}`;
    const signature = `${type}:${base58Encode(randomBytes(64))}`;

    expect(await refusal(() => w.refunds.submit(refund.id, { publicKey, signature }))).toMatchObject({
      code: "unsupported_key_type",
      status: 422,
      message: expect.stringContaining("ed25519, secp256k1, p256"),
    });
    expect(w.client.submitIntent).not.toHaveBeenCalled();
  });

  it("lets a secp256k1 key through to the verifier, which checks that signature itself", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    await w.refunds.prepare(refund.id);
    const publicKey = `secp256k1:${base58Encode(randomBytes(64))}`;
    const signature = `secp256k1:${base58Encode(randomBytes(65))}`;

    const approved = await w.refunds.submit(refund.id, { publicKey, signature });

    expect(approved.status).toBe("submitted");
    expect(w.client.submitIntent.mock.calls[0]![0].signedData).toMatchObject({ public_key: publicKey, signature });
  });
});

describe("canceling a refund", () => {
  it("only cancels one that is still waiting", async () => {
    const w = makeRefundWorld();
    const { refund } = await waiting(w);
    await w.approve(refund.id);
    expect(await refusal(() => w.refunds.cancel(refund.id))).toMatchObject({ code: "cannot_cancel", status: 409 });
  });

  it("frees the amount, so it can be refunded again", async () => {
    const w = makeRefundWorld();
    const { invoice, refund } = await waiting(w, "5.00");
    w.refunds.cancel(refund.id);
    expect((await w.refunds.refund(invoice.id, { idempotencyKey: "key-2", amount: "5.00" })).refund.status).toBe(
      "awaiting_approval",
    );
  });
});

describe("counting refunds by status", () => {
  it("counts each status, for the dashboard's badge", async () => {
    const w = makeRefundWorld();
    await waiting(w);
    expect(w.refunds.counts()).toEqual({ awaiting_approval: 1, pending: 0, submitted: 0, succeeded: 0, failed: 0 });
  });
});
