import { join } from "node:path";
import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { ApiError } from "../../src/errors.js";
import type { InvoiceService } from "../../src/invoices/service.js";
import { fromBaseUnits } from "../../src/money.js";
import type { SettingsReader } from "../../src/settings/store.js";
import { CONTENT_TYPES, readIfExists, withSecurityHeaders } from "../../src/routes/static.js";
import { verifySignature } from "../../src/webhooks/signature.js";
import { MAX_QTY, MAX_TOTAL_CENTS, PRODUCTS, centsToAmount, priceCart } from "./catalogue.js";

export interface ShopRouteOptions {
  service: InvoiceService;
  /** Tells the decimals of the settlement asset, so amounts go out in display units. */
  settings: SettingsReader;
  /** The folder with index.html, shop.js and shop.css (public/shop). */
  dir: string;
  /** Signs the webhooks Tilll sends to `POST /shop/hooks`. */
  webhookSecret: string;
  now?: () => Date;
  /** Orders one visitor may start a minute, and orders the whole shop accepts an hour. */
  perMinute?: number;
  perHour?: number;
}

/** Everything the page loads comes from this origin: the script, the style, the checkout widget and its calls. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const INVOICE_ID = /^inv_[0-9A-HJKMNP-TV-Z]{26}$/;
const FILES: Record<string, string> = { "index.html": ".html", "shop.js": ".js", "shop.css": ".css" };
const SHOP_EXPIRY_MINUTES = 30;
const HOUR_MS = 60 * 60_000;
/** A route's own limit: requests a minute per visitor. The plugin is registered with `global: false`. */
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

/**
 * The demo shop at `/shop`: six products, a cart, and the Tilll checkout opened from it. It is the integration the README
 * describes, running on the same server so one container is the whole demo. The browser sends product ids and counts;
 * the server prices them, creates the invoice and, after payment, reports the invoice's status itself.
 */
export const shopRoutes: FastifyPluginAsync<ShopRouteOptions> = async (app, opts) => {
  const { service } = opts;
  const now = opts.now ?? (() => new Date());
  await app.register(rateLimit, { global: false });

  const sendFile = async (reply: FastifyReply, name: string) => {
    const bytes = await readIfExists(join(opts.dir, name));
    if (!bytes) throw new ApiError(404, "shop_not_found", "The demo shop has not been set up on this server.");
    return withSecurityHeaders(reply, CSP)
      .header("content-type", CONTENT_TYPES[FILES[name]!]!)
      .header("cache-control", "no-cache")
      .send(bytes);
  };
  app.get("/", limit(120), (_request, reply) => sendFile(reply, "index.html"));
  app.get("/shop.js", limit(120), (_request, reply) => sendFile(reply, "shop.js"));
  app.get("/shop.css", limit(120), (_request, reply) => sendFile(reply, "shop.css"));

  app.get("/api/products", limit(120), async (_request, reply) =>
    reply.header("cache-control", "no-store").send({
      products: PRODUCTS.map((p) => ({ ...p, price: centsToAmount(p.cents) })),
      limits: { maxQty: MAX_QTY, maxTotal: centsToAmount(MAX_TOTAL_CENTS) },
    }),
  );

  const started: number[] = [];
  app.post("/api/invoices", limit(opts.perMinute ?? 10), async (request, reply) => {
    const cart = priceCart(request.body);
    const cutoff = now().getTime() - HOUR_MS;
    while (started.length > 0 && started[0]! < cutoff) started.shift();
    if (started.length >= (opts.perHour ?? 300)) {
      throw new ApiError(429, "shop_busy", "The demo shop is busy right now. Try again in a few minutes.");
    }
    const invoice = service.createInvoice({
      amount: cart.amount,
      description: cart.description,
      metadata: {
        source: "shop",
        items: cart.lines.map((l) => ({ id: l.product.id, name: l.product.name, qty: l.qty, cents: l.product.cents })),
      },
      expiresInMinutes: SHOP_EXPIRY_MINUTES,
    });
    started.push(now().getTime());
    return reply.header("cache-control", "no-store").send({ invoiceId: invoice.id });
  });

  // The page confirms an order from this answer, which the server reads from its own record of the invoice. The
  // checkout's `onPaid` callback runs in the browser and can be faked, so it only tells the page to ask.
  app.get<{ Params: { id: string } }>("/api/orders/:id", limit(120), async (request, reply) => {
    const missing = new ApiError(404, "not_found", "We couldn't find that order.");
    if (!INVOICE_ID.test(request.params.id)) throw missing;
    const invoice = service.getInvoice(request.params.id);
    const meta = invoice.metadata;
    if (meta?.source !== "shop") throw missing; // The shop never reveals an invoice it did not make.
    const items = Array.isArray(meta.items) ? (meta.items as { name: string; qty: number }[]) : [];
    return reply.header("cache-control", "no-store").send({
      id: invoice.id,
      status: invoice.status,
      amount: fromBaseUnits(invoice.amount, opts.settings.tokenFor(invoice.assetId).decimals),
      items: items.map((i) => ({ name: i.name, qty: i.qty })),
    });
  });

  // Where the live demo's own `WEBHOOK_URL` points. It checks the signature over the raw bytes, as every receiver should.
  await app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
    hooks.post("/hooks", async (request, reply) => {
      const rawBody = typeof request.body === "string" ? request.body : "";
      const result = verifySignature({
        secret: opts.webhookSecret,
        header: request.headers["tilll-signature"] as string | undefined,
        rawBody,
        now,
      });
      if (!result.ok) throw new ApiError(401, "invalid_signature", result.reason);
      try {
        const event = JSON.parse(rawBody) as { id?: unknown; type?: unknown };
        request.log.info({ event: event.id, type: event.type }, "shop webhook verified");
      } catch {
        // A signed body that is not JSON is still a valid delivery. Nothing here depends on its contents.
      }
      return reply.code(204).send();
    });
  });
};
