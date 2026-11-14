import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createWebhookHandler } from "./webhook-receiver.js";

export interface DemoStoreOptions {
  /** Where the shop's server reaches Tilll (server to server). */
  tilllUrl: string;
  /** Where the visitor's browser reaches Tilll. Defaults to `tilllUrl`. */
  tilllPublicUrl?: string;
  /** The merchant secret. It stays in this process and is never sent to the browser. */
  merchantSecret: string;
  /** Tilll's WEBHOOK_SECRET. When set, the store verifies and lists the webhooks Tilll sends to /hooks/tilll. */
  webhookSecret?: string;
}

// The price is set here, on the server. The browser cannot change what it is charged.
const PRODUCT = { amount: "5.00", description: "Single-origin coffee beans (250 g)" };

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const file = (name: string) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

const sendError = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, "application/json", JSON.stringify({ error: { code, message } }));

/**
 * A tiny merchant website showing the intended integration: the shop's server creates the invoice with the
 * merchant secret, and its page opens the Tilll checkout widget for that invoice.
 */
export function createDemoStore(options: DemoStoreOptions): Server {
  const publicUrl = (options.tilllPublicUrl ?? options.tilllUrl).replace(/\/+$/, "");
  const tilllOrigin = (() => {
    try {
      return new URL(publicUrl).origin;
    } catch {
      return publicUrl;
    }
  })();
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${tilllOrigin}`,
    `connect-src 'self' ${tilllOrigin}`,
    "style-src 'unsafe-inline'",
    // The checkout's token and network images are served by Tilll, so this page must allow them.
    `img-src 'self' data: ${tilllOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  // Webhooks received so far: just enough to show the integration working, never the event data.
  const received: { id: string; type: string; receivedAt: string }[] = [];
  const webhookHandler = options.webhookSecret
    ? createWebhookHandler({
        secret: options.webhookSecret,
        onEvent: (event) =>
          void received.push({ id: event.id, type: event.type, receivedAt: new Date().toISOString() }),
      })
    : undefined;

  async function checkout(res: ServerResponse) {
    try {
      const response = await fetch(`${options.tilllUrl.replace(/\/+$/, "")}/v1/invoices`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.merchantSecret}`, "content-type": "application/json" },
        body: JSON.stringify(PRODUCT),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { id?: unknown };
      if (!response.ok || typeof body.id !== "string") throw new Error(`Tilll answered ${response.status}`);
      send(res, 200, "application/json", JSON.stringify({ invoiceId: body.id }));
    } catch {
      sendError(res, 502, "tilll_unavailable", "Could not create the invoice. Is the Tilll server running?");
    }
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://store").pathname;
    void (async () => {
      if (path === "/") {
        const html = (await file("index.html")).replace("__TILLL_URL__", escapeHtml(publicUrl));
        return send(res, 200, "text/html; charset=utf-8", html, { "content-security-policy": csp });
      }
      if (path === "/shop.js") return send(res, 200, "application/javascript; charset=utf-8", await file("shop.js"));
      if (path === "/hooks/tilll" && webhookHandler) return webhookHandler(req, res);
      if (path === "/api/webhooks" && webhookHandler) {
        return send(res, 200, "application/json", JSON.stringify({ events: received }));
      }
      if (path === "/api/checkout") {
        return req.method === "POST" ? checkout(res) : sendError(res, 405, "method_not_allowed", "Use POST.");
      }
      return sendError(res, 404, "not_found", "No such page.");
    })().catch(() => sendError(res, 500, "internal_error", "Something went wrong."));
  });
}
