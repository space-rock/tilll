import { describe, expect, it } from "vitest";
import {
  attemptBadge,
  formatRelative,
  formatUnits,
  deliveryBadge,
  formatDateTime,
  invoiceBadge,
  percent,
  refundBadge,
  shorten,
  toCsv,
} from "../dashboard/src/format.js";
import { buildTimeline } from "../dashboard/src/timeline.js";
import type { Attempt, Invoice, Refund } from "../dashboard/src/types.js";
import { attempt, invoice, refund } from "./helpers/dashboardApi.js";

describe("percent", () => {
  it.each([
    ["0", "200000000", 0],
    ["100000000", "200000000", 50],
    ["200000000", "200000000", 100],
    ["300000000", "200000000", 100],
    ["1", "3", 33.33],
    ["5", "0", 0],
  ])("%s of %s is %s", (used, limit, expected) => {
    expect(percent(used, limit)).toBe(expected);
  });
});

describe("shorten", () => {
  it("keeps the start and the end of a long address, and a short one whole", () => {
    expect(shorten("0x1111111111111111111111111111111111111111")).toBe("0x111111…111111");
    expect(shorten("abc")).toBe("abc");
  });
});

const badge = (over: Partial<Invoice>) => invoiceBadge(invoice(over) as Invoice);

describe("invoiceBadge", () => {
  it("says paid, partly refunded and refunded apart", () => {
    expect(badge({})).toEqual({ label: "Paid", tone: "success" });
    expect(badge({ refundedAmountBase: "1" })).toEqual({ label: "Partially refunded", tone: "info" });
    expect(badge({ refundedAmountBase: "12500000" })).toEqual({ label: "Refunded", tone: "info" });
  });
  it("shows an unpaid invoice by its state", () => {
    expect(badge({ status: "open" })).toEqual({ label: "Open", tone: "neutral" });
    expect(badge({ status: "expired" }).tone).toBe("muted");
    expect(badge({ status: "canceled" }).label).toBe("Canceled");
  });
});

describe("badges", () => {
  it("name every status the server can send", () => {
    for (const s of ["awaiting", "confirming", "underpaid", "paid", "refunded", "failed", "superseded"] as const) {
      expect(attemptBadge(s).label).toBeTruthy();
    }
    for (const s of ["awaiting_approval", "pending", "submitted", "succeeded", "failed"] as const)
      expect(refundBadge(s).label).toBeTruthy();
    expect(refundBadge("awaiting_approval")).toEqual({ label: "Waiting for approval", tone: "warning" });
    for (const s of ["delivered", "pending", "failed"] as const) expect(deliveryBadge(s).label).toBeTruthy();
    expect(attemptBadge("underpaid").tone).toBe("warning");
    expect(refundBadge("failed").tone).toBe("danger");
  });
});

describe("toCsv", () => {
  it("quotes every cell and doubles quotes inside them", () => {
    expect(
      toCsv([
        ["a", 'say "hi"'],
        ["1,2", "x"],
      ]),
    ).toBe('"a","say ""hi"""\r\n"1,2","x"');
  });
  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx"])("keeps %j from starting a spreadsheet formula", (value) => {
    expect(toCsv([[value]])).toBe(`"'${value}"`);
  });
});

describe("formatDateTime", () => {
  it("gives something readable for an ISO time", () => {
    expect(formatDateTime("2026-11-08T15:54:00.000Z")).toMatch(/2026/);
  });
});

const build = (a: Partial<Attempt>[], r: Partial<Refund>[], inv: Partial<Invoice> = {}) =>
  buildTimeline(
    invoice(inv) as Invoice,
    a.map((x) => attempt(x) as Attempt),
    r.map((x) => refund(x) as Refund),
  );

describe("buildTimeline", () => {
  it("lists what happened in the order it happened", () => {
    const entries = build([{}], [{ status: "succeeded", updatedAt: "2026-11-08T16:05:00.000Z" }]);
    expect(entries.map((e) => e.label)).toEqual([
      "Invoice created",
      "Customer started paying",
      "Payment received",
      "Refund requested",
      "Refund completed",
    ]);
  });

  it("sorts by time even when the data arrives in another order", () => {
    const entries = build(
      [{ createdAt: "2026-11-08T15:59:00.000Z", updatedAt: "2026-11-08T15:59:30.000Z" }],
      [{ createdAt: "2026-11-08T15:57:00.000Z" }],
    );
    expect(entries.map((e) => e.label)).toEqual([
      "Invoice created",
      "Refund requested",
      "Customer started paying",
      "Payment received",
    ]);
  });

  it("tells a second, extra payment from the one that paid the invoice, and marks automatic refunds", () => {
    const entries = build(
      [
        {},
        { id: "att_2", status: "paid", createdAt: "2026-11-08T15:56:00.000Z", updatedAt: "2026-11-08T15:57:00.000Z" },
      ],
      [{ reason: "overpayment_auto", createdAt: "2026-11-08T15:57:10.000Z" }],
    );
    const labels = entries.map((e) => e.label);
    expect(labels).toContain("Extra payment received");
    expect(labels).toContain("Refund queued for an extra payment");
  });

  it("shows a refund that waits for the wallet as waiting, and gives every entry a kind for its icon", () => {
    const entries = build([{}], [{ status: "awaiting_approval", updatedAt: "2026-11-08T16:01:00.000Z" }]);
    expect(entries.at(-1)).toMatchObject({ label: "Waiting for your approval", kind: "waiting" });
    expect(entries.map((e) => e.kind).every((k) => ["info", "success", "waiting", "danger"].includes(k))).toBe(true);
    expect(build([{}], [{ status: "succeeded" }]).at(-1)).toMatchObject({ label: "Refund completed", kind: "success" });
    expect(build([{}], [{ status: "failed", error: "no route" }]).at(-1)).toMatchObject({ kind: "danger" });
  });

  it("shows expiry, cancellation and failed refunds with the reason", () => {
    expect(build([], [], { status: "expired", paidAttemptId: null }).map((e) => e.label)).toContain("Invoice expired");
    expect(build([], [], { status: "canceled", paidAttemptId: null }).map((e) => e.label)).toContain(
      "Invoice canceled",
    );
    const failed = build([{}], [{ status: "failed", error: "no route", updatedAt: "2026-11-08T16:10:00.000Z" }]);
    expect(failed.at(-1)).toMatchObject({ label: "Refund failed", detail: "no route" });
  });
});

describe("formatUnits", () => {
  it.each([
    [12500000n, 6, "12.5"],
    [5000000n, 6, "5"],
    [1n, 6, "0.000001"],
    [0n, 6, "0"],
    [123n, 0, "123"],
    [-1500000n, 6, "-1.5"],
    [1234567890123456789012n, 18, "1234.567890123456789012"],
  ])("%s with %s decimals is %s, exactly", (base, decimals, expected) => {
    expect(formatUnits(base, decimals)).toBe(expected);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  it("says how long ago in the largest unit that fits", () => {
    expect(formatRelative("2026-11-08T11:55:00Z", now)).toMatch(/5 minutes ago/);
    expect(formatRelative("2026-11-08T09:00:00Z", now)).toMatch(/3 hours ago/);
    expect(formatRelative("2026-11-07T12:00:00Z", now)).toMatch(/yesterday/);
    expect(formatRelative("2026-11-08T12:00:30Z", now)).toBe("just now");
  });
  it("looks forward too", () => {
    expect(formatRelative("2026-11-08T14:00:00Z", now)).toMatch(/in 2 hours/);
  });
});
