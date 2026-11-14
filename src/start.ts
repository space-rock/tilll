import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfig, type Env } from "./config.js";
import { ApiError } from "./errors.js";
import { MoneyError, toBaseUnits } from "./money.js";
import { getIntentsBalance, hasPublicKey } from "./near/intents.js";
import { createRefundService } from "./refunds/service.js";
import { openDb } from "./db/index.js";
import { createInvoiceService, type InvoiceService } from "./invoices/service.js";
import { createIconService, readAssetIcons } from "./icons.js";
import { OneClickError, createOneClickClient } from "./oneclick/client.js";
import { SettlementAssetError, createTokenCache } from "./oneclick/tokens.js";
import { buildServer } from "./server.js";
import { createPoller } from "./watcher/poller.js";
import { createDispatcher } from "./webhooks/dispatcher.js";
import { createWebhookLog } from "./webhooks/log.js";
import { createAccountProof } from "./settings/accountProof.js";
import { createSettingsStore, settingLabel, type SettingsStore } from "./settings/store.js";

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
  /** Told which settings saved in the dashboard override `.env`, one line each, at start. */
  log?: (line: string) => void;
  /** Look for tokens with no image yet, a moment after start and then daily. Off unless asked: it calls the explorer. */
  syncIcons?: boolean;
  /**
   * For a program that embeds Tilll and adds routes of its own. Called once, after the server is built and before it
   * listens, with what such routes may need. There is no setting for it: `main.ts` passes nothing, so the Tilll you run
   * from the image or the CLI has no extra routes.
   */
  extend?: (app: FastifyInstance, context: ExtendContext) => void | Promise<void>;
}

export interface ExtendContext {
  service: InvoiceService;
  settings: SettingsStore;
  /** The secret that signs the webhooks Tilll sends, for a receiver that verifies them. */
  webhookSecret: string;
}

/** A limit given in display units, in the base units of the settlement asset. */
function baseUnitsSetting(variable: string, value: string, decimals: number): void {
  try {
    toBaseUnits(value, decimals);
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
  const dbPath = join(config.dataDir, "tilll.db");
  if (!existsSync(dbPath)) {
    // A new install runs on what .env says, so check it before anything is created. An existing database may hold
    // values saved in the dashboard instead, and the settings store checks those.
    const settlement = await tokens.resolveSettlementAsset(config.settlementAssetId);
    baseUnitsSetting("REFUND_MAX_PER_TX", config.refundMaxPerTx, settlement.decimals);
    baseUnitsSetting("REFUND_MAX_PER_DAY", config.refundMaxPerDay, settlement.decimals);
  }

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(dbPath);
  // `.env` gives the starting values; anything saved in the dashboard wins from then on.
  let settings: Awaited<ReturnType<typeof createSettingsStore>>;
  try {
    settings = await createSettingsStore({
      db,
      tokens,
      defaults: {
        settlementAccountId: config.settlementAccountId,
        settlementAssetId: config.settlementAssetId,
        slippageBps: config.slippageBps,
        attemptDeadlineMinutes: config.attemptDeadlineMinutes,
        webhookUrl: config.webhookUrl,
        publicBaseUrl: config.publicBaseUrl,
        refundMaxPerTx: config.refundMaxPerTx,
        refundMaxPerDay: config.refundMaxPerDay,
      },
    });
  } catch (e) {
    db.close();
    throw e;
  }
  for (const key of settings.overridden()) {
    options.log?.(`${settingLabel(key)} was changed in the dashboard and overrides .env.`);
  }

  const service = createInvoiceService({
    db,
    client,
    tokens,
    settings,
    config: { memoChains: config.memoChains },
  });
  const refunds = createRefundService({
    db,
    client,
    settings,
    config: { intentsContract: config.intentsContract },
    readBalance: async () =>
      BigInt(
        await getIntentsBalance({
          rpcUrl: config.nearRpcUrl,
          contractId: config.intentsContract,
          accountId: settings.current().accountId,
          tokenId: settings.current().asset.assetId,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
      ),
    keyRegistered: (publicKey) =>
      hasPublicKey({
        rpcUrl: config.nearRpcUrl,
        contractId: config.intentsContract,
        accountId: settings.current().accountId,
        publicKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
  });
  const accountProof = createAccountProof({
    rpcUrl: config.nearRpcUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
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
  const dispatcher = createDispatcher({ db, url: () => settings.current().webhookUrl, secret: config.webhookSecret });
  const app = await buildServer({
    merchantSecret: config.merchantSecret,
    allowedOrigins: config.allowedOrigins,
    trustProxy: config.trustProxy,
    icons,
    extraChains: config.extraChains,
    service,
    refunds,
    client,
    tokens,
    settings,
    accountProof,
    webhooks: dispatcher,
    webhookLog: createWebhookLog(db),
    info: {
      intentsContract: config.intentsContract,
      oneclickBaseUrl: config.oneClick.baseUrl,
      apiKeySet: config.oneClick.apiKey !== undefined,
    },
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  await options.extend?.(app, { service, settings, webhookSecret: config.webhookSecret });

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
  if (error instanceof ApiError && error.code === "invalid_setting") {
    return `A setting no longer fits: ${error.message}. Fix it in .env, or remove the value saved in the dashboard.`;
  }
  if (
    error instanceof Error &&
    error.message.startsWith("This database was created by an earlier development version")
  ) {
    return error.message;
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return `The port is already in use: ${error.message}`;
  }
  return undefined;
}
