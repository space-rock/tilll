import { Download, FileText, Plus } from "lucide-react";
import { useState } from "react";
import { ErrorNote } from "../components/Bits.js";
import { InvoiceDetail } from "../components/InvoiceDetail.js";
import { InvoiceTable } from "../components/InvoiceTable.js";
import { usePaged } from "../components/Paged.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Tabs } from "../components/ui/tabs.js";
import { navigate, useLocation } from "../router.js";
import type { Invoice, InvoiceStatus } from "../types.js";

type Filter = "all" | InvoiceStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "paid", label: "Paid" },
  { value: "expired", label: "Expired" },
  { value: "canceled", label: "Canceled" },
];

export function InvoicesPage({ onCreate, onExport }: { onCreate?: () => void; onExport?: () => void }) {
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const [filter, setFilter] = useState<Filter>("all");
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (q) params.set("q", q);
  const list = usePaged<Invoice>(`/v1/invoices${params.size ? `?${params}` : ""}`, "invoices");
  const firstLoad = list.loading && list.items.length === 0;

  return (
    <>
      <PageHeader
        title={q ? `Invoices matching "${q}"` : "Invoices"}
        description="Every invoice your server has created, newest first."
        actions={
          <>
            {q && (
              <Button variant="ghost" size="sm" onClick={() => navigate("/invoices")}>
                Clear search
              </Button>
            )}
            {onExport && (
              <Button variant="outline" size="sm" onClick={onExport}>
                <Download aria-hidden="true" className="h-4 w-4" />
                Export CSV
              </Button>
            )}
            {onCreate && (
              <Button size="sm" onClick={onCreate}>
                <Plus aria-hidden="true" className="h-4 w-4" />
                Create invoice
              </Button>
            )}
          </>
        }
      />
      <Card className="flex flex-col gap-2 pt-2">
        <div className="px-5">
          <Tabs label="Filter by status" value={filter} options={FILTERS} onChange={setFilter} />
        </div>
        {list.error && (
          <div className="px-5 pb-3">
            <ErrorNote message={list.error.message} />
          </div>
        )}
        {firstLoad && <Skeleton className="m-5 h-40" />}
        {!firstLoad && (
          <InvoiceTable
            invoices={list.items}
            onSelect={(id) => navigate(`/invoices/${id}`)}
            emptyTitle={q ? "No invoices match" : "No invoices yet"}
            emptyHint={
              q
                ? "Nothing matches that search. Try an invoice id, a description or a metadata value."
                : "Create a test invoice to see the checkout and watch a payment arrive."
            }
            emptyAction={
              !q && onCreate ? (
                <Button size="sm" onClick={onCreate}>
                  <FileText aria-hidden="true" className="h-4 w-4" />
                  Create invoice
                </Button>
              ) : undefined
            }
          />
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

export function InvoicePage({ id }: { id: string }) {
  return <InvoiceDetail key={id} id={id} />;
}
