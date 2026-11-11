import type { Attempt, Invoice, Refund } from "./types.js";

export interface TimelineEntry {
  at: string;
  label: string;
  detail?: string;
}

/** What happened to an invoice, oldest first, assembled from the timestamps the API gives. */
export function buildTimeline(invoice: Invoice, attempts: Attempt[], refunds: Refund[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ at: invoice.createdAt, label: "Invoice created" }];

  for (const attempt of attempts) {
    const route = `${attempt.origin.symbol} on ${attempt.origin.chain}`;
    entries.push({ at: attempt.createdAt, label: "Payment started", detail: `${attempt.amountIn} ${route}` });
    const ended: Partial<Record<Attempt["status"], string>> = {
      underpaid: "Payment came in short",
      paid:
        attempt.id === invoice.paidAttemptId ? "Payment received" : "Extra payment received (refunded automatically)",
      refunded: "Payment returned to the payer by 1Click",
      failed: "Payment failed",
    };
    const label = ended[attempt.status];
    if (label) entries.push({ at: attempt.updatedAt, label, detail: route });
  }

  if (invoice.status === "expired") entries.push({ at: invoice.expiresAt, label: "Invoice expired" });
  if (invoice.status === "canceled") entries.push({ at: invoice.updatedAt, label: "Invoice canceled" });

  for (const refund of refunds) {
    const auto = refund.reason === "overpayment_auto";
    entries.push({
      at: refund.createdAt,
      label: auto ? "Automatic refund started" : "Refund requested",
      detail: `${refund.amount} ${invoice.asset.symbol}`,
    });
    if (refund.status === "succeeded")
      entries.push({
        at: refund.updatedAt,
        label: "Refund arrived",
        detail: `${refund.amount} ${invoice.asset.symbol}`,
      });
    if (refund.status === "failed")
      entries.push({ at: refund.updatedAt, label: "Refund failed", detail: refund.error ?? undefined });
  }

  return entries.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
