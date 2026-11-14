import { FileText } from "lucide-react";
import { formatDateTime, formatRelative, invoiceBadge } from "../format.js";
import type { Invoice } from "../types.js";
import { EmptyState, StatusBadge } from "./Bits.js";
import { Table, TBody, TD, TH, THead, TR } from "./ui/table.js";

/** Invoices as rows; choosing a row (or its id) calls `onSelect`. */
export function InvoiceTable({
  invoices,
  onSelect,
  emptyTitle = "No invoices yet",
  emptyHint,
  emptyAction,
}: {
  invoices: Invoice[];
  onSelect: (id: string) => void;
  emptyTitle?: string;
  emptyHint: string;
  emptyAction?: React.ReactNode;
}) {
  if (invoices.length === 0)
    return <EmptyState icon={FileText} title={emptyTitle} hint={emptyHint} action={emptyAction} />;
  return (
    <Table>
      <THead>
        <TR>
          <TH>Invoice</TH>
          <TH className="text-right">Amount</TH>
          <TH>Status</TH>
          <TH>Created</TH>
        </TR>
      </THead>
      <TBody>
        {invoices.map((invoice) => (
          <TR key={invoice.id} className="cursor-pointer hover:bg-muted/60" onClick={() => onSelect(invoice.id)}>
            <TD>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(invoice.id);
                }}
                aria-label={`Open invoice ${invoice.id}`}
                className="flex cursor-pointer flex-col gap-0.5 text-left"
              >
                <code className="font-mono text-xs">{invoice.id}</code>
                {invoice.description && <span className="text-xs text-muted-foreground">{invoice.description}</span>}
              </button>
            </TD>
            <TD className="num text-right font-medium whitespace-nowrap">
              {invoice.amount} {invoice.asset.symbol}
            </TD>
            <TD>
              <StatusBadge badge={invoiceBadge(invoice)} />
            </TD>
            <TD className="whitespace-nowrap text-muted-foreground" title={formatDateTime(invoice.createdAt)}>
              {formatRelative(invoice.createdAt)}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
