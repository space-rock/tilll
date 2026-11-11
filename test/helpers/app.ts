import { vi } from "vitest";
import type { DeliveryResult } from "../../src/webhooks/dispatcher.js";
import { buildServer, type ServerOptions } from "../../src/server.js";
import { createWebhookLog } from "../../src/webhooks/log.js";
import type { StatusResponse } from "../../src/oneclick/types.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import { TOKENS, USDC_NEAR, makeWorld, tokenById } from "./world.js";

export const SECRET = "sk_test_secret";
/** What the settings page is told, in tests. */
export const INFO = {
  intentsContract: "intents.near",
  webhookUrl: "https://merchant.example/hooks/tilll",
  oneclickBaseUrl: "https://1click.example",
  apiKeySet: true,
  attemptDeadlineMinutes: 30,
  slippageBps: 100,
};
const unused = async (): Promise<never> => {
  throw new Error("refunds are not wired in this test app");
};
const unusedSync = (): never => {
  throw new Error("refunds are not wired in this test app");
};
export const AUTH = { authorization: `Bearer ${SECRET}` };

/** A world plus an HTTP server on top of it. Requests go through `app.inject`, no sockets. */
export async function makeApp(
  options: Partial<
    Pick<
      ServerOptions,
      | "allowedOrigins"
      | "rateLimit"
      | "extraChains"
      | "publicDir"
      | "publicBaseUrl"
      | "now"
      | "dashboardDir"
      | "logger"
      | "trustProxy"
      | "icons"
    >
  > = {},
) {
  const world = makeWorld();
  const depositSubmit =
    vi.fn<(req: { txHash: string; depositAddress: string; memo?: string }) => Promise<StatusResponse>>();
  const sendPing = vi.fn<() => Promise<DeliveryResult>>(async () => ({
    id: "evt_PING",
    delivered: true,
    status: 200,
    error: null,
    attempts: 1,
    gaveUp: false,
  }));
  const app = await buildServer({
    merchantSecret: SECRET,
    publicBaseUrl: options.publicBaseUrl ?? "http://localhost:8080",
    allowedOrigins: options.allowedOrigins ?? ["*"],
    ...(options.now ? { now: options.now } : {}),
    ...(options.dashboardDir ? { dashboardDir: options.dashboardDir } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.icons ? { icons: options.icons } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.extraChains ? { extraChains: options.extraChains } : {}),
    ...(options.publicDir ? { publicDir: options.publicDir } : {}),
    service: world.service,
    // These tests never refund; a call here means a test reached further than it meant to.
    refunds: {
      account: "shop-pay.near",
      balance: unused,
      preview: unused,
      refund: unused,
      list: unusedSync,
      limits: unusedSync,
    },
    webhookLog: createWebhookLog(world.db),
    info: INFO,
    client: { depositSubmit },
    webhooks: { sendPing, deliver: unused },
    tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    settlement: tokenById(USDC_NEAR),
  });
  return { ...world, app, depositSubmit, sendPing };
}
