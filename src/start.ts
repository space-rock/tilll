import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig, type Env } from "./config.js";
import { MoneyError, toBaseUnits } from "./money.js";
import { getIntentsBalance } from "./near/intents.js";
import { signNep413 } from "./near/nep413.js";
import { createRefundService } from "./refunds/service.js";
import { openDb } from "./db/index.js";
import { createInvoiceService } from "./invoices/service.js";
import { createIconService, readAssetIcons } from "./icons.js";
import { OneClickError, createOneClickClient } from "./oneclick/client.js";
import { SettlementAssetError, createTokenCache } from "./oneclick/tokens.js";
import { buildServer } from "./server.js";
import { createPoller } from "./watcher/poller.js";
import { createDispatcher } from "./webhooks/dispatcher.js";
import { createWebhookLog } from "./webhooks/log.js";

export interface StartOptions {
  /** Overrides PORT. 0 picks a free port. */
  port?: number;
  /** Defaults to 0.0.0.0. */
  host?: string;
  /** Fastify logger setting. Off by default. */
  logger?: boolean | object;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** What asks NEAR Intents' explorer for token images. Separate from `fetch`, which is for 1Click and the NEAR node. */
  iconFetch?: typeof fetch;
  /** The folder of images shipped with Tilll. Defaults to `public/icons`; tests point it elsewhere. */
  bundledIconsDir?: string;
  /** Look for tokens with no image yet, a moment after start and then daily. Off unless asked: it calls the explorer. */
  syncIcons?: boolean;
}

/** A limit given in display units, in the base units of the settlement asset. */
function baseUnitsSetting(variable: string, value: string, decimals: number): bigint {
  try {
    return BigInt(toBaseUnits(value, decimals));
  } catch (e) {
    if (e instanceof MoneyError) {
      throw new ConfigError([{ variable, message: `${e.message} (the settlement asset has ${decimals} decimals)` }]);
    }
    throw e;
  }
}

/**
 * Bring up the whole server. Order matters: configuration, then 1Click and the settlement asset, and only then
 * the disk and the port, so a bad setup fails loudly before it leaves anything behind.
 */
export async function startTilll(env: Env, options: StartOptions = {}) {
  const config = parseConfig(env);
  const client = createOneClickClient({
    baseUrl: config.oneClick.baseUrl,
    apiKey: config.oneClick.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const tokens = createTokenCache({ client });
  const settlement = await tokens.resolveSettlementAsset(config.settlementAssetId);

  const limits = {
    maxPerTx: baseUnitsSetting("REFUND_MAX_PER_TX", config.refundMaxPerTx, settlement.decimals),
    maxPerDay: baseUnitsSetting("REFUND_MAX_PER_DAY", config.refundMaxPerDay, settlement.decimals),
  };

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "tilll.db"));
  const service = createInvoiceService({
    db,
    client,
    tokens,
    settlement,
    config: {
      settlementAccountId: config.settlementAccountId,
      slippageBps: config.slippageBps,
      attemptDeadlineMinutes: config.attemptDeadlineMinutes,
      memoChains: config.memoChains,
    },
  });
  const refunds = createRefundService({
    db,
    client,
    settlement,
    config: {
      settlementAccountId: config.settlementAccountId,
      intentsContract: config.intentsContract,
      slippageBps: config.slippageBps,
      ...limits,
    },
    readBalance: async () =>
      BigInt(
        await getIntentsBalance({
          rpcUrl: config.nearRpcUrl,
          contractId: config.intentsContract,
          accountId: config.settlementAccountId,
          tokenId: settlement.assetId,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
      ),
    sign: (payload) => signNep413(config.settlementPrivateKey, payload),
  });
  const bundledIcons = options.bundledIconsDir ?? fileURLToPath(new URL("../public/icons", import.meta.url));
  const icons = createIconService({
    dir: join(config.dataDir, "icons"),
    bundledDir: bundledIcons,
    assetIcons: readAssetIcons(bundledIcons),
    tokens,
    ...(options.iconFetch ? { fetch: options.iconFetch } : {}),
  });
  const poller = createPoller({ service, refunds, client });
  const dispatcher = createDispatcher({ db, url: config.webhookUrl, secret: config.webhookSecret });
  const app = await buildServer({
    merchantSecret: config.merchantSecret,
    publicBaseUrl: config.publicBaseUrl,
    allowedOrigins: config.allowedOrigins,
    trustProxy: config.trustProxy,
    icons,
    extraChains: config.extraChains,
    service,
    refunds,
    client,
    tokens,
    settlement,
    webhooks: dispatcher,
    webhookLog: createWebhookLog(db),
    info: {
      intentsContract: config.intentsContract,
      webhookUrl: config.webhookUrl,
      oneclickBaseUrl: config.oneClick.baseUrl,
      apiKeySet: config.oneClick.apiKey !== undefined,
      attemptDeadlineMinutes: config.attemptDeadlineMinutes,
      slippageBps: config.slippageBps,
    },
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  const host = options.host ?? "0.0.0.0";
  try {
    await app.listen({ port: options.port ?? config.port, host });
  } catch (error) {
    await app.close();
    db.close();
    throw error;
  }
  poller.start();
  dispatcher.start();
  const iconChecks: ReturnType<typeof setTimeout>[] = [];
  if (options.syncIcons) {
    const check = () => void icons.sync();
    iconChecks.push(setTimeout(check, 1000).unref(), setInterval(check, 24 * 60 * 60_000).unref());
  }

  const { port } = app.server.address() as AddressInfo;
  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    /** Stop polling, stop listening, close the database. */
    stop: async () => {
      for (const timer of iconChecks) clearTimeout(timer);
      await poller.stop();
      await dispatcher.stop();
      await app.close();
      db.close();
    },
  };
}

/** A message for startup failures the operator can fix. Anything else is a bug and should surface with its stack. */
export function startupErrorMessage(error: unknown): string | undefined {
  if (error instanceof ConfigError || error instanceof SettlementAssetError || error instanceof OneClickError) {
    return error.message;
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return `The port is already in use: ${error.message}`;
  }
  return undefined;
}
