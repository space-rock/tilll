import { formatDateTime, invoiceBadge } from "../format.js";
import type { Invoice } from "../types.js";
import { EmptyState, StatusBadge } from "./Bits.js";
import { Table, TBody, TD, TH, THead, TR } from "./ui/table.js";

/** Invoices as rows; choosing one calls `onSelect`. */
export function InvoiceTable({
  invoices,
  selectedId,
  onSelect,
  emptyHint,
}: {
  invoices: Invoice[];
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
  emptyHint: string;
}) {
  if (invoices.length === 0) return <EmptyState title="No invoices here" hint={emptyHint} />;
  return (
    <Table>
      <THead>
        <TR>
          <TH>Invoice</TH>
          <TH>Amount</TH>
          <TH>Status</TH>
          <TH>Created</TH>
        </TR>
      </THead>
      <TBody>
        {invoices.map((invoice) => (
          <TR key={invoice.id} className={invoice.id === selectedId ? "bg-muted" : "hover:bg-muted/60"}>
            <TD>
              <button
                type="button"
                onClick={() => onSelect(invoice.id)}
                aria-label={`Open invoice ${invoice.id}`}
                className="flex cursor-pointer flex-col text-left"
              >
                <code className="font-mono text-xs">{invoice.id}</code>
                {invoice.description && <span className="text-xs text-muted-foreground">{invoice.description}</span>}
              </button>
            </TD>
            <TD className="whitespace-nowrap">
              {invoice.amount} {invoice.asset.symbol}
            </TD>
            <TD>
              <StatusBadge badge={invoiceBadge(invoice)} />
            </TD>
            <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(invoice.createdAt)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
