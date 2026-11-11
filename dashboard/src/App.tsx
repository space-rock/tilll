import { useCallback, useEffect, useState } from "react";
import { ApiError, logout, request, restoreSession, setUnauthorizedHandler } from "./api.js";
import { CreateInvoiceDialog } from "./components/CreateInvoiceDialog.js";
import { Layout } from "./components/Layout.js";
import { Skeleton } from "./components/ui/skeleton.js";
import { ToastProvider, useToast } from "./components/ui/toast.js";
import { toCsv } from "./format.js";
import { useApi } from "./hooks.js";
import { InvoicePage, InvoicesPage } from "./pages/Invoices.js";
import { Login } from "./pages/Login.js";
import { OverviewPage } from "./pages/Overview.js";
import { RefundsPage } from "./pages/Refunds.js";
import { SettingsPage } from "./pages/Settings.js";
import { WebhooksPage } from "./pages/Webhooks.js";
import { navigate, useLocation } from "./router.js";
import type { Invoice, Settings } from "./types.js";

const MAX_EXPORT_PAGES = 20;

/** Every invoice, newest first, as a CSV download. */
async function exportInvoices(): Promise<number> {
  const rows: string[][] = [["id", "status", "amount", "asset", "refunded", "description", "created", "expires"]];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const body: { invoices: Invoice[]; nextCursor: string | null } = await request(
      "GET",
      `/v1/invoices?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const i of body.invoices) {
      rows.push([
        i.id,
        i.status,
        i.amount,
        i.asset.symbol,
        i.refundedAmount,
        i.description ?? "",
        i.createdAt,
        i.expiresAt,
      ]);
    }
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `tilll-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  return rows.length - 1;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const { path } = useLocation();
  const toast = useToast();
  const settings = useApi<Settings>("/v1/settings");
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const exportCsv = useCallback(async () => {
    try {
      const count = await exportInvoices();
      toast({ title: "Exported", description: `${count} invoice(s) saved as CSV.`, tone: "success" });
    } catch (e) {
      toast({ title: "Export failed", description: e instanceof ApiError ? e.message : String(e), tone: "danger" });
    }
  }, [toast]);

  const invoiceId = /^\/invoices\/([^/]+)$/.exec(path)?.[1];
  let page: React.ReactNode;
  if (path === "/") page = <OverviewPage key={refresh} />;
  else if (invoiceId) page = <InvoicePage key={`${invoiceId}-${refresh}`} id={invoiceId} />;
  else if (path === "/invoices") page = <InvoicesPage key={refresh} />;
  else if (path === "/refunds") page = <RefundsPage key={refresh} />;
  else if (path === "/webhooks") page = <WebhooksPage key={refresh} />;
  else if (path === "/settings") page = <SettingsPage settings={settings.data} error={settings.error?.message} />;
  else page = <p className="text-sm text-muted-foreground">There is no such page.</p>;

  return (
    <Layout
      settings={settings.data}
      onCreate={() => setCreating(true)}
      onExport={() => void exportCsv()}
      onLogout={onLogout}
    >
      {page}
      <CreateInvoiceDialog
        open={creating}
        symbol={settings.data?.asset.symbol ?? ""}
        onClose={() => setCreating(false)}
        onCreated={() => setRefresh((n) => n + 1)}
      />
    </Layout>
  );
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "out" | "in">("checking");

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth("out"));
    void restoreSession().then((live) => setAuth(live ? "in" : "out"));
    return () => setUnauthorizedHandler(undefined);
  }, []);

  const leave = async () => {
    await logout();
    setAuth("out");
    navigate("/");
  };

  return (
    <ToastProvider>
      {auth === "checking" && (
        <div className="p-8">
          <Skeleton className="h-8 w-48" />
        </div>
      )}
      {auth === "out" && <Login onLoggedIn={() => setAuth("in")} />}
      {auth === "in" && <Shell onLogout={() => void leave()} />}
    </ToastProvider>
  );
}
