import type { AttemptStatus, DeliveryState, Invoice, InvoiceStatus, RefundStatus } from "./types.js";

export type Tone = "success" | "neutral" | "warning" | "info" | "danger" | "muted";

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** `0x1234…abcd`: enough to recognise an address without filling a table cell. */
export function shorten(text: string, head = 8, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** How far through a limit: 0 to 100, never more, and 0 if there is no limit. */
export function percent(used: string, limit: string): number {
  const max = BigInt(limit);
  if (max <= 0n) return 0;
  const ratio = Number((BigInt(used) * 10_000n) / max) / 100;
  return Math.min(100, Math.max(0, ratio));
}

/** The label and colour for an invoice, which also says when part or all of it has been refunded. */
export function invoiceBadge(invoice: Pick<Invoice, "status" | "amountBase" | "refundedAmountBase">): {
  label: string;
  tone: Tone;
} {
  if (invoice.status === "paid") {
    const refunded = BigInt(invoice.refundedAmountBase);
    if (refunded >= BigInt(invoice.amountBase)) return { label: "Refunded", tone: "info" };
    if (refunded > 0n) return { label: "Partially refunded", tone: "info" };
    return { label: "Paid", tone: "success" };
  }
  const labels: Record<Exclude<InvoiceStatus, "paid">, { label: string; tone: Tone }> = {
    open: { label: "Open", tone: "neutral" },
    expired: { label: "Expired", tone: "muted" },
    canceled: { label: "Canceled", tone: "muted" },
  };
  return labels[invoice.status];
}

export interface Badge {
  label: string;
  tone: Tone;
}

export const attemptBadge = (status: AttemptStatus): Badge =>
  (
    {
      awaiting: { label: "Waiting for payment", tone: "neutral" },
      confirming: { label: "Confirming", tone: "neutral" },
      underpaid: { label: "Underpaid", tone: "warning" },
      paid: { label: "Paid", tone: "success" },
      refunded: { label: "Returned by 1Click", tone: "info" },
      failed: { label: "Failed", tone: "danger" },
      superseded: { label: "Superseded", tone: "muted" },
    } satisfies Record<AttemptStatus, Badge>
  )[status];

export const refundBadge = (status: RefundStatus): Badge =>
  (
    {
      pending: { label: "Starting", tone: "neutral" },
      submitted: { label: "In progress", tone: "neutral" },
      succeeded: { label: "Refunded", tone: "info" },
      failed: { label: "Failed", tone: "danger" },
    } satisfies Record<RefundStatus, Badge>
  )[status];

export const deliveryBadge = (state: DeliveryState): Badge =>
  (
    {
      delivered: { label: "Delivered", tone: "success" },
      pending: { label: "Pending", tone: "neutral" },
      failed: { label: "Failed", tone: "danger" },
    } satisfies Record<DeliveryState, Badge>
  )[state];

const csvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** Spreadsheet-safe CSV: quoted, and a leading = + - @ cannot start a formula. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
