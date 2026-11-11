import { useState } from "react";
import { ApiError, request } from "../api.js";
import { EmptyState, ErrorNote } from "../components/Bits.js";
import { usePaged } from "../components/Paged.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/table.js";
import { useToast } from "../components/ui/toast.js";
import { deliveryBadge, formatDateTime } from "../format.js";
import type { Delivery } from "../types.js";

interface ResendResult {
  id: string;
  delivered: boolean;
  status: number | null;
  error: string | null;
}

export function WebhooksPage() {
  const list = usePaged<Delivery>("/v1/webhooks", "deliveries");
  const toast = useToast();
  const [sending, setSending] = useState<string | undefined>(undefined);

  const resend = async (id: string) => {
    setSending(id);
    try {
      const result = await request<ResendResult>("POST", `/v1/webhooks/${id}/resend`);
      toast(
        result.delivered
          ? { title: "Delivered", description: `${id} was accepted (HTTP ${result.status}).`, tone: "success" }
          : { title: "Not delivered", description: result.error ?? `HTTP ${result.status}`, tone: "danger" },
      );
      list.reload();
    } catch (e) {
      toast({ title: "Could not resend", description: e instanceof ApiError ? e.message : String(e), tone: "danger" });
    } finally {
      setSending(undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook deliveries</CardTitle>
        <CardDescription>
          Resending sends the same event again, with a fresh signature. Your server should ignore an event id it has
          already handled.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {list.error && <ErrorNote message={list.error.message} />}
        {list.loading && list.items.length === 0 && <Skeleton className="h-40" />}
        {!list.loading && !list.error && list.items.length === 0 && (
          <EmptyState title="Nothing sent yet" hint="Events appear here once an invoice changes." />
        )}
        {list.items.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH>Tries</TH>
                <TH>When</TH>
                <TH>Last error</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {list.items.map((delivery) => (
                <TR key={delivery.id}>
                  <TD>
                    <details>
                      <summary className="cursor-pointer">
                        <code className="font-mono text-xs">{delivery.type}</code>{" "}
                        <span className="font-mono text-xs text-muted-foreground">{delivery.id}</span>
                      </summary>
                      <pre className="mt-2 max-h-64 max-w-xl overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
                        {JSON.stringify(delivery.payload, null, 2)}
                      </pre>
                    </details>
                  </TD>
                  <TD>
                    <Badge tone={deliveryBadge(delivery.state).tone}>{deliveryBadge(delivery.state).label}</Badge>
                  </TD>
                  <TD>{delivery.attempts}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(delivery.createdAt)}</TD>
                  <TD className="max-w-56 text-xs text-danger">{delivery.lastError}</TD>
                  <TD>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void resend(delivery.id)}
                      disabled={sending === delivery.id}
                      aria-label={`Resend ${delivery.id}`}
                    >
                      {sending === delivery.id ? "Sending…" : "Resend"}
                    </Button>
                  </TD>
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
