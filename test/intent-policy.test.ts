import { describe, expect, it } from "vitest";
import { IntentPolicyError, assertSafeToSign, type IntentExpectation } from "../src/refunds/intentPolicy.js";
import type { Nep413Payload } from "../src/near/nep413.js";
import { thrownBy } from "./helpers/failure.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const USDC = "nep141:usdc.tidepool-sandbox.testnet";
const OTHER = "nep141:usdt.tidepool-sandbox.testnet";
const DEPOSIT = "a".repeat(64);

const expected: IntentExpectation = {
  signerId: "shop-pay.testnet",
  verifier: "verifier.tidepool-sandbox.testnet",
  settlementAssetId: USDC,
  amount: 3_000_000n,
  depositAddress: DEPOSIT,
  now: NOW,
};

const message = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    signer_id: "shop-pay.testnet",
    deadline: "2026-11-07T12:15:00.000Z",
    intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "3000000" } }],
    ...over,
  });

const payload = (over: Partial<Nep413Payload> = {}): Nep413Payload => ({
  message: message(),
  nonce: Buffer.alloc(32, 1).toString("base64"),
  recipient: "verifier.tidepool-sandbox.testnet",
  callbackUrl: null,
  ...over,
});

const refused = (p: Nep413Payload, e: IntentExpectation = expected) =>
  thrownBy(IntentPolicyError, () => assertSafeToSign(p, e)).message;

describe("what the server is willing to sign", () => {
  it("accepts a transfer of exactly the refund amount of the settlement asset to the quote's deposit address", () => {
    expect(() => assertSafeToSign(payload(), expected)).not.toThrow();
  });

  it("accepts a token_diff that only spends the settlement asset, up to the refund amount (the mainnet swap form)", () => {
    const diff = message({ intents: [{ intent: "token_diff", diff: { [USDC]: "-3000000", [OTHER]: "2990000" } }] });
    expect(() => assertSafeToSign(payload({ message: diff }), expected)).not.toThrow();
    const less = message({ intents: [{ intent: "token_diff", diff: { [USDC]: "-2999999" } }] });
    expect(() => assertSafeToSign(payload({ message: less }), expected)).not.toThrow();
  });

  it("tells the caller when the signed intent stops being usable", () => {
    expect(assertSafeToSign(payload(), expected).deadline).toEqual(new Date("2026-11-07T12:15:00.000Z"));
  });

  it("refuses a message addressed to a different contract than the verifier", () => {
    expect(refused(payload({ recipient: "intents.near" }))).toMatch(/recipient/);
  });

  it("refuses a message for a different signer, so the key cannot be used for someone else's account", () => {
    expect(refused(payload({ message: message({ signer_id: "someone-else.testnet" }) }))).toMatch(/signer/);
  });

  describe("transfers that would move the wrong money", () => {
    it.each([
      [
        "to an address other than the quote's deposit address (a drain)",
        { intent: "transfer", receiver_id: "b".repeat(64), tokens: { [USDC]: "3000000" } },
      ],
      ["of more than the refund amount", { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "3000001" } }],
      ["of less than the refund amount", { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "2999999" } }],
      ["of a different token", { intent: "transfer", receiver_id: DEPOSIT, tokens: { [OTHER]: "3000000" } }],
      [
        "of an extra token as well",
        { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "3000000", [OTHER]: "1" } },
      ],
      ["of no tokens", { intent: "transfer", receiver_id: DEPOSIT, tokens: {} }],
    ])("refuses a transfer %s", (_name, intent) => {
      expect(() => assertSafeToSign(payload({ message: message({ intents: [intent] }) }), expected)).toThrow(
        IntentPolicyError,
      );
    });

    it("refuses a second intent smuggled in beside a good one", () => {
      const good = { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "3000000" } };
      const drain = { intent: "transfer", receiver_id: "b".repeat(64), tokens: { [USDC]: "1" } };
      expect(() => assertSafeToSign(payload({ message: message({ intents: [good, drain] }) }), expected)).toThrow(
        IntentPolicyError,
      );
    });
  });

  describe("the total across all intents", () => {
    it("refuses two transfers that each look fine but together pay the deposit address twice", () => {
      const once = { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "3000000" } };
      const text = refused(payload({ message: message({ intents: [once, once] }) }));
      expect(text).toMatch(/total|more than/i);
    });

    it("refuses a transfer plus a diff that together spend more than the refund", () => {
      const half = 2_000_000n;
      const transfer = { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: half.toString() } };
      const diff = { intent: "token_diff", diff: { [USDC]: `-${half}` } };
      expect(() => assertSafeToSign(payload({ message: message({ intents: [transfer, diff] }) }), expected)).toThrow(
        IntentPolicyError,
      );
    });
  });

  describe("fields the server did not expect", () => {
    it("refuses a transfer that carries a notification (it would call a contract)", () => {
      const intent = {
        intent: "transfer",
        receiver_id: DEPOSIT,
        tokens: { [USDC]: "3000000" },
        notification: { msg: "x" },
      };
      expect(refused(payload({ message: message({ intents: [intent] }) }))).toContain("notification");
    });

    it("accepts a memo, which only labels the transfer", () => {
      const intent = { intent: "transfer", receiver_id: DEPOSIT, tokens: { [USDC]: "3000000" }, memo: "refund inv_1" };
      expect(() => assertSafeToSign(payload({ message: message({ intents: [intent] }) }), expected)).not.toThrow();
    });

    it("refuses a token_diff that spends nothing", () => {
      const m = message({ intents: [{ intent: "token_diff", diff: { [OTHER]: "5" } }] });
      expect(() => assertSafeToSign(payload({ message: m }), expected)).toThrow(IntentPolicyError);
    });
  });

  describe("token_diff that would spend too much", () => {
    it.each([
      ["more of the settlement asset than the refund", { [USDC]: "-3000001" }],
      ["a different token", { [USDC]: "-3000000", [OTHER]: "-1" }],
      ["only a different token", { [OTHER]: "-3000000" }],
      [
        "the settlement asset in two entries that add up to too much",
        { [USDC]: "-2000000", "nep141:usdc.tidepool-sandbox.testnet#2": "-2000000" },
      ],
    ])("refuses a diff that spends %s", (_name, diff) => {
      const m = message({ intents: [{ intent: "token_diff", diff }] });
      expect(() => assertSafeToSign(payload({ message: m }), expected)).toThrow(IntentPolicyError);
    });

    it("refuses a diff with an amount that is not an integer", () => {
      const m = message({ intents: [{ intent: "token_diff", diff: { [USDC]: "-3.5" } }] });
      expect(() => assertSafeToSign(payload({ message: m }), expected)).toThrow(IntentPolicyError);
    });
  });

  it.each([
    "ft_withdraw",
    "nft_withdraw",
    "mt_withdraw",
    "native_withdraw",
    "storage_deposit",
    "add_public_key",
    "remove_public_key",
    "set_auth_by_predecessor_id",
    "invalidate_nonces",
    "unknown_future_intent",
  ])("fails closed on the intent kind %s, which a refund never needs", (kind) => {
    const m = message({ intents: [{ intent: kind, token: USDC, amount: "3000000", receiver_id: DEPOSIT }] });
    expect(refused(payload({ message: m }))).toContain(kind);
  });

  it("refuses a message with no intents, or an absurd number of them", () => {
    expect(() => assertSafeToSign(payload({ message: message({ intents: [] }) }), expected)).toThrow(IntentPolicyError);
    const many = Array.from({ length: 6 }, () => ({
      intent: "transfer",
      receiver_id: DEPOSIT,
      tokens: { [USDC]: "3000000" },
    }));
    expect(() => assertSafeToSign(payload({ message: message({ intents: many }) }), expected)).toThrow(
      IntentPolicyError,
    );
  });

  describe("deadline", () => {
    it.each([
      ["already past", "2026-11-07T11:59:59.000Z"],
      ["exactly now", "2026-11-07T12:00:00.000Z"],
      ["more than a day away", "2026-11-08T12:00:01.000Z"],
      ["not a date", "soon"],
    ])("refuses a deadline that is %s", (_name, deadline) => {
      expect(() => assertSafeToSign(payload({ message: message({ deadline }) }), expected)).toThrow(IntentPolicyError);
    });

    it("refuses a message with no deadline", () => {
      const m = JSON.parse(message());
      delete m.deadline;
      expect(() => assertSafeToSign(payload({ message: JSON.stringify(m) }), expected)).toThrow(IntentPolicyError);
    });
  });

  it.each([
    ["not json", "{"],
    ["a JSON array", "[]"],
    ["a JSON string", '"x"'],
    ["null", "null"],
  ])("refuses a message that is %s", (_name, bad) => {
    expect(() => assertSafeToSign(payload({ message: bad }), expected)).toThrow(IntentPolicyError);
  });

  it("explains what it refused without printing a key", () => {
    const text = refused(payload({ message: message({ intents: [{ intent: "ft_withdraw", token: USDC }] }) }));
    expect(text).toMatch(/refus|not allowed/i);
  });
});
