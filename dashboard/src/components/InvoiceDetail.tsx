import { useState } from "react";
import { attemptBadge, formatDateTime, invoiceBadge, refundBadge } from "../format.js";
import { useApi } from "../hooks.js";
import { buildTimeline } from "../timeline.js";
import type { InvoiceDetail as Detail } from "../types.js";
import { EmptyState, ErrorNote, Mono, StatusBadge, TxLinks } from "./Bits.js";
import { RefundDialog } from "./RefundDialog.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-sm">{children}</dd>
  </div>
);

/** One invoice: amounts, timeline, every payment attempt, every refund, the raw quote, and the Refund button. */
export function InvoiceDetail({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const { data, error, loading, reload } = useApi<Detail>(`/v1/invoices/${id}`);
  const [refunding, setRefunding] = useState(false);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return null;

  const { invoice, attempts, refunds } = data;
  const inFlight = refunds
    .filter((r) => r.reason === "merchant_request" && (r.status === "pending" || r.status === "submitted"))
    .reduce((sum, r) => sum + BigInt(r.amountBase), 0n);
  const remaining = BigInt(invoice.amountBase) - BigInt(invoice.refundedAmountBase) - inFlight;
  const canRefund = invoice.status === "paid" && remaining > 0n;
  const changed = () => {
    reload();
    onChanged?.();
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-lg font-semibold">
            {invoice.amount} {invoice.asset.symbol} <StatusBadge badge={invoiceBadge(invoice)} />
          </p>
          <Mono text={invoice.id} short={false} />
          {invoice.description && <p className="text-sm text-muted-foreground">{invoice.description}</p>}
        </div>
        {canRefund && <Button onClick={() => setRefunding(true)}>Refund</Button>}
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Field label="Created">{formatDateTime(invoice.createdAt)}</Field>
        <Field label="Expires">{formatDateTime(invoice.expiresAt)}</Field>
        <Field label="Refunded so far">
          {invoice.refundedAmount} {invoice.asset.symbol}
        </Field>
        {invoice.metadata && (
          <Field label="Metadata">
            <code className="font-mono text-xs break-all">{JSON.stringify(invoice.metadata)}</code>
          </Field>
        )}
      </dl>

      <section aria-labelledby={`timeline-${id}`}>
        <h3 id={`timeline-${id}`} className="mb-2 text-sm font-semibold">
          Timeline
        </h3>
        <ol className="flex flex-col gap-2 border-l border-border pl-4">
          {buildTimeline(invoice, attempts, refunds).map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="text-sm">
              <p>{entry.label}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(entry.at)}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby={`attempts-${id}`}>
        <h3 id={`attempts-${id}`} className="mb-2 text-sm font-semibold">
          Payment attempts
        </h3>
        {attempts.length === 0 && (
          <EmptyState title="No payment attempts yet" hint="The customer has not chosen a token." />
        )}
        <div className="flex flex-col gap-3">
          {attempts.map((attempt) => (
            <div key={attempt.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {attempt.amountIn} {attempt.origin.symbol} on {attempt.origin.chain}
                </p>
                <StatusBadge badge={attemptBadge(attempt.status)} />
              </div>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Customer's refund address">
                  <Mono text={attempt.refundTo} />
                </Field>
                <Field label="Deposit address">
                  <Mono text={attempt.depositAddress} />
                </Field>
                <Field label="Transactions">
                  <TxLinks links={attempt.txLinks} />
                </Field>
                {attempt.raw && (
                  <Field label="1Click quote signature">
                    <StatusBadge
                      badge={
                        attempt.raw.quoteVerified
                          ? { label: "Verified", tone: "success" }
                          : { label: "Not verified", tone: "warning" }
                      }
                    />
                    {!attempt.raw.quoteVerified && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        The quote's signature did not check out against 1Click's public key. Expected on a mock or test
                        network; on the real 1Click, treat the quote with care.
                      </span>
                    )}
                  </Field>
                )}
              </dl>
              {attempt.raw && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">Raw quote and status</summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
                    {JSON.stringify(attempt.raw, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby={`refunds-${id}`}>
        <h3 id={`refunds-${id}`} className="mb-2 text-sm font-semibold">
          Refunds
        </h3>
        {refunds.length === 0 && <EmptyState title="No refunds" />}
        <div className="flex flex-col gap-3">
          {refunds.map((refund) => (
            <div key={refund.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {refund.amount} {invoice.asset.symbol}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {refund.reason === "overpayment_auto" ? "Automatic (extra payment)" : "Requested by you"}
                  </span>
                </p>
                <StatusBadge badge={refundBadge(refund.status)} />
              </div>
              {refund.error && <ErrorNote message={refund.error} />}
              {refund.status === "pending" && refund.nextTryAt && (
                <p className="text-xs text-muted-foreground">
                  Will try again at {formatDateTime(refund.nextTryAt)} (try {refund.tries}).
                </p>
              )}
              <TxLinks links={refund.txLinks} />
            </div>
          ))}
        </div>
      </section>

      <RefundDialog open={refunding} invoiceId={id} onClose={() => setRefunding(false)} onChanged={changed} />
    </div>
  );
}
