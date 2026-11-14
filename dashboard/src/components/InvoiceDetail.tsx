import {
  CheckCircle2,
  CircleDot,
  Clock,
  ExternalLink,
  Info,
  Link2,
  Undo2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../cn.js";
import { attemptBadge, chainName, formatDateTime, formatUnits, invoiceBadge, refundBadge } from "../format.js";
import { useApi } from "../hooks.js";
import { useSettings } from "../settings.js";
import { buildTimeline, type TimelineKind } from "../timeline.js";
import type { InvoiceDetail as Detail } from "../types.js";
import { CopyButton, EmptyState, ErrorNote, Mono, StatusBadge, TxLinks } from "./Bits.js";
import { RefundActions } from "./RefundActions.js";
import { RefundDialog } from "./RefundDialog.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { PageHeader } from "./ui/page-header.js";
import { Skeleton } from "./ui/skeleton.js";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-sm">{children}</dd>
  </div>
);

const KIND_ICON: Record<TimelineKind, { icon: LucideIcon; tone: string }> = {
  info: { icon: CircleDot, tone: "text-muted-foreground" },
  success: { icon: CheckCircle2, tone: "text-success" },
  waiting: { icon: Clock, tone: "text-warning" },
  danger: { icon: XCircle, tone: "text-danger" },
};

/** One invoice, as a page: amounts and status, what happened, every payment attempt, every refund, and the Refund button. */
export function InvoiceDetail({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const { data, error, loading, reload } = useApi<Detail>(`/v1/invoices/${id}`);
  const settings = useSettings();
  const [refunding, setRefunding] = useState(false);

  if (loading)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-16 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (error) return <ErrorNote message={error.message} />;
  if (!data) return null;

  const { invoice, attempts, refunds } = data;
  const inFlight = refunds
    .filter(
      (r) =>
        r.reason === "merchant_request" &&
        (r.status === "awaiting_approval" || r.status === "pending" || r.status === "submitted"),
    )
    .reduce((sum, r) => sum + BigInt(r.amountBase), 0n);
  const remaining = BigInt(invoice.amountBase) - BigInt(invoice.refundedAmountBase) - inFlight;
  // An invoice paid to an earlier settlement account or asset is not in the balance a refund is paid from.
  const refundableHere = data.refundableHere !== false;
  const canRefund = invoice.status === "paid" && remaining > 0n && refundableHere;
  const payUrl = settings ? `${settings.publicBaseUrl}/pay/${invoice.id}` : undefined;
  const changed = () => {
    reload();
    onChanged?.();
  };
  const symbol = invoice.asset.symbol;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Invoices", to: "/invoices" }, { label: invoice.id }]}
        title={
          <span className="num">
            {invoice.amount} {symbol}
          </span>
        }
        badge={<StatusBadge badge={invoiceBadge(invoice)} />}
        description={invoice.description ?? undefined}
        actions={
          <>
            {payUrl && (
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(payUrl)}>
                <Link2 aria-hidden="true" className="h-4 w-4" />
                Copy payment link
              </Button>
            )}
            {canRefund && (
              <Button size="sm" onClick={() => setRefunding(true)}>
                <Undo2 aria-hidden="true" className="h-4 w-4" />
                Refund
              </Button>
            )}
          </>
        }
      />

      {!refundableHere && invoice.status === "paid" && (
        <div
          role="note"
          className="flex items-start gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            This invoice was paid to <Mono text={invoice.settlementAccount ?? "an earlier account"} copy={false} /> in{" "}
            {symbol}, before you changed your settlement account or asset, so Tilll can&apos;t refund it from here. Send
            the refund from that account&apos;s wallet.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle id={`timeline-${id}`}>Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ol aria-labelledby={`timeline-${id}`} className="flex flex-col">
                {buildTimeline(invoice, attempts, refunds).map((entry, index, all) => {
                  const { icon: Icon, tone } = KIND_ICON[entry.kind];
                  return (
                    <li key={`${entry.at}-${index}`} className="relative flex gap-3 pb-4 last:pb-0">
                      {index < all.length - 1 && (
                        <span aria-hidden="true" className="absolute top-6 bottom-0 left-2.5 w-px bg-border" />
                      )}
                      <Icon aria-hidden="true" className={cn("relative z-10 mt-0.5 h-5 w-5 shrink-0 bg-card", tone)} />
                      <div className="flex flex-col gap-0.5">
                        <p className="text-sm">{entry.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(entry.at)}
                          {entry.detail ? ` · ${entry.detail}` : ""}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle id={`attempts-${id}`}>Payments</CardTitle>
            </CardHeader>
            <CardContent aria-labelledby={`attempts-${id}`} className="flex flex-col gap-3">
              {attempts.length === 0 && (
                <EmptyState title="No payments yet" hint="Your customer hasn't chosen a token yet." />
              )}
              {attempts.map((attempt) => (
                <div key={attempt.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="num text-sm font-medium">
                      {attempt.amountIn} {attempt.origin.symbol} on {chainName(attempt.origin.chain)}
                    </p>
                    <StatusBadge badge={attemptBadge(attempt.status)} />
                  </div>
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Customer's refund address">
                      <Mono text={attempt.refundTo} />
                    </Field>
                    <Field label="Payment address">
                      <Mono text={attempt.depositAddress} />
                    </Field>
                    <Field label="Transactions">
                      <TxLinks links={attempt.txLinks} />
                    </Field>
                    {attempt.raw && (
                      <Field label="NEAR Intents signature">
                        <StatusBadge
                          badge={
                            attempt.raw.quoteVerified
                              ? { label: "Verified", tone: "success" }
                              : { label: "Not verified", tone: "warning" }
                          }
                        />
                        {!attempt.raw.quoteVerified && (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            We couldn't verify this payment's signature from NEAR Intents. That's expected on a test
                            network. On mainnet, check the payment carefully.
                          </span>
                        )}
                      </Field>
                    )}
                  </dl>
                  {attempt.raw && (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Technical details
                      </summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                        {JSON.stringify(attempt.raw, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle id={`refunds-${id}`}>Refunds</CardTitle>
            </CardHeader>
            <CardContent aria-labelledby={`refunds-${id}`} className="flex flex-col gap-3">
              {refunds.length === 0 && (
                <EmptyState
                  icon={Undo2}
                  title="No refunds"
                  hint={
                    canRefund
                      ? "Use Refund to pay some or all of this invoice back to the customer."
                      : "Refunds for this invoice appear here."
                  }
                />
              )}
              {refunds.map((refund) => (
                <div key={refund.id} className="flex flex-col gap-3 rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      <span className="num">
                        {refund.amount} {symbol}
                      </span>
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {refund.reason === "overpayment_auto" ? "Extra payment" : "Requested by you"}
                      </span>
                    </p>
                    <StatusBadge badge={refundBadge(refund.status)} />
                  </div>
                  {refund.error && <ErrorNote message={refund.error} />}
                  <TxLinks links={refund.txLinks} />
                  <RefundActions refund={refund} onChanged={changed} />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-4">
              <Field label="Invoice ID">
                <Mono text={invoice.id} short={false} />
              </Field>
              <Field label="Created">{formatDateTime(invoice.createdAt)}</Field>
              <Field label="Expires">{formatDateTime(invoice.expiresAt)}</Field>
              <Field label="Refunded so far">
                <span className="num">
                  {invoice.refundedAmount} {symbol}
                </span>
              </Field>
              {invoice.status === "paid" && (
                <Field label="Left to refund">
                  <span className="num">
                    {remaining > 0n ? `${formatUnits(remaining, invoice.asset.decimals)} ${symbol}` : "Nothing"}
                  </span>
                </Field>
              )}
              {payUrl && (
                <Field label="Payment link">
                  <span className="flex items-center gap-1">
                    <a
                      href={payUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm underline underline-offset-2 hover:text-muted-foreground"
                    >
                      Open payment link
                      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                    </a>
                    <CopyButton text={payUrl} label="Copy payment link" />
                  </span>
                </Field>
              )}
              {invoice.metadata && (
                <Field label="Metadata">
                  <code className="font-mono text-xs break-all">{JSON.stringify(invoice.metadata)}</code>
                </Field>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>

      <RefundDialog open={refunding} invoiceId={id} onClose={() => setRefunding(false)} onChanged={changed} />
    </>
  );
}
