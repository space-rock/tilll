import { afterEach, describe, expect, it } from "vitest";
import { verifySignature } from "../src/webhooks/signature.js";
import { EVM_ADDRESS, WEBHOOK_SECRET, makeStack, type Stack } from "./helpers/stack.js";
import { USDC_BASE } from "./helpers/world.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function start(options: Parameters<typeof makeStack>[0] = {}) {
  // Signatures carry real timestamps, so this clock starts at the real present.
  stack = await makeStack({ startAt: new Date(), ...options });
  return stack;
}

async function paidInvoice(s: Stack) {
  const invoice = (await s.merchant("POST", "/v1/invoices", { amount: "5.00" })).json();
  const attempt = (
    await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, { originAsset: USDC_BASE, refundTo: EVM_ADDRESS })
  ).json();
  s.fake.setStatus(attempt.depositAddress, "SUCCESS");
  s.clock.advance(10 * SECOND);
  await s.poller.pollOnce();
  return { invoice, attempt };
}

const outbox = (s: Stack) =>
  s.db
    .prepare(
      "SELECT id, event_type, attempts, next_try_at, delivered_at, last_error FROM webhook_deliveries ORDER BY rowid",
    )
    .all() as {
    id: string;
    event_type: string;
    attempts: number;
    next_try_at: string | null;
    delivered_at: string | null;
    last_error: string | null;
  }[];

describe("a payment becomes a signed webhook the merchant's server verifies (Phase 4 exit check)", () => {
  it("delivers invoice.paid to the receiver, signed over the exact bytes, carrying 1Click's proof", async () => {
    const s = await start();
    const { invoice } = await paidInvoice(s);

    expect(await s.dispatcher.deliverDue()).toEqual({ delivered: 1, failed: 0, gaveUp: 0 });

    // The receiver's own handler verified the signature and accepted it.
    expect(s.receiver.events).toHaveLength(1);
    const event = s.receiver.events[0]!;
    expect(event).toMatchObject({
      type: "invoice.paid",
      data: { invoice: { id: invoice.id, status: "paid", amount: "5" } },
    });
    expect(event.proof?.oneclickQuoteSignature).toMatch(/^ed25519:FAKESIG/);
    // The mock network signs with a made-up signature, so Tilll reports that it could not verify it: it never says "true" by default.
    expect(event.proofVerified).toBe(false);

    // And an independent check of what actually went over the wire.
    const sent = s.receiver.deliveries[0]!;
    expect(sent.headers.get("tilll-event-id")).toBe(event.id);
    expect(
      verifySignature({
        secret: WEBHOOK_SECRET,
        header: sent.headers.get("tilll-signature") ?? "",
        rawBody: sent.rawBody,
      }),
    ).toMatchObject({ ok: true });
    expect(
      verifySignature({
        secret: "whsec_someone_else",
        header: sent.headers.get("tilll-signature") ?? "",
        rawBody: sent.rawBody,
      }),
    ).toMatchObject({ ok: false });

    expect(outbox(s)).toEqual([
      expect.objectContaining({
        id: event.id,
        event_type: "invoice.paid",
        attempts: 1,
        delivered_at: expect.any(String),
        next_try_at: null,
      }),
    ]);
  });

  it("delivers a payment's events in the order they happened", async () => {
    const s = await start();
    const invoice = (await s.merchant("POST", "/v1/invoices", { amount: "5.00" })).json();
    const attempt = (
      await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, { originAsset: USDC_BASE, refundTo: EVM_ADDRESS })
    ).json();
    s.fake.setStatus(attempt.depositAddress, "INCOMPLETE_DEPOSIT");
    s.clock.advance(10 * SECOND);
    await s.poller.pollOnce();
    s.fake.setStatus(attempt.depositAddress, "SUCCESS");
    s.clock.advance(10 * SECOND);
    await s.poller.pollOnce();

    await s.dispatcher.deliverDue();

    expect(s.receiver.events.map((e) => e.type)).toEqual(["payment.underpaid", "invoice.paid"]);
  });

  it("does not send anything for a payment that has not happened", async () => {
    const s = await start();
    await s.merchant("POST", "/v1/invoices", { amount: "5.00" });
    await s.dispatcher.deliverDue();
    expect(s.receiver.deliveries).toEqual([]);
  });
});

describe("when the merchant's server is down (PLAN section 13)", () => {
  it("retries at 1 and 5 minutes and delivers once it is back, processing the event exactly once", async () => {
    const s = await start();
    s.receiver.failing = true;
    await paidInvoice(s);

    expect(await s.dispatcher.deliverDue()).toMatchObject({ delivered: 0, failed: 1 });
    expect(outbox(s)[0]).toMatchObject({ attempts: 1, last_error: "HTTP 500", delivered_at: null });

    s.clock.advance(MINUTE);
    expect(await s.dispatcher.deliverDue()).toMatchObject({ failed: 1 });
    s.clock.advance(5 * MINUTE);
    s.receiver.failing = false;
    expect(await s.dispatcher.deliverDue()).toMatchObject({ delivered: 1 });

    expect(outbox(s)[0]).toMatchObject({ attempts: 3, last_error: null, next_try_at: null });
    expect(s.receiver.events).toHaveLength(1);
    expect(s.receiver.deliveries).toHaveLength(3);
  });

  it("is safe when the same event is delivered twice, because the receiver dedupes on Tilll-Event-Id", async () => {
    const s = await start();
    await paidInvoice(s);
    await s.dispatcher.deliverDue();
    const id = outbox(s)[0]!.id;

    const again = await s.dispatcher.deliver(id, { force: true });

    expect(again.delivered).toBe(true);
    expect(s.receiver.deliveries).toHaveLength(2);
    expect(s.receiver.events).toHaveLength(1);
  });
});

describe("a misconfigured secret", () => {
  it("is refused by the receiver with 401 and shows up as the delivery error", async () => {
    const s = await start({ webhookSecret: "whsec_not_what_the_receiver_expects" });
    await paidInvoice(s);

    await s.dispatcher.deliverDue();

    expect(s.receiver.events).toEqual([]);
    expect(outbox(s)[0]).toMatchObject({ attempts: 1, last_error: "HTTP 401", delivered_at: null });
  });
});

describe("POST /v1/webhooks/test", () => {
  it("sends a real ping to the configured endpoint and says it was delivered", async () => {
    const s = await start();
    const res = await s.merchant("POST", "/v1/webhooks/test", {});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: true, status: 200, error: null });
    expect(s.receiver.events.map((e) => e.type)).toEqual(["ping"]);
  });

  it("says what went wrong when the endpoint is unhappy, and does not retry the test", async () => {
    const s = await start();
    s.receiver.failing = true;

    const res = await s.merchant("POST", "/v1/webhooks/test", {});

    expect(res.json()).toMatchObject({ delivered: false, status: 500, error: "HTTP 500" });
    s.clock.advance(24 * 60 * MINUTE);
    await s.dispatcher.deliverDue();
    expect(s.receiver.deliveries).toHaveLength(1);
  });
});
