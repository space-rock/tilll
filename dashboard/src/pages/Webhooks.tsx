import { ChevronDown, Send, Webhook } from "lucide-react";
import { useState } from "react";
import { ApiError, request } from "../api.js";
import { EmptyState, ErrorNote } from "../components/Bits.js";
import { usePaged } from "../components/Paged.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Table, TBody, TD, TH, THead, TR } from "../components/ui/table.js";
import { useToast } from "../components/ui/toast.js";
import { deliveryBadge, formatDateTime, formatRelative } from "../format.js";
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
  const [testing, setTesting] = useState(false);
  const firstLoad = list.loading && list.items.length === 0;

  const report = (
    result: ResendResult | { delivered: boolean; status: number | null; error: string | null },
    id?: string,
  ) =>
    toast(
      result.delivered
        ? {
            title: "Delivered",
            description: `Your server accepted ${id ?? "the test event"} (HTTP ${result.status}).`,
            tone: "success",
          }
        : {
            title: "Not delivered",
            description: result.error ?? `Your server returned an error (HTTP ${result.status}).`,
            tone: "danger",
          },
    );

  const resend = async (id: string) => {
    setSending(id);
    try {
      report(await request<ResendResult>("POST", `/v1/webhooks/${id}/resend`), id);
      list.reload();
    } catch (e) {
      toast({
        title: "We couldn't resend it",
        description: e instanceof ApiError ? e.message : "Something went wrong. Try again.",
        tone: "danger",
      });
    } finally {
      setSending(undefined);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      report(await request<ResendResult>("POST", "/v1/webhooks/test"));
      list.reload();
    } catch (e) {
      toast({
        title: "We couldn't send the test event",
        description: e instanceof ApiError ? e.message : "Something went wrong. Try again.",
        tone: "danger",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Every event Tilll has sent to your server. A resent event keeps its ID and gets a new signature, so your server should ignore IDs it has already handled."
        actions={
          <Button variant="outline" size="sm" onClick={() => void sendTest()} loading={testing}>
            <Send aria-hidden="true" className="h-4 w-4" />
            Send test event
          </Button>
        }
      />
      <Card className="flex flex-col gap-2 py-2">
        {list.error && (
          <div className="px-5 py-3">
            <ErrorNote message={list.error.message} />
          </div>
        )}
        {firstLoad && <Skeleton className="m-5 h-40" />}
        {!list.loading && !list.error && list.items.length === 0 && (
          <EmptyState
            icon={Webhook}
            title="No webhook events yet"
            hint="Events appear here when an invoice is paid, expires or is refunded."
          />
        )}
        {list.items.length > 0 && (
          <Table>
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH className="text-right">Attempts</TH>
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
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5">
                        <ChevronDown
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                        />
                        <code className="font-mono text-xs">{delivery.type}</code>
                        <span className="font-mono text-xs text-muted-foreground">{delivery.id}</span>
                      </summary>
                      <pre className="mt-2 max-h-64 max-w-xl overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                        {JSON.stringify(delivery.payload, null, 2)}
                      </pre>
                    </details>
                  </TD>
                  <TD>
                    <Badge tone={deliveryBadge(delivery.state).tone}>{deliveryBadge(delivery.state).label}</Badge>
                  </TD>
                  <TD className="num text-right">{delivery.attempts}</TD>
                  <TD className="whitespace-nowrap text-muted-foreground" title={formatDateTime(delivery.createdAt)}>
                    {formatRelative(delivery.createdAt)}
                  </TD>
                  <TD className="max-w-56 text-xs text-danger">{delivery.lastError}</TD>
                  <TD>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void resend(delivery.id)}
                      loading={sending === delivery.id}
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
          <div className="flex justify-center py-3">
            <Button variant="outline" onClick={() => void list.more()} loading={list.loading}>
              {list.loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
