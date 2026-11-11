import { afterEach, describe, expect, it } from "vitest";
import { EVM_ADDRESS, makeStack, type Stack } from "./helpers/stack.js";
import { TOKENS, USDC_BASE } from "./helpers/world.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STELLAR_USDC = TOKENS.find((t) => t.blockchain === "stellar" && t.symbol === "USDC")!.assetId;
const STELLAR_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function start(options: Parameters<typeof makeStack>[0] = {}) {
  stack = await makeStack(options);
  return stack;
}

/** Merchant creates an invoice; the payer picks a token. Returns both as the APIs report them. */
async function invoiceWithAttempt(
  s: Stack,
  { amount = "5.00", expiresInMinutes, originAsset = USDC_BASE, refundTo = EVM_ADDRESS } = {} as {
    amount?: string;
    expiresInMinutes?: number;
    originAsset?: string;
    refundTo?: string;
  },
) {
  const invoice = (
    await s.merchant("POST", "/v1/invoices", { amount, ...(expiresInMinutes ? { expiresInMinutes } : {}) })
  ).json();
  const attemptRes = await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, { originAsset, refundTo });
  return { invoice, attempt: attemptRes.json(), attemptRes };
}

/** Make 1Click report `status` for the attempt, let time pass, and run one poll. */
async function step(s: Stack, address: string, status: Parameters<Stack["fake"]["setStatus"]>[1], details = {}) {
  s.fake.setStatus(address, status, details);
  s.clock.advance(10 * SECOND);
  await s.poller.pollOnce();
}

const attemptView = async (s: Stack, id: string) => (await s.pay("GET", `/pay/attempts/${id}`)).json();

describe("invoice creation to invoice.paid (Phase 2 exit check)", () => {
  it("takes a payment from invoice to paid, with the webhook event and 1Click's proof", async () => {
    const s = await start();
    const { invoice, attempt, attemptRes } = await invoiceWithAttempt(s);

    // The quote 1Click received is the PLAN section 8 request.
    expect(attemptRes.statusCode).toBe(201);
    const quoteCalls = s.fake.to("/v0/quote");
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0]!.body).toMatchObject({
      dry: false,
      swapType: "EXACT_OUTPUT",
      originAsset: USDC_BASE,
      destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      amount: "5000000",
      refundTo: EVM_ADDRESS,
      recipient: "shop-pay.near",
      recipientType: "INTENTS",
      depositMode: "SIMPLE",
      referral: "tilll",
    });
    expect(attempt).toMatchObject({ status: "awaiting", invoiceStatus: "open", symbol: "USDC", chain: "base" });
    expect(attempt.depositAddress).toMatch(/^0xFAKE/);

    // 1Click reports progress; the payer's view follows.
    const seen: string[] = [];
    for (const swap of ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"] as const) {
      await step(s, attempt.depositAddress, swap);
      seen.push((await attemptView(s, attempt.id)).status);
    }
    expect(seen).toEqual(["awaiting", "confirming", "confirming", "paid"]);

    const final = await attemptView(s, attempt.id);
    expect(final.invoiceStatus).toBe("paid");
    expect(final.txLinks).toHaveLength(1);

    // The merchant sees a paid invoice.
    const detail = (await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json();
    expect(detail.invoice).toMatchObject({ status: "paid", paidAttemptId: attempt.id });
    expect(detail.attempts[0]).toMatchObject({ status: "paid", oneclickStatus: "SUCCESS" });

    // Exactly one invoice.paid event is queued, carrying 1Click's quote signature as proof.
    const paid = s.events().filter((e) => e.type === "invoice.paid");
    expect(paid).toHaveLength(1);
    expect(paid[0]!.data.invoice).toMatchObject({ id: invoice.id, status: "paid", amount: "5" });
    expect(paid[0]!.proof).toEqual({
      oneclickQuoteSignature: detail.attempts[0].raw.quote.signature,
      oneclickCorrelationId: detail.attempts[0].raw.quote.correlationId,
    });
    expect(paid[0]!.proof!.oneclickQuoteSignature).toMatch(/^ed25519:FAKESIG/);
    expect(s.events().map((e) => e.type)).toEqual(["invoice.paid"]);
  });

  it("never lets an unpaid invoice look paid while 1Click still reports no deposit", async () => {
    const s = await start();
    const { invoice, attempt } = await invoiceWithAttempt(s);
    for (let i = 0; i < 5; i++) await step(s, attempt.depositAddress, "PENDING_DEPOSIT");
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("open");
    expect(s.events()).toEqual([]);
  });
});

describe("underpaid path", () => {
  it("flags a short deposit, keeps the invoice open, then follows 1Click's refund", async () => {
    const s = await start();
    const { invoice, attempt } = await invoiceWithAttempt(s);

    await step(s, attempt.depositAddress, "INCOMPLETE_DEPOSIT", { depositedAmount: "1000000" });
    expect((await attemptView(s, attempt.id)).status).toBe("underpaid");
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("open");

    await step(s, attempt.depositAddress, "REFUNDED", { refundReason: "PARTIAL_DEPOSIT", refundedAmount: "1000000" });
    expect((await attemptView(s, attempt.id)).status).toBe("refunded");
    expect(s.events().map((e) => e.type)).toEqual(["payment.underpaid", "payment.refunded_by_network"]);
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("open");
  });

  it("lets the payer top up a short deposit to completion", async () => {
    const s = await start();
    const { invoice, attempt } = await invoiceWithAttempt(s);
    await step(s, attempt.depositAddress, "INCOMPLETE_DEPOSIT");
    await step(s, attempt.depositAddress, "PROCESSING");
    await step(s, attempt.depositAddress, "SUCCESS");
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("paid");
    expect(s.events().map((e) => e.type)).toEqual(["payment.underpaid", "invoice.paid"]);
  });
});

describe("expired path", () => {
  it("expires an unpaid invoice, tells the merchant once, and stops taking new attempts", async () => {
    const s = await start();
    const { invoice } = await invoiceWithAttempt(s, { expiresInMinutes: 1 });

    s.clock.advance(61 * SECOND);
    await s.poller.pollOnce();
    await s.poller.pollOnce();

    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("expired");
    expect(s.events().map((e) => e.type)).toEqual(["invoice.expired"]);

    const late = await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, {
      originAsset: USDC_BASE,
      refundTo: EVM_ADDRESS,
    });
    expect([late.statusCode, late.json().error.code]).toEqual([409, "invoice_not_open"]);
    expect(s.fake.to("/v0/quote")).toHaveLength(1);
  });

  it("refunds in full a payment that arrives after the invoice expired (expired but late paid)", async () => {
    const s = await start();
    const { invoice, attempt } = await invoiceWithAttempt(s, { expiresInMinutes: 1 });
    s.clock.advance(61 * SECOND);
    await s.poller.pollOnce();

    await step(s, attempt.depositAddress, "SUCCESS");

    const detail = (await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json();
    expect(detail.invoice.status).toBe("expired");
    expect(detail.refunds).toEqual([
      expect.objectContaining({
        attemptId: attempt.id,
        amountBase: "5000000",
        reason: "overpayment_auto",
        status: "submitted",
      }),
    ]);
    // The intent that went out moves the whole payment, to the payer's own address.
    expect(s.fake.to("/v0/quote").at(-1)?.body).toMatchObject({
      amount: "5000000",
      recipient: EVM_ADDRESS,
      depositType: "INTENTS",
    });
    expect(s.fake.submitted).toHaveLength(1);

    await step(s, s.refunds.get(detail.refunds[0].id).depositAddress!, "SUCCESS");

    expect(s.refunds.get(detail.refunds[0].id).status).toBe("succeeded");
    expect(s.service.getInvoice(invoice.id).refundedAmount).toBe("0");
    expect(s.events().map((e) => e.type)).toEqual([
      "invoice.expired",
      "payment.duplicate_refunded",
      "refund.succeeded",
    ]);
  });

  it("waits for a deposit that is already confirming instead of expiring the invoice under it", async () => {
    const s = await start();
    const { invoice, attempt } = await invoiceWithAttempt(s, { expiresInMinutes: 1 });
    await step(s, attempt.depositAddress, "PROCESSING");
    s.clock.advance(2 * MINUTE);
    await s.poller.pollOnce();
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("open");

    await step(s, attempt.depositAddress, "SUCCESS");
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().invoice.status).toBe("paid");
  });
});

describe("switching tokens", () => {
  it("supersedes the first address, keeps watching it, and refunds a duplicate payment", async () => {
    const s = await start();
    const { invoice, attempt: first } = await invoiceWithAttempt(s);
    const second = (
      await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, { originAsset: USDC_BASE, refundTo: EVM_ADDRESS })
    ).json();
    expect((await attemptView(s, first.id)).status).toBe("superseded");

    await step(s, second.depositAddress, "SUCCESS");
    await step(s, first.depositAddress, "SUCCESS");

    const detail = (await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json();
    expect(detail.invoice).toMatchObject({ status: "paid", paidAttemptId: second.id });
    expect(detail.refunds).toHaveLength(1);
    expect(detail.refunds[0]).toMatchObject({ attemptId: first.id, reason: "overpayment_auto", status: "submitted" });
    expect(s.events().map((e) => e.type)).toEqual(["invoice.paid", "payment.duplicate_refunded"]);
    expect(s.fake.submitted).toHaveLength(1);

    await step(s, s.refunds.get(detail.refunds[0].id).depositAddress!, "SUCCESS");
    expect(s.events().map((e) => e.type)).toEqual(["invoice.paid", "payment.duplicate_refunded", "refund.succeeded"]);
  });
});

describe("what 1Click rejects", () => {
  it("returns 400 invalid_refund_address when 1Click says the refund address is wrong for the chain", async () => {
    const s = await start();
    const invoice = (await s.merchant("POST", "/v1/invoices", { amount: "5" })).json();
    const res = await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, {
      originAsset: USDC_BASE,
      refundTo: "not-an-address",
    });
    expect([res.statusCode, res.json().error.code]).toEqual([400, "invalid_refund_address"]);
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().attempts).toEqual([]);
  });

  it("reports 1Click being down as 503 and leaves no half-made attempt", async () => {
    const s = await start();
    const invoice = (await s.merchant("POST", "/v1/invoices", { amount: "5" })).json();
    s.fake.failNext("/v0/quote", 503, { message: "maintenance" });
    const res = await s.pay("POST", `/pay/invoices/${invoice.id}/attempts`, {
      originAsset: USDC_BASE,
      refundTo: EVM_ADDRESS,
    });
    expect(res.statusCode).toBe(502);
    expect((await s.merchant("GET", `/v1/invoices/${invoice.id}`)).json().attempts).toEqual([]);
  });
});

describe("memo chains", () => {
  it("asks for MEMO up front on a configured chain and sends the memo with every status poll", async () => {
    const s = await start({ memoChains: ["stellar"] });
    const { attempt } = await invoiceWithAttempt(s, { originAsset: STELLAR_USDC, refundTo: STELLAR_ADDRESS });
    expect(attempt.depositMemo).toBe("12345");
    expect(s.fake.to("/v0/quote").map((r) => r.body!.depositMode)).toEqual(["MEMO"]);

    await step(s, attempt.depositAddress, "PROCESSING");
    expect(s.fake.to("/v0/status").at(-1)!.query.get("depositMemo")).toBe("12345");
    expect((await attemptView(s, attempt.id)).status).toBe("confirming");
  });

  it("recovers when the memo chain list is wrong, by retrying once in the mode 1Click asks for", async () => {
    const s = await start({ memoChains: [] }); // we guess SIMPLE; the fake insists stellar needs MEMO
    const { attempt, attemptRes } = await invoiceWithAttempt(s, {
      originAsset: STELLAR_USDC,
      refundTo: STELLAR_ADDRESS,
    });

    expect(attemptRes.statusCode).toBe(201);
    expect(attempt.depositMemo).toBe("12345");
    expect(s.fake.to("/v0/quote").map((r) => r.body!.depositMode)).toEqual(["SIMPLE", "MEMO"]);
  });
});

describe("1Click availability while watching", () => {
  it("leaves the attempt alone during an outage, logs it, and catches up afterwards", async () => {
    const s = await start();
    const { attempt } = await invoiceWithAttempt(s);
    s.fake.setStatus(attempt.depositAddress, "PROCESSING");
    s.fake.failNext("/v0/status", 500);
    s.clock.advance(10 * SECOND);

    expect(await s.poller.pollOnce()).toMatchObject({ polled: 0, failed: 1 });
    expect((await attemptView(s, attempt.id)).status).toBe("awaiting");
    expect(s.log.error).toHaveBeenCalledTimes(1);

    expect(await s.poller.pollOnce()).toMatchObject({ polled: 1, failed: 0 });
    expect((await attemptView(s, attempt.id)).status).toBe("confirming");
  });
});

describe("API key", () => {
  it("sends X-API-Key to 1Click on every call when configured, and not otherwise", async () => {
    const keyed = await start({ apiKey: "partner.jwt.value" });
    await invoiceWithAttempt(keyed);
    expect(keyed.fake.requests.length).toBeGreaterThan(0);
    expect(keyed.fake.requests.every((r) => r.headers["x-api-key"] === "partner.jwt.value")).toBe(true);
    await keyed.close();

    const anon = await start();
    await invoiceWithAttempt(anon);
    expect(anon.fake.requests.every((r) => r.headers["x-api-key"] === undefined)).toBe(true);
  });

  it("never exposes the key through the API", async () => {
    const s = await start({ apiKey: "partner.jwt.value" });
    const { invoice, attemptRes } = await invoiceWithAttempt(s);
    const detail = await s.merchant("GET", `/v1/invoices/${invoice.id}`);
    expect(attemptRes.body + detail.body).not.toContain("partner.jwt.value");
  });
});
