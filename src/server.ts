import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { IconService } from "./icons.js";
import type { InvoiceService } from "./invoices/service.js";
import type { OneClickClient } from "./oneclick/client.js";
import type { RefundService } from "./refunds/service.js";
import type { TokenCache } from "./oneclick/tokens.js";
import type { AccountProof } from "./settings/accountProof.js";
import type { SettingsStore } from "./settings/store.js";
import type { Dispatcher } from "./webhooks/dispatcher.js";
import type { WebhookLog } from "./webhooks/log.js";
import { createSessionManager } from "./auth/session.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { iconRoutes } from "./routes/icons.js";
import { merchantRoutes, type SettingsInfo } from "./routes/merchant.js";
import { registerWidgetScript } from "./routes/pages.js";
import { payRoutes } from "./routes/pay.js";

export interface ServerOptions {
  merchantSecret: string;
  allowedOrigins: string[];
  /** Chains to offer at checkout beyond those with a strict address check. */
  extraChains?: string[];
  /** Where the built widget (checkout.js) lives. Defaults to ./public next to src. */
  publicDir?: string;
  /** Per-IP limit on the public /pay/* routes. */
  rateLimit?: { max: number; timeWindow: string };
  /** Whom to believe about a request's origin address and host (TRUST_PROXY). Defaults to nobody. */
  trustProxy?: boolean | number | string[];
  /** Token and network images (from NEAR Intents' explorer, kept on disk). Without it the checkout shows letter badges. */
  icons?: IconService;
  /** Where the built dashboard lives. Defaults to ./public/dashboard next to src. */
  dashboardDir?: string;
  /** Per-IP limit on dashboard login attempts. */
  loginRateLimit?: { max: number; timeWindow: string };
  /** Injectable for tests: the clock sessions expire by. */
  now?: () => Date;
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
  client: Pick<OneClickClient, "depositSubmit">;
  tokens: TokenCache;
  /** The settings in force (account, asset, limits, webhook URL, ...) and how the dashboard changes them. */
  settings: SettingsStore;
  /** Proves the merchant controls a new settlement account before it is accepted. */
  accountProof: AccountProof;
  webhooks: Pick<Dispatcher, "sendPing" | "deliver">;
  webhookLog: WebhookLog;
  /** What the settings page shows. */
  info: SettingsInfo;
  logger?: boolean | object;
}

/**
 * Fastify refuses a bare number for `trustProxy` (it fails closed: nothing is trusted). A count of proxies is what
 * Express calls `trust proxy: 1`: believe the last `hops` addresses in the chain. It is only safe when Tilll can be
 * reached through those proxies and nothing else, which is why the README ties it to the loopback-only port.
 */
function toFastifyTrust(
  trust: boolean | number | string[],
): boolean | string[] | ((address: string, hop: number) => boolean) {
  return typeof trust === "number" ? (_address, hop) => hop < trust : trust;
}

const send = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.status(status).send({ error: { code, message } });

/** Every failure leaves the API as `{ error: { code, message } }`. Unexpected ones never reveal their details. */
function errorHandler(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ApiError) return send(reply, error.status, error.code, error.message);
  const status = (error as FastifyError).statusCode;
  if (status === 429) return send(reply, 429, "rate_limited", "Too many requests. Wait a moment and try again.");
  if (status !== undefined && status >= 400 && status < 500)
    return send(reply, status, "invalid_request", error.message);
  request.log.error({ err: error }, "unhandled error");
  return send(reply, 500, "internal_error", "Something went wrong. Try again in a moment.");
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    ...(options.trustProxy !== undefined ? { trustProxy: toFastifyTrust(options.trustProxy) } : {}),
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_request, reply) => send(reply, 404, "not_found", "No such route."));

  registerWidgetScript(app, options.publicDir ?? fileURLToPath(new URL("../public/", import.meta.url)));

  // Tilll serves an API, a checkout and a dashboard. The project's own website is built separately (site/).
  app.get("/", async (_request, reply) => reply.redirect("/dashboard"));

  const sessions = createSessionManager(options.merchantSecret, options.now ? { now: options.now } : {});
  await app.register(dashboardRoutes, {
    prefix: "/dashboard",
    merchantSecret: options.merchantSecret,
    sessions,
    secureCookie: () => options.settings.current().publicBaseUrl.startsWith("https:"),
    dashboardDir: options.dashboardDir ?? fileURLToPath(new URL("../public/dashboard", import.meta.url)),
    loginRateLimit: options.loginRateLimit ?? { max: 10, timeWindow: "1 minute" },
  });
  await app.register(merchantRoutes, {
    prefix: "/v1",
    merchantSecret: options.merchantSecret,
    sessions,
    service: options.service,
    refunds: options.refunds,
    tokens: options.tokens,
    settings: options.settings,
    accountProof: options.accountProof,
    extraChains: options.extraChains ?? [],
    webhooks: options.webhooks,
    webhookLog: options.webhookLog,
    info: options.info,
  });
  if (options.icons) {
    await app.register(iconRoutes, {
      prefix: "/pay/icons",
      icons: options.icons,
      tokens: options.tokens,
      extraChains: options.extraChains ?? [],
    });
  }
  await app.register(payRoutes, {
    prefix: "/pay",
    allowedOrigins: options.allowedOrigins,
    rateLimit: options.rateLimit ?? { max: 120, timeWindow: "1 minute" },
    service: options.service,
    client: options.client,
    tokens: options.tokens,
    settings: options.settings,
    extraChains: options.extraChains ?? [],
    ...(options.icons ? { icons: options.icons } : {}),
  });
  return app;
}
