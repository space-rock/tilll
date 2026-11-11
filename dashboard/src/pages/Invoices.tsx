import { useState } from "react";
import { ErrorNote } from "../components/Bits.js";
import { InvoiceDetail } from "../components/InvoiceDetail.js";
import { InvoiceTable } from "../components/InvoiceTable.js";
import { usePaged } from "../components/Paged.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { ToggleGroup } from "../components/ui/toggle-group.js";
import { Link, navigate, useLocation } from "../router.js";
import type { Invoice, InvoiceStatus } from "../types.js";

type Filter = "all" | InvoiceStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "paid", label: "Paid" },
  { value: "expired", label: "Expired" },
  { value: "canceled", label: "Canceled" },
];

export function InvoicesPage() {
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const [filter, setFilter] = useState<Filter>("all");
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (q) params.set("q", q);
  const list = usePaged<Invoice>(`/v1/invoices${params.size ? `?${params}` : ""}`, "invoices");

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{q ? `Invoices matching "${q}"` : "Invoices"}</CardTitle>
        <div className="flex items-center gap-2">
          {q && (
            <Button variant="ghost" size="sm" onClick={() => navigate("/invoices")}>
              Clear search
            </Button>
          )}
          <ToggleGroup label="Filter by status" value={filter} options={FILTERS} onChange={setFilter} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {list.error && <ErrorNote message={list.error.message} />}
        {list.loading && list.items.length === 0 && <Skeleton className="h-40" />}
        {!(list.loading && list.items.length === 0) && (
          <InvoiceTable
            invoices={list.items}
            onSelect={(id) => navigate(`/invoices/${id}`)}
            emptyHint={q ? "Nothing matches that search." : 'Use "Create invoice" to make a test invoice.'}
          />
        )}
        {list.hasMore && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void list.more()} disabled={list.loading}>
              {list.loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function InvoicePage({ id }: { id: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Link to="/invoices" className="text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground">
        ← All invoices
      </Link>
      <Card>
        <CardContent className="pt-4">
          <InvoiceDetail key={id} id={id} />
        </CardContent>
      </Card>
    </div>
  );
}
