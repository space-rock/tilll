import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { SessionManager } from "../auth/session.js";
import type { InvoiceService } from "../invoices/service.js";
import type { RefundService } from "../refunds/service.js";
import { fromBaseUnits } from "../money.js";
import { MAINNET_VERIFIER } from "../near/intents.js";
import { serializeAttempt, serializeInvoice, serializeRefund } from "../invoices/serialize.js";
import type { InvoiceRecord, RefundRecord } from "../invoices/repo.js";
import type { TokenCache } from "../oneclick/tokens.js";
import type { AccountProof } from "../settings/accountProof.js";
import { SETTING_KEYS, withoutCredentials, type SettingKey, type SettingsStore } from "../settings/store.js";
import type { Dispatcher } from "../webhooks/dispatcher.js";
import type { WebhookLog } from "../webhooks/log.js";
import { createMerchantAuth } from "./auth.js";
import { chainsPayload, parse } from "./http.js";

export interface MerchantRouteOptions {
  merchantSecret: string;
  sessions: SessionManager;
  service: InvoiceService;
  refunds: Pick<
    RefundService,
    | "account"
    | "balance"
    | "preview"
    | "refund"
    | "list"
    | "limits"
    | "get"
    | "prepare"
    | "submit"
    | "cancel"
    | "counts"
  >;
  tokens: TokenCache;
  /** The settings in force, and how they are changed. */
  settings: SettingsStore;
  accountProof: AccountProof;
  extraChains: string[];
  webhooks: Pick<Dispatcher, "sendPing" | "deliver">;
  webhookLog: WebhookLog;
  info: SettingsInfo;
}

/** What the dashboard's settings page shows. Never a secret. */
export interface SettingsInfo {
  intentsContract: string;
  oneclickBaseUrl: string;
  /** Whether an API key is set; the key itself is never shown. */
  apiKeySet: boolean;
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

const refundListQuery = pageQuery.extend({
  status: z.enum(["awaiting_approval", "pending", "submitted", "succeeded", "failed"]).optional(),
});

const signatureBody = z.object({
  publicKey: z.string({ error: "publicKey must be the wallet's public key" }).min(1).max(200),
  signature: z.string({ error: "signature must be the wallet's signature" }).min(1).max(8000),
});

const settingsBody = z
  .object({
    slippageBps: z.number({ error: "slippageBps must be a number of basis points" }).optional(),
    attemptDeadlineMinutes: z.number({ error: "attemptDeadlineMinutes must be a number of minutes" }).optional(),
    webhookUrl: z.string({ error: "webhookUrl must be a URL" }).max(2000).optional(),
    publicBaseUrl: z.string({ error: "publicBaseUrl must be a URL" }).max(2000).optional(),
    refundMaxPerTx: z.string({ error: 'refundMaxPerTx must be a string like "50"' }).max(40).optional(),
    refundMaxPerDay: z.string({ error: 'refundMaxPerDay must be a string like "200"' }).max(40).optional(),
    settlementAssetId: z.string({ error: "settlementAssetId must be a 1Click asset id" }).max(300).optional(),
  })
  .strict();

const accountName = z.string({ error: "accountId must be a NEAR account id" }).min(2).max(64);
const challengeBody = z.object({ accountId: accountName });
const accountBody = z.object({
  accountId: accountName,
  nonce: z.string().min(1).max(100),
  publicKey: z.string().min(1).max(200),
  signature: z.string().min(1).max(8000),
});
const settingKeyParam = z.object({ key: z.enum(SETTING_KEYS) });

const listQuery = z.object({
  status: z.enum(["open", "paid", "expired", "canceled"]).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(100).optional(),
});

/** `/v1/*`: the merchant API, authenticated with `Authorization: Bearer <MERCHANT_SECRET>`. */
export const merchantRoutes: FastifyPluginAsync<MerchantRouteOptions> = async (app, opts) => {
  const { service, settings } = opts;
  /** An invoice shows in the asset it was made in, which may not be today's. */
  const assetOf = (inv: InvoiceRecord) => settings.tokenFor(inv.assetId);
  const refundAsset = (r: RefundRecord) => assetOf(service.getInvoice(r.invoiceId));
  const current = () => settings.current();
  const asset = () => {
    const a = current().asset;
    return { id: a.assetId, symbol: a.symbol, decimals: a.decimals };
  };
  /** Base units of the settlement asset in use now, as the merchant reads them. */
  const display = (base: bigint) => fromBaseUnits(base.toString(), current().asset.decimals);
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
      ...serializeInvoice(invoice, assetOf(invoice)),
      payUrl: `${current().publicBaseUrl}/pay/${invoice.id}`,
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
    return { invoices: page.invoices.map((i) => serializeInvoice(i, assetOf(i))), nextCursor: page.nextCursor };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (request) => {
    const detail = service.getInvoiceDetail(request.params.id);
    const now = current();
    const token = assetOf(detail.invoice);
    return {
      invoice: serializeInvoice(detail.invoice, token),
      attempts: detail.attempts.map((a) => serializeAttempt(a, { includeRaw: true })),
      refunds: detail.refunds.map((r) => serializeRefund(r, token)),
      /** False when the invoice was paid to an account or asset the merchant has since moved away from: it cannot be refunded here. */
      refundableHere:
        detail.invoice.settlementAccount === now.accountId && detail.invoice.assetId === now.asset.assetId,
    };
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/cancel", async (request) => ({
    invoice: serializeInvoice(service.cancelInvoice(request.params.id), assetOf(service.getInvoice(request.params.id))),
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
      refund: serializeRefund(refund, refundAsset(refund)),
      invoice: serializeInvoice(service.getInvoice(request.params.id), assetOf(service.getInvoice(request.params.id))),
    });
  });

  app.get("/balance", async () => {
    const balance = (await opts.refunds.balance()).toString();
    return {
      asset: asset(),
      account: opts.refunds.account,
      balance: fromBaseUnits(balance, current().asset.decimals),
      balanceBase: balance,
    };
  });

  app.get("/overview", async () => {
    const stats = service.stats();
    const limits = opts.refunds.limits();
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
      asset: asset(),
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
      refundsAwaitingApproval: opts.refunds.counts().awaiting_approval,
    };
  });

  app.get("/refunds", async (request) => {
    const q = parse(refundListQuery, request.query);
    const page = opts.refunds.list({
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
    return {
      refunds: page.refunds.map((r) => serializeRefund(r, refundAsset(r))),
      nextCursor: page.nextCursor,
      counts: opts.refunds.counts(),
    };
  });

  app.get<{ Params: { id: string } }>("/refunds/:id", async (request) => ({
    refund: serializeRefund(opts.refunds.get(request.params.id), refundAsset(opts.refunds.get(request.params.id))),
  }));

  // Step 2 of a refund: a fresh, checked intent for the merchant's wallet to sign.
  app.post<{ Params: { id: string } }>("/refunds/:id/prepare", async (request) => {
    const prepared = await opts.refunds.prepare(request.params.id);
    return {
      refund: serializeRefund(prepared.refund, refundAsset(prepared.refund)),
      payload: prepared.payload,
      signerId: prepared.signerId,
      expiresAt: prepared.expiresAt,
      summary: prepared.summary,
      note: prepared.note,
    };
  });

  // Step 4: the wallet's signature of the prepared payload. The server sends the intent it kept, not one from the caller.
  app.post<{ Params: { id: string } }>("/refunds/:id/submit", async (request) => {
    const body = parse(signatureBody, request.body);
    const refund = await opts.refunds.submit(request.params.id, body);
    return {
      refund: serializeRefund(refund, refundAsset(refund)),
      invoice: serializeInvoice(service.getInvoice(refund.invoiceId), refundAsset(refund)),
    };
  });

  app.post<{ Params: { id: string } }>("/refunds/:id/cancel", async (request) => {
    const refund = opts.refunds.cancel(request.params.id);
    return {
      refund: serializeRefund(refund, refundAsset(refund)),
      invoice: serializeInvoice(service.getInvoice(refund.invoiceId), refundAsset(refund)),
    };
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
      throw new ApiError(404, "not_found", `We couldn't find webhook event ${request.params.id}.`);
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
    const now = current();
    const limits = opts.refunds.limits();
    return {
      account: now.accountId,
      asset: asset(),
      intentsContract: opts.info.intentsContract,
      /** The network a wallet has to be on: the verifier contract says which. */
      network: opts.info.intentsContract === MAINNET_VERIFIER ? "mainnet" : "testnet",
      publicBaseUrl: withoutCredentials(now.publicBaseUrl),
      webhookUrl: withoutCredentials(now.webhookUrl),
      oneclick: {
        baseUrl: withoutCredentials(opts.info.oneclickBaseUrl),
        apiKeySet: opts.info.apiKeySet,
        ...(await opts.tokens.health()),
      },
      limits: { maxPerTx: display(limits.maxPerTx), maxPerDay: display(limits.maxPerDay) },
      attemptDeadlineMinutes: now.attemptDeadlineMinutes,
      slippageBps: now.slippageBps,
      /** Where each setting's value comes from: `.env`, or a change made in the dashboard. */
      sources: settings.sources(),
      /** Why the settlement account and asset cannot be changed right now (money is in motion), or null. */
      settlementLocked: settings.lockedReason() ?? null,
      /** The latest changes made in the dashboard, newest first. */
      history: settings.history(20).map((h) => ({
        setting: h.key,
        from: h.from,
        to: h.to,
        changedAt: h.changedAt,
      })),
    };
  });

  // Payment window, slippage, refund limits, webhook URL and (with new limits) the settlement asset.
  app.patch("/settings", async (request) => {
    const body = parse(settingsBody, request.body ?? {});
    const patch = {
      ...(body.slippageBps !== undefined ? { slippageBps: body.slippageBps } : {}),
      ...(body.attemptDeadlineMinutes !== undefined ? { attemptDeadlineMinutes: body.attemptDeadlineMinutes } : {}),
      ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
      ...(body.publicBaseUrl !== undefined ? { publicBaseUrl: body.publicBaseUrl } : {}),
      ...(body.refundMaxPerTx !== undefined ? { refundMaxPerTx: body.refundMaxPerTx } : {}),
      ...(body.refundMaxPerDay !== undefined ? { refundMaxPerDay: body.refundMaxPerDay } : {}),
      ...(body.settlementAssetId !== undefined ? { settlementAssetId: body.settlementAssetId } : {}),
    };
    const changes = await settings.update(patch);
    return { changed: changes.map((c) => c.key) };
  });

  // Changing the settlement account takes a signature from that account's wallet: step 1 asks for the message.
  app.post("/settings/account-challenge", async (request) => {
    const body = parse(challengeBody, request.body ?? {});
    return opts.accountProof.challenge(body.accountId);
  });

  // Step 2: the signed message. Only then does the account change.
  app.put("/settings/account", async (request) => {
    const body = parse(accountBody, request.body ?? {});
    await opts.accountProof.verify(body.accountId, body);
    const changes = await settings.changeAccount(body.accountId);
    return { changed: changes.map((c) => c.key) };
  });

  // Go back to the value in .env.
  app.delete<{ Params: { key: string } }>("/settings/:key", async (request) => {
    const { key } = parse(settingKeyParam, request.params);
    const changes = await settings.reset(key as SettingKey);
    return { changed: changes.map((c) => c.key) };
  });

  app.get("/tokens", async () => chainsPayload(opts.tokens, opts.extraChains));

  // Sends a ping to WEBHOOK_URL and reports how the endpoint answered. An unhappy endpoint is data, not an error.
  app.post("/webhooks/test", async () => {
    const started = Date.now();
    const result = await opts.webhooks.sendPing();
    return {
      eventId: result.id,
      delivered: result.delivered,
      status: result.status,
      error: result.error,
      durationMs: Date.now() - started,
    };
  });
};
