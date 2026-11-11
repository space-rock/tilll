import { EmptyState, ErrorNote, StatusBadge, TxLinks } from "../components/Bits.js";
import { usePaged } from "../components/Paged.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/table.js";
import { formatDateTime, refundBadge } from "../format.js";
import { Link } from "../router.js";
import type { Refund } from "../types.js";

export function RefundsPage() {
  const list = usePaged<Refund>("/v1/refunds", "refunds");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Refunds</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {list.error && <ErrorNote message={list.error.message} />}
        {list.loading && list.items.length === 0 && <Skeleton className="h-40" />}
        {!list.loading && !list.error && list.items.length === 0 && (
          <EmptyState title="No refunds yet" hint="Open a paid invoice and press Refund." />
        )}
        {list.items.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Refund</TH>
                <TH>Invoice</TH>
                <TH>Amount</TH>
                <TH>Kind</TH>
                <TH>Status</TH>
                <TH>Transfer</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {list.items.map((refund) => (
                <TR key={refund.id}>
                  <TD>
                    <code className="font-mono text-xs">{refund.id}</code>
                  </TD>
                  <TD>
                    <Link
                      to={`/invoices/${refund.invoiceId}`}
                      className="font-mono text-xs text-foreground underline underline-offset-2 hover:text-muted-foreground"
                    >
                      {refund.invoiceId}
                    </Link>
                  </TD>
                  <TD className="whitespace-nowrap">{refund.amount}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">
                    {refund.reason === "overpayment_auto" ? "Automatic" : "Requested"}
                  </TD>
                  <TD>
                    <div className="flex flex-col gap-1">
                      <StatusBadge badge={refundBadge(refund.status)} />
                      {refund.error && <span className="max-w-64 text-xs text-danger">{refund.error}</span>}
                    </div>
                  </TD>
                  <TD>
                    <TxLinks links={refund.txLinks} />
                  </TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(refund.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
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
