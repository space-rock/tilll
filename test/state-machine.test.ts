import { describe, expect, it } from "vitest";
import type { QuoteResponse, SwapDetails, SwapStatus } from "../src/oneclick/types.js";
import realQuote from "./fixtures/quote-dry-exact-output.json" with { type: "json" };
import { USDC_BASE, makeWorld, quoteResponseFor, statusResponseFor, REFUND_ADDRESS } from "./helpers/world.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const input = { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS };

async function setup(amount = "5") {
  const w = makeWorld();
  const inv = w.service.createInvoice({ amount });
  const att = await w.service.createAttempt(inv.id, input);
  const apply = (attempt: { id: string; quote: typeof att.quote }, status: SwapStatus, details?: SwapDetails) =>
    w.service.applyStatus(attempt.id, statusResponseFor(attempt.quote, status, details));
  return { ...w, inv, att, apply };
}

const PAID_DETAILS: SwapDetails = {
  amountOut: "5000000",
  originChainTxHashes: [{ hash: "0xdeadbeef", explorerUrl: "https://basescan.org/tx/0xdeadbeef" }],
};

describe("applyStatus: attempt status", () => {
  it("keeps an awaiting attempt awaiting and queues nothing while no deposit has arrived", async () => {
    const { service, att, apply, events } = await setup();
    apply(att, "PENDING_DEPOSIT");
    expect(service.getAttempt(att.id)).toMatchObject({ status: "awaiting", oneclickStatus: "PENDING_DEPOSIT" });
    expect(events()).toEqual([]);
  });

  it("moves to confirming on KNOWN_DEPOSIT_TX and PROCESSING, recording the raw status and the full response", async () => {
    const { service, att, apply, clock } = await setup();
    clock.advance(MINUTE);

    apply(att, "PROCESSING", { originChainTxHashes: PAID_DETAILS.originChainTxHashes! });

    const stored = service.getAttempt(att.id);
    expect(stored.status).toBe("confirming");
    expect(stored.oneclickStatus).toBe("PROCESSING");
    expect(stored.depositTxHash).toBe("0xdeadbeef");
    expect(stored.statusResponse?.status).toBe("PROCESSING");
    expect(stored.updatedAt).toBe(clock.now().toISOString());
  });

  it("queues payment.underpaid exactly once when a short deposit arrives", async () => {
    const { att, apply, events, inv, service } = await setup();

    apply(att, "INCOMPLETE_DEPOSIT", { depositedAmount: "1000000" });
    apply(att, "INCOMPLETE_DEPOSIT", { depositedAmount: "1000000" });

    expect(service.getAttempt(att.id).status).toBe("underpaid");
    expect(events().map((e) => e.type)).toEqual(["payment.underpaid"]);
    expect(events()[0]!.data.invoice).toMatchObject({ id: inv.id, status: "open" });
    expect(events()[0]!.data.attempt).toMatchObject({ id: att.id, status: "underpaid" });
    expect(service.getInvoice(inv.id).status).toBe("open");
  });

  it("lets an underpaid attempt be topped up to paid", async () => {
    const { att, apply, service, inv } = await setup();
    apply(att, "INCOMPLETE_DEPOSIT");
    apply(att, "SUCCESS", PAID_DETAILS);
    expect(service.getAttempt(att.id).status).toBe("paid");
    expect(service.getInvoice(inv.id).status).toBe("paid");
  });

  it("queues payment.refunded_by_network when 1Click refunds the deposit", async () => {
    const { att, apply, events, service, inv } = await setup();
    apply(att, "REFUNDED", { refundReason: "PARTIAL_DEPOSIT" });
    expect(service.getAttempt(att.id).status).toBe("refunded");
    expect(events().map((e) => e.type)).toEqual(["payment.refunded_by_network"]);
    expect(service.getInvoice(inv.id).status).toBe("open");
  });

  it("queues payment.failed when the swap fails", async () => {
    const { att, apply, events, service } = await setup();
    apply(att, "FAILED");
    expect(service.getAttempt(att.id).status).toBe("failed");
    expect(events().map((e) => e.type)).toEqual(["payment.failed"]);
  });

  it("ignores updates to an attempt that already reached a terminal state", async () => {
    const { att, apply, events, service } = await setup();
    apply(att, "FAILED");
    apply(att, "SUCCESS", PAID_DETAILS);
    expect(service.getAttempt(att.id).status).toBe("failed");
    expect(events().map((e) => e.type)).toEqual(["payment.failed"]);
  });

  it("is a 404 for an unknown attempt", async () => {
    const { service, att } = await setup();
    expect(() => service.applyStatus("att_nope", statusResponseFor(att.quote, "PROCESSING"))).toThrow(/No attempt/);
  });
});

describe("applyStatus: the first successful payment", () => {
  it("marks the attempt and the invoice paid and queues invoice.paid with the 1Click proof", async () => {
    const { att, inv, apply, events, service } = await setup();

    apply(att, "SUCCESS", PAID_DETAILS);

    expect(service.getAttempt(att.id)).toMatchObject({
      status: "paid",
      oneclickStatus: "SUCCESS",
      depositTxHash: "0xdeadbeef",
    });
    expect(service.getInvoice(inv.id)).toMatchObject({ status: "paid", paidAttemptId: att.id });

    const [event, ...rest] = events();
    expect(rest).toEqual([]);
    expect(event!.type).toBe("invoice.paid");
    expect(event!.data.invoice).toMatchObject({ id: inv.id, status: "paid", paidAttemptId: att.id, amount: "5" });
    expect(event!.data.attempt).toMatchObject({
      id: att.id,
      status: "paid",
      origin: { chain: "base", symbol: "USDC" },
      txLinks: [{ hash: "0xdeadbeef", explorerUrl: "https://basescan.org/tx/0xdeadbeef" }],
    });
    expect(event!.proof).toEqual({
      oneclickQuoteSignature: att.quote.signature,
      oneclickCorrelationId: att.quote.correlationId,
    });
    // The test quotes carry made-up signatures, so Tilll says it could not verify them.
    expect(event!.proofVerified).toBe(false);
  });

  it("says the proof verified when the quote really was signed by 1Click (a real recorded response)", async () => {
    const w = makeWorld();
    w.client.quote.mockImplementationOnce(async () => {
      const real = structuredClone(realQuote) as unknown as QuoteResponse;
      real.quote.depositAddress = "0xREALSIGNED";
      return real;
    });
    const att = await w.service.createAttempt(w.service.createInvoice({ amount: "5" }).id, input);

    w.service.applyStatus(att.id, statusResponseFor(att.quote, "SUCCESS", PAID_DETAILS));

    const event = w.events().find((e) => e.type === "invoice.paid")!;
    expect(event.proofVerified).toBe(true);
    expect(event.proof?.oneclickQuoteSignature).toBe(realQuote.signature);
  });

  it("carries the verdict on the other payment events too, and none on events with no quote", async () => {
    const { att, apply, events, inv } = await setup();
    apply(att, "INCOMPLETE_DEPOSIT", { depositedAmount: "1000000" });
    apply(att, "FAILED");
    const withQuote = events().filter((e) => e.type.startsWith("payment."));
    expect(withQuote.map((e) => e.type)).toEqual(["payment.underpaid", "payment.failed"]);
    for (const e of withQuote) expect(e.proofVerified).toBe(false);
    expect(inv.status).toBe("open");
  });

  it("does nothing new when the same SUCCESS is applied twice", async () => {
    const { att, apply, events } = await setup();
    apply(att, "SUCCESS", PAID_DETAILS);
    apply(att, "SUCCESS", PAID_DETAILS);
    expect(events().map((e) => e.type)).toEqual(["invoice.paid"]);
  });

  it("counts a payment on a superseded attempt, because the payer may have paid the first address", async () => {
    const { service, inv, att, apply, events } = await setup();
    const second = await service.createAttempt(inv.id, input);
    expect(service.getAttempt(att.id).status).toBe("superseded");

    apply(att, "SUCCESS", PAID_DETAILS);

    expect(service.getInvoice(inv.id)).toMatchObject({ status: "paid", paidAttemptId: att.id });
    expect(events().map((e) => e.type)).toEqual(["invoice.paid"]);
    expect(service.getAttempt(second.id).status).toBe("awaiting");
  });
});

const refunds = (db: ReturnType<typeof makeWorld>["db"]) =>
  db.prepare("SELECT * FROM refunds ORDER BY id").all() as Record<string, unknown>[];

describe("applyStatus: money that arrives when the invoice is not open", () => {
  it("queues an automatic refund for a second payment on an already paid invoice", async () => {
    const { service, inv, att, apply, events, db, clock } = await setup();
    const second = await service.createAttempt(inv.id, input);
    apply(att, "SUCCESS", PAID_DETAILS);
    clock.advance(MINUTE);

    apply(second, "SUCCESS", { ...PAID_DETAILS, amountOut: "5000000" });

    expect(service.getAttempt(second.id).status).toBe("paid");
    expect(service.getInvoice(inv.id)).toMatchObject({ status: "paid", paidAttemptId: att.id, refundedAmount: "0" });
    expect(refunds(db)).toEqual([
      expect.objectContaining({
        invoice_id: inv.id,
        attempt_id: second.id,
        amount: "5000000",
        reason: "overpayment_auto",
        status: "pending",
        deposit_address: null,
        intent_hash: null,
      }),
    ]);
    expect(events().map((e) => e.type)).toEqual(["invoice.paid", "payment.duplicate_refunded"]);
    expect(events()[1]!.data).toMatchObject({
      cause: "invoice_already_paid",
      invoice: { id: inv.id, status: "paid" },
      attempt: { id: second.id },
      refund: { amountBase: "5000000", reason: "overpayment_auto", status: "pending" },
    });
  });

  it("falls back to the quoted amountOut when 1Click's status carries none", async () => {
    const { service, inv, att, apply, db } = await setup();
    const second = await service.createAttempt(inv.id, input);
    apply(att, "SUCCESS", PAID_DETAILS);
    apply(second, "SUCCESS", {});
    expect(refunds(db)[0]).toMatchObject({ amount: att.quote.quote.amountOut });
  });

  it("queues a refund for a payment that lands after the invoice expired", async () => {
    const { service, inv, att, apply, clock, events, db } = await setup();
    clock.advance(61 * MINUTE);
    expect(service.expireInvoices()).toBe(1);

    apply(att, "SUCCESS", PAID_DETAILS);

    expect(service.getInvoice(inv.id).status).toBe("expired");
    expect(refunds(db)).toHaveLength(1);
    expect(events().map((e) => e.type)).toEqual(["invoice.expired", "payment.duplicate_refunded"]);
    expect(events()[1]!.data.cause).toBe("invoice_expired");
  });

  it("queues a refund for a payment that lands after the invoice was canceled", async () => {
    const { service, inv, att, apply, events, db } = await setup();
    service.cancelInvoice(inv.id);

    apply(att, "SUCCESS", PAID_DETAILS);

    expect(service.getInvoice(inv.id).status).toBe("canceled");
    expect(refunds(db)).toHaveLength(1);
    expect(events().map((e) => e.type)).toEqual(["invoice.canceled", "payment.duplicate_refunded"]);
    expect(events()[1]!.data.cause).toBe("invoice_canceled");
  });

  it("does not queue the same refund twice when the status is applied again", async () => {
    const { service, inv, att, apply, db } = await setup();
    const second = await service.createAttempt(inv.id, input);
    apply(att, "SUCCESS", PAID_DETAILS);
    apply(second, "SUCCESS", PAID_DETAILS);
    apply(second, "SUCCESS", PAID_DETAILS);
    expect(refunds(db)).toHaveLength(1);
  });
});

describe("expireInvoices", () => {
  it("expires an open invoice past its time with no paid attempt, and queues invoice.expired once", async () => {
    const { service, inv, clock, events } = await setup();
    clock.advance(60 * MINUTE);

    expect(service.expireInvoices()).toBe(1);
    expect(service.expireInvoices()).toBe(0);

    expect(service.getInvoice(inv.id).status).toBe("expired");
    expect(events().map((e) => e.type)).toEqual(["invoice.expired"]);
    expect(events()[0]!.data.invoice).toMatchObject({ id: inv.id, status: "expired" });
  });

  it("leaves invoices that are not due, already paid or canceled alone", async () => {
    const { service, inv, att, apply, clock } = await setup();
    const other = service.createInvoice({ amount: "1" });
    const canceled = service.createInvoice({ amount: "1" });
    service.cancelInvoice(canceled.id);
    apply(att, "SUCCESS", PAID_DETAILS);
    clock.advance(59 * MINUTE);
    expect(service.expireInvoices()).toBe(0);

    clock.advance(2 * MINUTE);
    expect(service.expireInvoices()).toBe(1);
    expect(service.getInvoice(inv.id).status).toBe("paid");
    expect(service.getInvoice(other.id).status).toBe("expired");
    expect(service.getInvoice(canceled.id).status).toBe("canceled");
  });

  it("waits while a payment is confirming, so a deposit in flight is not refunded for being slow", async () => {
    const { service, inv, att, apply, clock } = await setup();
    apply(att, "PROCESSING");
    clock.advance(61 * MINUTE);

    expect(service.expireInvoices()).toBe(0);
    expect(service.getInvoice(inv.id).status).toBe("open");

    apply(att, "SUCCESS", PAID_DETAILS);
    expect(service.getInvoice(inv.id).status).toBe("paid");
    expect(service.expireInvoices()).toBe(0);
  });

  it("expires the invoice after a confirming payment ends without paying", async () => {
    const { service, inv, att, apply, clock } = await setup();
    apply(att, "PROCESSING");
    clock.advance(61 * MINUTE);
    apply(att, "REFUNDED");

    expect(service.expireInvoices()).toBe(1);
    expect(service.getInvoice(inv.id).status).toBe("expired");
  });
});

describe("listPollableAttempts", () => {
  it("returns live attempts oldest first and drops terminal ones", async () => {
    const { service, inv, att, apply } = await setup();
    const second = await service.createAttempt(inv.id, input);
    expect(service.listPollableAttempts().map((a) => a.id)).toEqual([att.id, second.id]);

    apply(second, "FAILED");
    expect(service.listPollableAttempts().map((a) => a.id)).toEqual([att.id]);
  });

  it("keeps watching an attempt that never received money until its deposit address goes inactive, so a late payment is still seen", async () => {
    const { service, att, clock } = await setup();
    const inactiveAt = Date.parse(att.quote.quote.timeWhenInactive!);
    expect(inactiveAt - Date.parse(att.deadline)).toBe(3 * 24 * HOUR); // what 1Click returned in the live run

    clock.advance(inactiveAt - clock.now().getTime() - 1);
    expect(service.listPollableAttempts()).toHaveLength(1);

    clock.advance(2);
    expect(service.listPollableAttempts()).toHaveLength(0);
  });

  it("falls back to 2 hours after the deadline when the quote says nothing about when the address goes inactive", async () => {
    const w = makeWorld();
    w.client.quote.mockImplementationOnce(async (req) => {
      const response = quoteResponseFor(req, 77);
      delete response.quote.timeWhenInactive;
      return response;
    });
    const att = await w.service.createAttempt(w.service.createInvoice({ amount: "5" }).id, input);
    const deadline = Date.parse(att.deadline);

    w.clock.advance(deadline - w.clock.now().getTime() + 2 * HOUR - 1);
    expect(w.service.listPollableAttempts()).toHaveLength(1);
    w.clock.advance(2);
    expect(w.service.listPollableAttempts()).toHaveLength(0);
  });

  it("never watches an unfunded attempt more than 7 days past its deadline, whatever the quote claims", async () => {
    const w = makeWorld();
    w.client.quote.mockImplementationOnce(async (req) => {
      const response = quoteResponseFor(req, 78);
      response.quote.timeWhenInactive = new Date(Date.parse(req.deadline) + 30 * 24 * HOUR).toISOString();
      return response;
    });
    const att = await w.service.createAttempt(w.service.createInvoice({ amount: "5" }).id, input);

    w.clock.advance(Date.parse(att.deadline) - w.clock.now().getTime() + 7 * 24 * HOUR - 1);
    expect(w.service.listPollableAttempts()).toHaveLength(1);
    w.clock.advance(2);
    expect(w.service.listPollableAttempts()).toHaveLength(0);
  });

  it("keeps watching an attempt with money on it for 24 hours after its deadline", async () => {
    const { service, att, apply, clock } = await setup();
    apply(att, "PROCESSING");
    const deadline = new Date(att.deadline).getTime();

    clock.advance(deadline - clock.now().getTime() + 24 * HOUR - 1);
    expect(service.listPollableAttempts()).toHaveLength(1);

    clock.advance(2);
    expect(service.listPollableAttempts()).toHaveLength(0);
  });
});
