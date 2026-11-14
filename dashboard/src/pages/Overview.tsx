import { AlertTriangle, ArrowRight, CheckCircle2, Clock, FileText, Undo2, Wallet, Webhook } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorNote } from "../components/Bits.js";
import { InvoiceTable } from "../components/InvoiceTable.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { StatCard } from "../components/ui/stat-card.js";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/table.js";
import { Tabs } from "../components/ui/tabs.js";
import { deliveryBadge, formatDateTime, formatRelative, percent } from "../format.js";
import { useApi } from "../hooks.js";
import { Link, navigate } from "../router.js";
import type { Delivery, Invoice, InvoiceStatus, Overview as OverviewData } from "../types.js";
import { useWallet } from "../wallet.js";

type Filter = "all" | InvoiceStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "paid", label: "Paid" },
  { value: "expired", label: "Expired" },
];

/** What needs the merchant, if anything. It is not shown at all when there is nothing. */
function NeedsAttention({ data, failedDeliveries }: { data: OverviewData | undefined; failedDeliveries: number }) {
  const wallet = useWallet();
  const waiting = data?.refundsAwaitingApproval ?? 0;
  const items: { key: string; text: string; to: string; action: string }[] = [];
  if (waiting > 0) {
    items.push({
      key: "approve",
      text: `${waiting} ${waiting === 1 ? "refund is" : "refunds are"} waiting for your approval.${
        wallet.status === "connected" && wallet.matches ? "" : " Connect your wallet to approve."
      }`,
      to: "/refunds",
      action: "Review",
    });
  }
  if (failedDeliveries > 0) {
    items.push({
      key: "webhooks",
      text: `${failedDeliveries} webhook ${failedDeliveries === 1 ? "delivery" : "deliveries"} failed. Check that your server accepts them.`,
      to: "/webhooks",
      action: "Review",
    });
  }
  if (data?.balanceError) {
    items.push({
      key: "balance",
      text: `We couldn't read the balance. ${data.balanceError}`,
      to: "/settings",
      action: "Settings",
    });
  }
  if (items.length === 0) return null;
  return (
    <Card className="border-warning/40 bg-warning-bg">
      <CardContent className="flex flex-col gap-3 pt-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-warning">
          <AlertTriangle aria-hidden="true" className="h-4 w-4" />
          Needs your attention
        </p>
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{item.text}</span>
              <Button variant="outline" size="sm" onClick={() => navigate(item.to)}>
                {item.action}
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Stats({
  data,
  error,
  loading,
}: {
  data: OverviewData | undefined;
  error: string | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    );
  }
  if (error || !data)
    return <ErrorNote message={error ?? "We couldn't load the overview. Reload the page to try again."} />;
  const used = percent(data.refundedToday.amountBase, data.limits.maxPerDayBase);
  const symbol = data.asset.symbol;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={Wallet}
        label="Settlement balance"
        footer={data.balanceError && <p className="text-danger">{data.balanceError}</p>}
      >
        {data.balance ? `${data.balance.value} ${symbol}` : "Unavailable"}
      </StatCard>
      <StatCard
        icon={CheckCircle2}
        label="Paid today"
        footer={
          <p>
            {data.paidToday.count} {data.paidToday.count === 1 ? "invoice" : "invoices"}
          </p>
        }
      >
        {data.paidToday.amount} {symbol}
      </StatCard>
      <StatCard
        icon={Undo2}
        label="Refunded today"
        footer={
          <>
            <div
              role="progressbar"
              aria-label="Refunded today against the daily limit"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(used)}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${used}%` }} />
            </div>
            <p>
              of {data.limits.maxPerDay} {symbol} daily limit
            </p>
          </>
        }
      >
        {data.refundedToday.amount} {symbol}
      </StatCard>
      <StatCard icon={Clock} label="Open invoices" footer={<p>Waiting to be paid</p>}>
        {data.openInvoices}
      </StatCard>
    </div>
  );
}

function RecentWebhooks({
  deliveries,
  error,
  loading,
}: {
  deliveries: Delivery[] | undefined;
  error: string | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recent webhook events</CardTitle>
        <Link to="/webhooks" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="px-0">
        {loading && <Skeleton className="mx-5 h-24" />}
        {error && (
          <div className="px-5">
            <ErrorNote message={error} />
          </div>
        )}
        {deliveries && deliveries.length === 0 && (
          <EmptyState
            icon={Webhook}
            title="No webhook events yet"
            hint="Events appear here when an invoice is paid, expires or is refunded."
          />
        )}
        {deliveries && deliveries.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {deliveries.map((delivery) => (
                <TR key={delivery.id}>
                  <TD>
                    <code className="font-mono text-xs">{delivery.type}</code>
                  </TD>
                  <TD>
                    <Badge tone={deliveryBadge(delivery.state).tone}>{deliveryBadge(delivery.state).label}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground" title={formatDateTime(delivery.createdAt)}>
                    {formatRelative(delivery.createdAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage({ onCreate }: { onCreate?: () => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const overview = useApi<OverviewData>("/v1/overview", { refreshMs: 15_000 });
  const webhooks = useApi<{ deliveries: Delivery[] }>("/v1/webhooks?limit=6", { refreshMs: 15_000 });
  const invoices = useApi<{ invoices: Invoice[] }>(
    `/v1/invoices?limit=8${filter === "all" ? "" : `&status=${filter}`}`,
    { refreshMs: 15_000 },
  );
  const failed = webhooks.data?.deliveries.filter((d) => d.state === "failed").length ?? 0;

  return (
    <>
      <PageHeader title="Overview" description="Your balance, today's payments and what needs your attention." />
      <NeedsAttention data={overview.data} failedDeliveries={failed} />
      <Stats data={overview.data} error={overview.error?.message} loading={overview.loading} />
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Recent invoices</CardTitle>
          <Link to="/invoices" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
            View all
          </Link>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-0">
          <div className="px-5">
            <Tabs label="Filter by status" value={filter} options={FILTERS} onChange={setFilter} />
          </div>
          {invoices.loading && <Skeleton className="mx-5 h-40" />}
          {invoices.error && (
            <div className="px-5">
              <ErrorNote message={invoices.error.message} />
            </div>
          )}
          {invoices.data && (
            <InvoiceTable
              invoices={invoices.data.invoices}
              onSelect={(id) => navigate(`/invoices/${id}`)}
              emptyTitle={filter === "all" ? "No invoices yet" : "No invoices match"}
              emptyHint={
                filter === "all"
                  ? "Create a test invoice to see the checkout and watch a payment arrive."
                  : "Try another filter."
              }
              emptyAction={
                filter === "all" && onCreate ? (
                  <Button size="sm" onClick={onCreate}>
                    <FileText aria-hidden="true" className="h-4 w-4" />
                    Create invoice
                  </Button>
                ) : undefined
              }
            />
          )}
        </CardContent>
      </Card>
      <RecentWebhooks
        deliveries={webhooks.data?.deliveries}
        error={webhooks.error?.message}
        loading={webhooks.loading}
      />
    </>
  );
}
