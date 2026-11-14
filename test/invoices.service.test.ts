import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { failureOf } from "./helpers/failure.js";
import { USDC_BASE, makeWorld, REFUND_ADDRESS } from "./helpers/world.js";

const MINUTE = 60_000;

const failure = (fn: () => unknown) => failureOf(ApiError, fn);

describe("createInvoice", () => {
  it("stores an open invoice in base units of the settlement asset, expiring in 60 minutes by default", () => {
    const { service, clock } = makeWorld();

    const inv = service.createInvoice({ amount: "5.00", description: "Coffee beans", metadata: { orderId: "A-17" } });

    expect(inv).toMatchObject({
      status: "open",
      amount: "5000000",
      assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      description: "Coffee beans",
      metadata: { orderId: "A-17" },
      paidAttemptId: null,
      refundedAmount: "0",
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 60 * MINUTE).toISOString(),
    });
    expect(inv.id).toMatch(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(service.getInvoice(inv.id)).toEqual(inv);
  });

  it("honours expiresInMinutes", () => {
    const { service, clock } = makeWorld();
    const inv = service.createInvoice({ amount: "1", expiresInMinutes: 15 });
    expect(inv.expiresAt).toBe(new Date(clock.now().getTime() + 15 * MINUTE).toISOString());
  });

  it.each(["0", "0.000000", "-1", "abc", "5.1234567", ""])("rejects amount %j", async (amount) => {
    const { service } = makeWorld();
    const err = await failure(() => service.createInvoice({ amount }));
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_amount");
  });

  it.each([0, -5, 1.5, 10081])("rejects expiresInMinutes %j", async (expiresInMinutes) => {
    const { service } = makeWorld();
    const err = await failure(() => service.createInvoice({ amount: "1", expiresInMinutes }));
    expect(err).toMatchObject({ status: 400, code: "invalid_expiry" });
  });
});

describe("getInvoice", () => {
  it("is a 404 for an unknown id", async () => {
    const { service } = makeWorld();
    const err = await failure(() => service.getInvoice("inv_nope"));
    expect(err).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("listInvoices", () => {
  it("lists newest first, filters by status, and pages with a cursor", () => {
    const { service, clock } = makeWorld();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      ids.push(service.createInvoice({ amount: String(i + 1) }).id);
    }
    service.cancelInvoice(ids[1]!);

    const first = service.listInvoices({ limit: 2 });
    expect(first.invoices.map((i) => i.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).toBe(ids[3]);

    const second = service.listInvoices({ limit: 2, cursor: first.nextCursor! });
    expect(second.invoices.map((i) => i.id)).toEqual([ids[2], ids[1]]);

    const last = service.listInvoices({ limit: 2, cursor: second.nextCursor! });
    expect(last.invoices.map((i) => i.id)).toEqual([ids[0]]);
    expect(last.nextCursor).toBeNull();

    expect(service.listInvoices({ status: "canceled" }).invoices.map((i) => i.id)).toEqual([ids[1]]);
  });

  it("clamps the limit to 1..100 and defaults to 25", () => {
    const { service } = makeWorld();
    for (let i = 0; i < 30; i++) service.createInvoice({ amount: "1" });
    expect(service.listInvoices({}).invoices).toHaveLength(25);
    expect(service.listInvoices({ limit: 1000 }).invoices).toHaveLength(30);
    expect(service.listInvoices({ limit: 0 }).invoices).toHaveLength(1);
  });
});

describe("cancelInvoice", () => {
  it("cancels an open invoice and queues invoice.canceled", () => {
    const { service, events } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });

    const canceled = service.cancelInvoice(inv.id);

    expect(canceled.status).toBe("canceled");
    expect(events().map((e) => e.type)).toEqual(["invoice.canceled"]);
    expect(events()[0]!.data.invoice).toMatchObject({ id: inv.id, status: "canceled" });
  });

  it("refuses an invoice that is not open", async () => {
    const { service } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    service.cancelInvoice(inv.id);
    const err = await failure(() => service.cancelInvoice(inv.id));
    expect(err).toMatchObject({ status: 409, code: "invoice_not_open" });
  });

  it("is a 404 for an unknown invoice", async () => {
    const { service } = makeWorld();
    expect(await failure(() => service.cancelInvoice("inv_nope"))).toMatchObject({ status: 404 });
  });

  it("refuses while an attempt is confirming, because a payment is already on its way", async () => {
    const { service, db } = makeWorld();
    const inv = service.createInvoice({ amount: "5" });
    await service.createAttempt(inv.id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
    db.prepare("UPDATE attempts SET status = 'confirming'").run();

    const err = await failure(() => service.cancelInvoice(inv.id));
    expect(err).toMatchObject({ status: 409, code: "payment_in_progress" });
    expect(service.getInvoice(inv.id).status).toBe("open");
  });
});
