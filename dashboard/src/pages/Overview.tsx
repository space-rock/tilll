import { useState } from "react";
import { Badge } from "../components/ui/badge.js";
import { EmptyState, ErrorNote } from "../components/Bits.js";
import { InvoiceDetail } from "../components/InvoiceDetail.js";
import { InvoiceTable } from "../components/InvoiceTable.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Dialog } from "../components/ui/dialog.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/table.js";
import { ToggleGroup } from "../components/ui/toggle-group.js";
import { deliveryBadge, formatDateTime, percent } from "../format.js";
import { useApi, useMediaQuery } from "../hooks.js";
import { Link } from "../router.js";
import type { Delivery, Invoice, InvoiceStatus, Overview as OverviewData } from "../types.js";

type Filter = "all" | InvoiceStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "paid", label: "Paid" },
  { value: "expired", label: "Expired" },
];

function Stat({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-2xl font-semibold tracking-tight">{children}</p>
        {footer}
      </CardContent>
    </Card>
  );
}

function Stats() {
  const { data, error, loading } = useApi<OverviewData>("/v1/overview", { refreshMs: 15_000 });
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }
  if (error || !data) return <ErrorNote message={error?.message ?? "Could not load the overview."} />;
  const used = percent(data.refundedToday.amountBase, data.limits.maxPerDayBase);
  const symbol = data.asset.symbol;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        title="Settlement balance"
        footer={data.balanceError && <p className="text-xs text-danger">{data.balanceError}</p>}
      >
        {data.balance ? `${data.balance.value} ${symbol}` : "Unavailable"}
      </Stat>
      <Stat
        title="Paid today"
        footer={<p className="text-xs text-muted-foreground">{data.paidToday.count} invoice(s)</p>}
      >
        {data.paidToday.amount} {symbol}
      </Stat>
      <Stat
        title="Refunded today"
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
              <div className="h-full bg-brand" style={{ width: `${used}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              of {data.limits.maxPerDay} {symbol} daily limit
            </p>
          </>
        }
      >
        {data.refundedToday.amount} {symbol}
      </Stat>
      <Stat title="Open invoices">{data.openInvoices}</Stat>
    </div>
  );
}

function RecentWebhooks() {
  const { data, error, loading } = useApi<{ deliveries: Delivery[] }>("/v1/webhooks?limit=6", { refreshMs: 15_000 });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Webhook deliveries</CardTitle>
        <Link
          to="/webhooks"
          className="text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground"
        >
          All deliveries
        </Link>
      </CardHeader>
      <CardContent>
        {loading && <Skeleton className="h-24" />}
        {error && <ErrorNote message={error.message} />}
        {data && data.deliveries.length === 0 && (
          <EmptyState title="Nothing sent yet" hint="Events appear here once an invoice changes." />
        )}
        {data && data.deliveries.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {data.deliveries.map((delivery) => (
                <TR key={delivery.id}>
                  <TD>
                    <code className="font-mono text-xs">{delivery.type}</code>
                  </TD>
                  <TD>
                    <Badge tone={deliveryBadge(delivery.state).tone}>{deliveryBadge(delivery.state).label}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(delivery.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const wide = useMediaQuery("(min-width: 1024px)");
  const { data, error, loading, reload } = useApi<{ invoices: Invoice[] }>(
    `/v1/invoices?limit=8${filter === "all" ? "" : `&status=${filter}`}`,
    { refreshMs: 15_000 },
  );

  return (
    <>
      <Stats />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Recent invoices</CardTitle>
            <ToggleGroup label="Filter by status" value={filter} options={FILTERS} onChange={setFilter} />
          </CardHeader>
          <CardContent>
            {loading && <Skeleton className="h-40" />}
            {error && <ErrorNote message={error.message} />}
            {data && (
              <InvoiceTable
                invoices={data.invoices}
                selectedId={selected}
                onSelect={setSelected}
                emptyHint={filter === "all" ? 'Use "Create invoice" to make a test invoice.' : "Try another filter."}
              />
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Invoice</CardTitle>
          </CardHeader>
          <CardContent>
            {wide && selected ? (
              <InvoiceDetail key={selected} id={selected} onChanged={reload} />
            ) : (
              <EmptyState title="Select an invoice" hint="Its payments, refunds and timeline show here." />
            )}
          </CardContent>
        </Card>
      </div>
      <RecentWebhooks />
      {!wide && (
        <Dialog open={selected !== undefined} onClose={() => setSelected(undefined)} title="Invoice" side="right">
          {selected && <InvoiceDetail key={selected} id={selected} onChanged={reload} />}
        </Dialog>
      )}
    </>
  );
}
