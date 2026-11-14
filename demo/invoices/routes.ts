import { join } from "node:path";
import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { ApiError } from "../../src/errors.js";
import type { InvoiceService } from "../../src/invoices/service.js";
import { fromBaseUnits } from "../../src/money.js";
import { chainOfAssetId, withExplorerLinks } from "../../src/oneclick/explorers.js";
import { readIfExists, withSecurityHeaders } from "../../src/routes/static.js";
import type { SettingsReader } from "../../src/settings/store.js";

export interface InvoicesOptions {
  service: InvoiceService;
  settings: SettingsReader;
  /** The folder with invoices.css (demo/public/invoices). */
  dir: string;
  now?: () => Date;
}

/** No script at all, and nothing from another host. The page's links go out to block explorers and back to the demo. */
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SHOWN = 100;
const CHAINS: Record<string, string> = {
  near: "NEAR",
  base: "Base",
  arb: "Arbitrum",
  eth: "Ethereum",
  sol: "Solana",
  btc: "Bitcoin",
  tron: "Tron",
  op: "Optimism",
  pol: "Polygon",
  bsc: "BNB Chain",
  avax: "Avalanche",
};
const chainName = (chain: string) => CHAINS[chain.toLowerCase()] ?? chain.toUpperCase();

export interface Transaction {
  hash: string;
  url: string | null;
}

export interface PublicInvoice {
  id: string;
  createdAt: string;
  items: { name: string; qty: number }[];
  amount: string;
  asset: string;
  status: "open" | "paid" | "partially refunded" | "refunded" | "expired" | "canceled";
  paidWith: { amount: string; symbol: string; chain: string } | null;
  transactions: Transaction[];
  refunds: { amount: string; status: string; transactions: Transaction[] }[];
}

const toTransactions = (links: { hash: string; explorerUrl: string }[]): Transaction[] =>
  links.map((l) => ({ hash: l.hash, url: l.explorerUrl.startsWith("https://") ? l.explorerUrl : null }));

const REFUND_LABEL: Record<string, string> = {
  awaiting_approval: "waiting for approval",
  pending: "processing",
  submitted: "processing",
  succeeded: "refunded",
  failed: "failed",
};

/**
 * What the public page may say about an order, and no more. It is built field by field from the stored records, never by
 * passing a record through, so a refund address, a deposit address or a quote can't reach the page by accident.
 */
export function publicInvoices(service: InvoiceService, settings: SettingsReader): PublicInvoice[] {
  // Paid orders are fetched on their own, so a burst of unpaid orders can't push them off the page. Ids sort by time.
  const byId = new Map(
    [
      ...service.listInvoices({ status: "paid", limit: SHOWN }).invoices,
      ...service.listInvoices({ limit: SHOWN }).invoices,
    ].map((invoice) => [invoice.id, invoice]),
  );
  const rows = [...byId.values()].toSorted((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const out: PublicInvoice[] = [];
  for (const row of rows) {
    if (row.metadata?.source !== "shop") continue; // The page never shows an invoice the shop did not make.
    const { invoice, attempts, refunds } = service.getInvoiceDetail(row.id);
    const asset = settings.tokenFor(invoice.assetId);
    const items = Array.isArray(invoice.metadata?.items)
      ? (invoice.metadata.items as { name: string; qty: number }[]).map((i) => ({
          name: String(i.name),
          qty: Number(i.qty),
        }))
      : [];
    const paidAttempt = attempts.find((a) => a.id === invoice.paidAttemptId);
    const refunded = BigInt(invoice.refundedAmount);
    const status: PublicInvoice["status"] =
      invoice.status !== "paid"
        ? invoice.status
        : refunded >= BigInt(invoice.amount)
          ? "refunded"
          : refunded > 0n
            ? "partially refunded"
            : "paid";
    out.push({
      id: invoice.id,
      createdAt: invoice.createdAt,
      items,
      amount: fromBaseUnits(invoice.amount, asset.decimals),
      asset: asset.symbol,
      status,
      paidWith: paidAttempt
        ? {
            amount: fromBaseUnits(paidAttempt.amountIn, paidAttempt.originDecimals),
            symbol: paidAttempt.originSymbol,
            chain: chainName(paidAttempt.originChain),
          }
        : null,
      transactions: paidAttempt
        ? toTransactions(
            withExplorerLinks(
              paidAttempt.statusResponse?.swapDetails.originChainTxHashes ?? [],
              paidAttempt.originChain,
            ),
          )
        : [],
      refunds: refunds.map((r) => ({
        amount: fromBaseUnits(r.amount, asset.decimals),
        status: REFUND_LABEL[r.status] ?? r.status,
        transactions: toTransactions(
          withExplorerLinks(
            r.statusResponse?.swapDetails.destinationChainTxHashes ?? [],
            chainOfAssetId(r.quote?.quoteRequest.destinationAsset),
          ),
        ),
      })),
    });
  }
  return out;
}

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const short = (hash: string) => (hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash);
const label = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);

const links = (transactions: Transaction[]) =>
  transactions
    .map((t) =>
      t.url
        ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(short(t.hash))}</a>`
        : `<span>${esc(short(t.hash))}</span>`,
    )
    .join(" ");

export function renderPage(invoices: PublicInvoice[], generatedAt: string): string {
  const paid = invoices.filter((i) => ["paid", "partially refunded", "refunded"].includes(i.status));
  const refunds = invoices.flatMap((i) => i.refunds).filter((r) => r.status === "refunded");
  const rows = invoices
    .map((i) => {
      const what = i.items.map((x) => `${x.qty} × ${esc(x.name)}`).join(", ") || "Order";
      const route = i.paidWith ? `${esc(i.paidWith.amount)} ${esc(i.paidWith.symbol)} on ${esc(i.paidWith.chain)}` : "";
      const refundLines = i.refunds
        .map(
          (r) =>
            `<div class="refund">Refund of ${esc(r.amount)} ${esc(i.asset)}: ${esc(r.status)} ${links(r.transactions)}</div>`,
        )
        .join("");
      return `<tr>
  <td data-label="Time">${esc(when(i.createdAt))}</td>
  <td data-label="Order">${what}<div class="id">${esc(i.id)}</div></td>
  <td data-label="Amount">${esc(i.amount)} ${esc(i.asset)}</td>
  <td data-label="Status"><span class="badge ${esc(i.status.replace(" ", "-"))}">${esc(label(i.status))}</span></td>
  <td data-label="Paid with">${route}<div class="tx">${links(i.transactions)}</div>${refundLines}</td>
</tr>`;
    })
    .join("\n");
  const total = paid.reduce((sum, i) => sum + Number(i.amount), 0);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Tilll demo · Invoices</title>
<meta name="description" content="Every order placed in the Tilll demo shop, read-only. The payments are real and settle on mainnet.">
<link rel="stylesheet" href="/invoices.css">
</head>
<body>
<header class="top"><a class="brand" href="/shop">Tilll Coffee <span class="tag">Demo shop</span></a>
<nav aria-label="Main"><a href="/shop">Shop</a><a href="/docs">Docs</a></nav></header>
<main>
<h1>Demo invoices</h1>
<p class="lead">Every order placed in the demo shop, newest first. The payments are real and settle on mainnet. This page is read-only: it never shows refund addresses or any payer detail. It refreshes every 30 seconds.</p>
<ul class="stats" aria-label="Totals">
<li><strong>${invoices.length}</strong> orders</li>
<li><strong>${paid.length}</strong> paid</li>
<li><strong>${esc(String(Math.round(total * 100) / 100))}</strong> paid in total</li>
<li><strong>${refunds.length}</strong> refunded</li>
</ul>
${
  invoices.length === 0
    ? '<p class="empty">No orders yet. Place one in the <a href="/shop">demo shop</a> and it appears here.</p>'
    : `<table>
<thead><tr><th>Time</th><th>Order</th><th>Amount</th><th>Status</th><th>Paid with</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
}
<p class="foot">Machine-readable: <a href="/invoices.json">/invoices.json</a>. Updated ${esc(when(generatedAt))}.</p>
</main>
</body>
</html>
`;
}

const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");

/** The public, read-only view of the demo's orders: `/invoices` for people, `/invoices.json` for programs. */
export const invoicesRoutes: FastifyPluginAsync<InvoicesOptions> = async (app, opts) => {
  const now = opts.now ?? (() => new Date());
  await app.register(rateLimit, { global: false });
  const limit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  app.get("/invoices", limit, async (_request, reply) =>
    withSecurityHeaders(noStore(reply), CSP)
      .header("content-type", "text/html; charset=utf-8")
      .send(renderPage(publicInvoices(opts.service, opts.settings), now().toISOString())),
  );

  app.get("/invoices.json", limit, async (_request, reply) => {
    const invoices = publicInvoices(opts.service, opts.settings);
    return withSecurityHeaders(noStore(reply), "default-src 'none'; frame-ancestors 'none'")
      .header("access-control-allow-origin", "*")
      .send({ generatedAt: now().toISOString(), invoices });
  });

  app.get("/invoices.css", limit, async (_request, reply) => {
    const css = await readIfExists(join(opts.dir, "invoices.css"));
    if (!css) throw new ApiError(404, "not_found", "No such page.");
    return withSecurityHeaders(reply, CSP)
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(css);
  });
};
