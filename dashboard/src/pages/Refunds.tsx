import { Undo2 } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorNote, StatusBadge, TxLinks } from "../components/Bits.js";
import { usePaged } from "../components/Paged.js";
import { RefundActions } from "../components/RefundActions.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/table.js";
import { Tabs } from "../components/ui/tabs.js";
import { formatDateTime, formatRelative, refundBadge } from "../format.js";
import { useApi } from "../hooks.js";
import { Link } from "../router.js";
import type { Refund, RefundCounts, RefundStatus } from "../types.js";

type Filter = "all" | "awaiting_approval" | "in_progress" | "succeeded" | "failed";

/** What each tab asks the server for. In progress is two statuses, so it asks for everything and narrows here. */
const STATUS_OF: Record<Filter, RefundStatus | undefined> = {
  all: undefined,
  awaiting_approval: "awaiting_approval",
  in_progress: undefined,
  succeeded: "succeeded",
  failed: "failed",
};

export function RefundsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const status = STATUS_OF[filter];
  const list = usePaged<Refund>(`/v1/refunds${status ? `?status=${status}` : ""}`, "refunds");
  const counts = useApi<{ counts: RefundCounts }>("/v1/refunds?limit=1");
  const c = counts.data?.counts;
  const items =
    filter === "in_progress"
      ? list.items.filter((r) => r.status === "pending" || r.status === "submitted")
      : list.items;
  const firstLoad = list.loading && list.items.length === 0;
  const changed = () => {
    list.reload();
    counts.reload();
  };

  return (
    <>
      <PageHeader
        title="Refunds"
        description="Refunds are approved with your wallet. Nothing is sent until you approve it."
      />
      <Card className="flex flex-col gap-2 pt-2">
        <div className="px-5">
          <Tabs
            label="Filter by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "awaiting_approval", label: "Waiting for approval", count: c?.awaiting_approval },
              { value: "in_progress", label: "Processing", count: c ? c.pending + c.submitted : undefined },
              { value: "succeeded", label: "Refunded" },
              { value: "failed", label: "Failed" },
            ]}
          />
        </div>
        {list.error && (
          <div className="px-5 pb-3">
            <ErrorNote message={list.error.message} />
          </div>
        )}
        {firstLoad && <Skeleton className="m-5 h-40" />}
        {!firstLoad && !list.error && items.length === 0 && (
          <EmptyState
            icon={Undo2}
            title={filter === "all" ? "No refunds yet" : "No refunds here"}
            hint={
              filter === "all"
                ? "Open a paid invoice and use Refund. Extra payments on an invoice that is already paid also appear here."
                : "Nothing matches this filter."
            }
          />
        )}
        {items.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Refund</TH>
                <TH>Invoice</TH>
                <TH className="text-right">Amount</TH>
                <TH>Reason</TH>
                <TH>Status</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((refund) => (
                <TR key={refund.id}>
                  <TD>
                    <code className="font-mono text-xs">{refund.id}</code>
                  </TD>
                  <TD>
                    <Link
                      to={`/invoices/${refund.invoiceId}`}
                      className="font-mono text-xs underline underline-offset-2 hover:text-muted-foreground"
                    >
                      {refund.invoiceId}
                    </Link>
                  </TD>
                  <TD className="num text-right font-medium whitespace-nowrap">{refund.amount}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    {refund.reason === "overpayment_auto" ? "Extra payment" : "Requested by you"}
                  </TD>
                  <TD>
                    <div className="flex flex-col items-start gap-2">
                      <StatusBadge badge={refundBadge(refund.status)} />
                      {refund.error && <span className="max-w-64 text-xs text-danger">{refund.error}</span>}
                      {refund.txLinks.length > 0 && <TxLinks links={refund.txLinks} />}
                      <RefundActions refund={refund} onChanged={changed} />
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground" title={formatDateTime(refund.createdAt)}>
                    {formatRelative(refund.createdAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {list.hasMore && (
          <div className="flex justify-center pb-5">
            <Button variant="outline" onClick={() => void list.more()} loading={list.loading}>
              {list.loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
