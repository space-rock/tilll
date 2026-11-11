import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { SessionManager } from "../auth/session.js";
import type { InvoiceService } from "../invoices/service.js";
import type { RefundService } from "../refunds/service.js";
import { fromBaseUnits } from "../money.js";
import { serializeAttempt, serializeInvoice, serializeRefund } from "../invoices/serialize.js";
import type { TokenCache } from "../oneclick/tokens.js";
import type { Token } from "../oneclick/types.js";
import type { Dispatcher } from "../webhooks/dispatcher.js";
import type { WebhookLog } from "../webhooks/log.js";
import { createMerchantAuth } from "./auth.js";
import { chainsPayload, parse } from "./http.js";

export interface MerchantRouteOptions {
  merchantSecret: string;
  sessions: SessionManager;
  publicBaseUrl: string;
  service: InvoiceService;
  refunds: Pick<RefundService, "account" | "balance" | "preview" | "refund" | "list" | "limits">;
  tokens: TokenCache;
  settlement: Token;
  extraChains: string[];
  webhooks: Pick<Dispatcher, "sendPing" | "deliver">;
  webhookLog: WebhookLog;
  info: SettingsInfo;
}

/** What the dashboard's settings page shows. Never a secret. */
export interface SettingsInfo {
  intentsContract: string;
  webhookUrl: string;
  oneclickBaseUrl: string;
  /** Whether an API key is set; the key itself is never shown. */
  apiKeySet: boolean;
  attemptDeadlineMinutes: number;
  slippageBps: number;
}

/** A URL without any user:password in it, otherwise exactly as it was written. */
function withoutCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

const createInvoiceBody = z.object({
  amount: z.string({ error: 'amount must be a string like "5.00" (strings avoid float rounding)' }),
  description: z.string().max(500).optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => JSON.stringify(m).length <= 4096, "metadata must be at most 4096 bytes of JSON")
    .optional(),
  expiresInMinutes: z.number().int().optional(),
});

const previewBody = z.object({
  amount: z.string({ error: 'amount must be a string like "2.50"' }).optional(),
});

const refundBody = z.object({
  amount: z.string({ error: 'amount must be a string like "2.50"' }).optional(),
  idempotencyKey: z
    .string({ error: "idempotencyKey is required: any string up to 200 characters that is unique per refund" })
    .min(1, "idempotencyKey must not be empty")
    .max(200, "idempotencyKey must be at most 200 characters"),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(100).optional(),
});

const listQuery = z.object({
  status: z.enum(["open", "paid", "expired", "canceled"]).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(100).optional(),
});

/** `/v1/*`: the merchant API, authenticated with `Authorization: Bearer <MERCHANT_SECRET>`. */
export const merchantRoutes: FastifyPluginAsync<MerchantRouteOptions> = async (app, opts) => {
  const { service, settlement } = opts;
  const authenticate = createMerchantAuth({ merchantSecret: opts.merchantSecret, sessions: opts.sessions });
  app.addHook("onRequest", async (request) => authenticate(request));

  app.post("/invoices", async (request, reply) => {
    const body = parse(createInvoiceBody, request.body);
    const invoice = service.createInvoice({
      amount: body.amount,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      ...(body.expiresInMinutes !== undefined ? { expiresInMinutes: body.expiresInMinutes } : {}),
    });
    return reply.code(201).send({
      ...serializeInvoice(invoice, settlement),
      payUrl: `${opts.publicBaseUrl}/pay/${invoice.id}`,
    });
  });

  app.get("/invoices", async (request) => {
    const q = parse(listQuery, request.query);
    const page = service.listInvoices({
      ...(q.status ? { status: q.status } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.q ? { search: q.q } : {}),
    });
    return { invoices: page.invoices.map((i) => serializeInvoice(i, settlement)), nextCursor: page.nextCursor };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (request) => {
    const detail = service.getInvoiceDetail(request.params.id);
    return {
      invoice: serializeInvoice(detail.invoice, settlement),
      attempts: detail.attempts.map((a) => serializeAttempt(a, { includeRaw: true })),
      refunds: detail.refunds.map((r) => serializeRefund(r, settlement)),
    };
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/cancel", async (request) => ({
    invoice: serializeInvoice(service.cancelInvoice(request.params.id), settlement),
  }));

  app.post<{ Params: { id: string } }>("/invoices/:id/refunds/preview", async (request) => {
    const body = parse(previewBody, request.body ?? {});
    return opts.refunds.preview(request.params.id, body.amount === undefined ? {} : { amount: body.amount });
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/refunds", async (request, reply) => {
    const body = parse(refundBody, request.body ?? {});
    const { refund, replayed } = await opts.refunds.refund(request.params.id, {
      idempotencyKey: body.idempotencyKey,
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
    });
    return reply.code(replayed ? 200 : 201).send({
      replayed,
      refund: serializeRefund(refund, settlement),
      invoice: serializeInvoice(service.getInvoice(request.params.id), settlement),
    });
  });

  app.get("/balance", async () => {
    const balance = (await opts.refunds.balance()).toString();
    return {
      asset: { id: settlement.assetId, symbol: settlement.symbol, decimals: settlement.decimals },
      account: opts.refunds.account,
      balance: fromBaseUnits(balance, settlement.decimals),
      balanceBase: balance,
    };
  });

  app.get("/overview", async () => {
    const stats = service.stats();
    const limits = opts.refunds.limits();
    const display = (base: bigint) => fromBaseUnits(base.toString(), settlement.decimals);
    const money = (base: bigint) => ({ amount: display(base), amountBase: base.toString() });
    let balance: { value: string; valueBase: string } | null = null;
    let balanceError: string | undefined;
    try {
      const base = await opts.refunds.balance();
      balance = { value: display(base), valueBase: base.toString() };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      balanceError = e.message;
    }
    return {
      asset: { id: settlement.assetId, symbol: settlement.symbol, decimals: settlement.decimals },
      account: opts.refunds.account,
      balance,
      ...(balanceError ? { balanceError } : {}),
      paidToday: { count: stats.paidToday.count, ...money(stats.paidToday.total) },
      openInvoices: stats.open,
      refundedToday: money(limits.usedToday),
      limits: {
        maxPerTx: display(limits.maxPerTx),
        maxPerTxBase: limits.maxPerTx.toString(),
        maxPerDay: display(limits.maxPerDay),
        maxPerDayBase: limits.maxPerDay.toString(),
      },
      day: stats.day,
    };
  });

  app.get("/refunds", async (request) => {
    const q = parse(pageQuery, request.query);
    const page = opts.refunds.list({
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    return { refunds: page.refunds.map((r) => serializeRefund(r, settlement)), nextCursor: page.nextCursor };
  });

  app.get("/webhooks", async (request) => {
    const q = parse(pageQuery, request.query);
    const limit = q.limit ?? 25;
    const rows = opts.webhookLog.page({ cursor: q.cursor, limit: limit + 1 });
    const deliveries = rows.slice(0, limit);
    return { deliveries, nextCursor: rows.length > limit ? deliveries[deliveries.length - 1]!.id : null };
  });

  app.post<{ Params: { id: string } }>("/webhooks/:id/resend", async (request) => {
    if (!opts.webhookLog.find(request.params.id)) {
      throw new ApiError(404, "not_found", `No webhook event ${request.params.id}`);
    }
    const result = await opts.webhooks.deliver(request.params.id, { force: true });
    return {
      id: result.id,
      delivered: result.delivered,
      status: result.status,
      error: result.error,
      attempts: result.attempts,
      gaveUp: result.gaveUp,
    };
  });

  app.get("/settings", async () => {
    const limits = opts.refunds.limits();
    const display = (base: bigint) => fromBaseUnits(base.toString(), settlement.decimals);
    return {
      account: opts.refunds.account,
      asset: { id: settlement.assetId, symbol: settlement.symbol, decimals: settlement.decimals },
      intentsContract: opts.info.intentsContract,
      publicBaseUrl: opts.publicBaseUrl,
      webhookUrl: withoutCredentials(opts.info.webhookUrl),
      oneclick: {
        baseUrl: withoutCredentials(opts.info.oneclickBaseUrl),
        apiKeySet: opts.info.apiKeySet,
        ...(await opts.tokens.health()),
      },
      limits: { maxPerTx: display(limits.maxPerTx), maxPerDay: display(limits.maxPerDay) },
      attemptDeadlineMinutes: opts.info.attemptDeadlineMinutes,
      slippageBps: opts.info.slippageBps,
    };
  });

  app.get("/tokens", async () => chainsPayload(opts.tokens, opts.extraChains));

  // Sends a ping to WEBHOOK_URL and reports how the endpoint answered. An unhappy endpoint is data, not an error.
  app.post("/webhooks/test", async () => {
    const result = await opts.webhooks.sendPing();
    return { eventId: result.id, delivered: result.delivered, status: result.status, error: result.error };
  });
};
