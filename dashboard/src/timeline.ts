import { chainName } from "./format.js";
import type { Attempt, Invoice, Refund } from "./types.js";

/** How an entry looks in the timeline: what kind of moment it was. */
export type TimelineKind = "info" | "success" | "waiting" | "danger";

export interface TimelineEntry {
  at: string;
  label: string;
  detail?: string;
  kind: TimelineKind;
}

/** What happened to an invoice, oldest first, assembled from the timestamps the API gives. */
export function buildTimeline(invoice: Invoice, attempts: Attempt[], refunds: Refund[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ at: invoice.createdAt, label: "Invoice created", kind: "info" }];

  for (const attempt of attempts) {
    const route = `${attempt.origin.symbol} on ${chainName(attempt.origin.chain)}`;
    entries.push({
      at: attempt.createdAt,
      label: "Customer started paying",
      detail: `${attempt.amountIn} ${route}`,
      kind: "info",
    });
    const ended: Partial<Record<Attempt["status"], string>> = {
      underpaid: "Payment was short",
      paid: attempt.id === invoice.paidAttemptId ? "Payment received" : "Extra payment received",
      refunded: "Payment returned to your customer",
      failed: "Payment failed",
    };
    const label = ended[attempt.status];
    if (label) {
      const kind: TimelineKind =
        attempt.status === "paid" ? "success" : attempt.status === "failed" ? "danger" : "waiting";
      entries.push({ at: attempt.updatedAt, label, detail: route, kind });
    }
  }

  if (invoice.status === "expired") entries.push({ at: invoice.expiresAt, label: "Invoice expired", kind: "waiting" });
  if (invoice.status === "canceled")
    entries.push({ at: invoice.updatedAt, label: "Invoice canceled", kind: "waiting" });

  for (const refund of refunds) {
    const auto = refund.reason === "overpayment_auto";
    entries.push({
      at: refund.createdAt,
      label: auto ? "Refund queued for an extra payment" : "Refund requested",
      detail: `${refund.amount} ${invoice.asset.symbol}`,
      kind: "info",
    });
    if (refund.status === "awaiting_approval")
      entries.push({
        at: refund.updatedAt,
        label: "Waiting for your approval",
        ...(refund.error ? { detail: refund.error } : {}),
        kind: "waiting",
      });
    if (refund.status === "succeeded")
      entries.push({
        at: refund.updatedAt,
        label: "Refund completed",
        detail: `${refund.amount} ${invoice.asset.symbol}`,
        kind: "success",
      });
    if (refund.status === "failed")
      entries.push({
        at: refund.updatedAt,
        label: "Refund failed",
        ...(refund.error ? { detail: refund.error } : {}),
        kind: "danger",
      });
  }

  return entries.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
