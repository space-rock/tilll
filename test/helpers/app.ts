import { vi } from "vitest";
import type { DeliveryResult } from "../../src/webhooks/dispatcher.js";
import { buildServer, type ServerOptions } from "../../src/server.js";
import { createWebhookLog } from "../../src/webhooks/log.js";
import type { StatusResponse } from "../../src/oneclick/types.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import { createAccountProof } from "../../src/settings/accountProof.js";
import { NearRpcError, type AccessKeyKind } from "../../src/near/rpc.js";
import { TOKENS, makeWorld } from "./world.js";

export const SECRET = "sk_test_secret";
/** What the settings page is told, in tests. */
export const INFO = {
  intentsContract: "intents.near",
  oneclickBaseUrl: "https://1click.example",
  apiKeySet: true,
};

/** A stand-in for the NEAR node: what kind of key the account has. Change `kind` to play another wallet. */
export function makeAccountProof() {
  const accessKeys = { kind: "full" as AccessKeyKind, fails: false };
  const accountProof = createAccountProof({
    rpcUrl: "http://near.invalid",
    accessKey: async () => {
      if (accessKeys.fails) throw new NearRpcError("rpc down");
      return accessKeys.kind;
    },
  });
  return { accessKeys, accountProof };
}
const unused = async (): Promise<never> => {
  throw new Error("refunds are not wired in this test app");
};
const unusedSync = (): never => {
  throw new Error("refunds are not wired in this test app");
};
export const AUTH = { authorization: `Bearer ${SECRET}` };

/** A world plus an HTTP server on top of it. Requests go through `app.inject`, no sockets. */
export async function makeApp(
  options: {
    /** What the settings say is the public address (the cookie is Secure on https). */
    publicBaseUrl?: string;
  } & Partial<
    Pick<
      ServerOptions,
      | "allowedOrigins"
      | "rateLimit"
      | "extraChains"
      | "publicDir"
      | "now"
      | "dashboardDir"
      | "logger"
      | "trustProxy"
      | "icons"
    >
  > = {},
) {
  const world = makeWorld(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {});
  const proof = makeAccountProof();
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
      get: unusedSync,
      counts: unusedSync,
      prepare: unused,
      submit: unused,
      cancel: unusedSync,
    },
    webhookLog: createWebhookLog(world.db),
    info: INFO,
    client: { depositSubmit },
    webhooks: { sendPing, deliver: unused },
    tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    settings: world.settings,
    accountProof: proof.accountProof,
  });
  return { ...world, app, depositSubmit, sendPing, accessKeys: proof.accessKeys };
}
