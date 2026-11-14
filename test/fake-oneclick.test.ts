import { afterEach, describe, expect, it } from "vitest";
import { base58Encode } from "../src/near/keys.js";
import { signNep413, type Nep413Payload } from "../src/near/nep413.js";
import type { SignedNep413Intent } from "../src/oneclick/types.js";
import { startFakeOneClick, type FakeOneClick } from "./helpers/fakeOneClick.js";

let fake: FakeOneClick | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const quoteBody = (dry: boolean) => ({
  dry,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  amount: "5000000",
  refundTo: "0x1111111111111111111111111111111111111111",
  refundType: "ORIGIN_CHAIN",
  recipient: "shop-pay.near",
  recipientType: "INTENTS",
  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
});

async function quote(f: FakeOneClick, dry = false) {
  const res = await fetch(`${f.url}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(quoteBody(dry)),
  });
  return (await res.json()) as { quote: { depositAddress?: string } };
}

const statusOf = async (f: FakeOneClick, address: string) =>
  (await (await fetch(`${f.url}/v0/status?depositAddress=${address}`)).json()) as {
    status: string;
    swapDetails: { originChainTxHashes?: unknown[] };
  };

/** Poll until SUCCESS and return every distinct status seen, in order. */
async function watchUntilSuccess(f: FakeOneClick, address: string, timeoutMs = 3000) {
  const seen: string[] = [];
  let last: Awaited<ReturnType<typeof statusOf>> | undefined;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    last = await statusOf(f, address);
    if (seen.at(-1) !== last.status) seen.push(last.status);
    if (last.status === "SUCCESS") return { seen, last };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never reached SUCCESS, saw ${seen.join(" > ")}`);
}

describe("fake 1Click auto-pay (a mock payer for demos)", () => {
  it("walks a new quote forward through deposit and processing to success on its own", async () => {
    fake = await startFakeOneClick({ autoPay: { stepMs: 150 } });
    const address = (await quote(fake)).quote.depositAddress!;
    expect((await statusOf(fake, address)).status).toBe("PENDING_DEPOSIT");

    const { seen, last } = await watchUntilSuccess(fake, address);

    // Order, not every instant: a busy machine may skip over a short-lived status, but never go backwards.
    const order = ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"];
    expect(seen.map((s) => order.indexOf(s))).toEqual(seen.map((s) => order.indexOf(s)).toSorted((a, b) => a - b));
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(last!.swapDetails.originChainTxHashes).toHaveLength(1);
  });

  it("does nothing without the option, so tests stay in full control", async () => {
    fake = await startFakeOneClick();
    const address = (await quote(fake)).quote.depositAddress!;
    await new Promise((r) => setTimeout(r, 120));
    expect((await statusOf(fake, address)).status).toBe("PENDING_DEPOSIT");
  });

  it("ignores dry quotes, which have no deposit address", async () => {
    fake = await startFakeOneClick({ autoPay: { stepMs: 10 } });
    expect((await quote(fake, true)).quote.depositAddress).toBeUndefined();
  });

  it("counts the transitions still to come, and drops them when closed", async () => {
    fake = await startFakeOneClick({ autoPay: { stepMs: 5_000 } });
    expect(fake.pendingAutoPay()).toBe(0);

    await quote(fake);
    expect(fake.pendingAutoPay()).toBe(3);

    await fake.close();
    expect(fake.pendingAutoPay()).toBe(0);
    fake = undefined;
  });
});

const post = (f: FakeOneClick, path: string, body: unknown) =>
  fetch(`${f.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("fake 1Click refund intents (it checks what the verifier would)", () => {
  const SETTLEMENT = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const KEY = `ed25519:${base58Encode(Buffer.alloc(32, 5))}`;
  /** A refund quote (funded from the Intents balance) and the intent generated for it. */
  async function refundIntent(f: FakeOneClick) {
    const body = {
      ...quoteBody(false),
      swapType: "EXACT_INPUT",
      originAsset: SETTLEMENT,
      depositType: "INTENTS",
      destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      refundTo: "shop-pay.near",
      refundType: "INTENTS",
      recipient: "0x1111111111111111111111111111111111111111",
      recipientType: "DESTINATION_CHAIN",
    };
    const quoted = (await (await post(f, "/v0/quote", body)).json()) as { quote: { depositAddress: string } };
    const depositAddress = quoted.quote.depositAddress;
    const res = await post(f, "/v0/generate-intent", {
      type: "swap_transfer",
      standard: "nep413",
      signerId: "shop-pay.near",
      depositAddress,
    });
    const generated = (await res.json()) as { intent: { standard: "nep413"; payload: Nep413Payload } };
    return { depositAddress, intent: generated.intent, status: res.status };
  }

  it("generates an intent that transfers the quote's amount to its deposit address, addressed to the verifier", async () => {
    fake = await startFakeOneClick({
      now: () => new Date("2026-11-07T12:00:00.000Z"),
      verifier: "verifier.example.testnet",
    });
    const { depositAddress, intent, status } = await refundIntent(fake);
    expect(status).toBe(200);
    expect(intent.payload.recipient).toBe("verifier.example.testnet");
    expect(JSON.parse(intent.payload.message)).toEqual({
      signer_id: "shop-pay.near",
      deadline: "2026-11-07T12:15:00.000Z",
      intents: [{ intent: "transfer", receiver_id: depositAddress, tokens: { [SETTLEMENT]: "5000000" } }],
    });
  });

  it("refuses to generate an intent for a payment quote or an unknown address", async () => {
    fake = await startFakeOneClick();
    const payment = (await quote(fake)).quote.depositAddress;
    const body = { type: "swap_transfer", standard: "nep413", signerId: "shop-pay.near" };
    expect((await post(fake, "/v0/generate-intent", { ...body, depositAddress: payment })).status).toBe(400);
    expect((await post(fake, "/v0/generate-intent", { ...body, depositAddress: "0xNOPE" })).status).toBe(404);
  });

  it("accepts a correctly signed intent once, and the deposit then shows as processing", async () => {
    fake = await startFakeOneClick();
    const { depositAddress, intent } = await refundIntent(fake);
    const signedData = { ...intent, ...signNep413(KEY, intent.payload) };

    const first = await post(fake, "/v0/submit-intent", { type: "swap_transfer", signedData });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ intentHash: expect.any(String) });
    expect((await statusOf(fake, depositAddress)).status).toBe("PROCESSING");
    expect(fake.submitted).toHaveLength(1);

    const replay = await post(fake, "/v0/submit-intent", { type: "swap_transfer", signedData });
    expect(replay.status).toBe(400);
    expect(fake.submitted).toHaveLength(1);
  });

  it.each([
    [
      "a wrong signature",
      (s: SignedNep413Intent) => ({ ...s, signature: `ed25519:${base58Encode(Buffer.alloc(64, 1))}` }),
    ],
    [
      "a message that was changed after it was issued",
      (s: SignedNep413Intent) => ({
        ...s,
        payload: { ...s.payload, message: s.payload.message.replace("5000000", "9000000") },
      }),
    ],
    [
      "an intent for another verifier",
      (s: SignedNep413Intent) => ({ ...s, payload: { ...s.payload, recipient: "intents.near" } }),
    ],
  ])("rejects %s", async (_name, tamper) => {
    fake = await startFakeOneClick({ verifier: "verifier.example.testnet" });
    const { depositAddress, intent } = await refundIntent(fake);
    const signedData = tamper({ ...intent, ...signNep413(KEY, intent.payload) });

    const res = await post(fake, "/v0/submit-intent", { type: "swap_transfer", signedData });

    expect(res.status).toBe(400);
    expect((await statusOf(fake, depositAddress)).status).toBe("PENDING_DEPOSIT");
  });
});
