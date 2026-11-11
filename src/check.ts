import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, parseConfig, type Config, type Env } from "./config.js";
import { openDb } from "./db/index.js";
import { fromBaseUnits, toBaseUnits } from "./money.js";
import { MAINNET_VERIFIER, getIntentsBalance, hasPublicKey } from "./near/intents.js";
import { KeyError, implicitAccountOf, publicKeyOf } from "./near/keys.js";
import { OneClickError, createOneClickClient } from "./oneclick/client.js";
import { paymentQuoteRequest } from "./oneclick/requests.js";
import { SettlementAssetError, createTokenCache } from "./oneclick/tokens.js";
import type { Token } from "./oneclick/types.js";
import { createDispatcher } from "./webhooks/dispatcher.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. */
  hint?: string;
}

export interface CheckDeps {
  env: Env;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Also send a signed test ping to WEBHOOK_URL. Off by default: that is the merchant's own server, not ours to poke. */
  webhook?: boolean;
  now?: () => Date;
}

/** The one-time command that registers a settlement key for a named account on the verifier. The human runs it. */
export const REGISTER_KEY = (publicKey: string, account: string, contract: string) =>
  `near contract call-function as-transaction ${contract} add_public_key json-args '{"public_key": "${publicKey}"}' ` +
  `prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${account} ` +
  `network-config ${contract === MAINNET_VERIFIER ? "mainnet" : "testnet"} sign-with-keychain send`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `tilll check`: is this installation ready to take payments? Everything it does outside this machine is
 * read-only: a token list, a *dry* quote, NEAR view calls, and (only with `webhook`) a test ping to the
 * merchant's own endpoint. It never creates a deposit address, signs, or sends funds, and never prints a secret.
 */
export async function runChecks(deps: CheckDeps): Promise<CheckResult[]> {
  let config: Config;
  try {
    config = parseConfig(deps.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return [
      {
        name: "config",
        status: "fail",
        detail: e.issues.map((i) => `${i.variable} ${i.message}`).join("; "),
        hint: "Fix these in .env (see .env.example), then run the check again.",
      },
    ];
  }

  const results: CheckResult[] = [{ name: "config", status: "pass", detail: "all required settings are valid" }];
  const client = createOneClickClient({
    baseUrl: config.oneClick.baseUrl,
    apiKey: config.oneClick.apiKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const tokens = createTokenCache({ client });

  // ---- 1Click and the settlement asset ----
  let settlement: Token | undefined;
  let listed = false;
  try {
    const all = await tokens.get();
    listed = true;
    results.push({
      name: "1Click",
      status: "pass",
      detail: `reachable at ${config.oneClick.baseUrl}: ${all.length} tokens on ${new Set(all.map((t) => t.blockchain)).size} chains`,
    });
  } catch (e) {
    results.push({
      name: "1Click",
      status: "fail",
      detail: message(e),
      hint: "Check your network and ONECLICK_BASE_URL.",
    });
  }

  if (listed) {
    try {
      settlement = await tokens.resolveSettlementAsset(config.settlementAssetId);
      results.push({
        name: "settlement asset",
        status: "pass",
        detail: `${settlement.symbol} on ${settlement.blockchain} (${settlement.assetId})`,
      });
    } catch (e) {
      if (!(e instanceof SettlementAssetError)) throw e;
      results.push({ name: "settlement asset", status: "fail", detail: e.message });
    }
  } else {
    results.push({ name: "settlement asset", status: "warn", detail: "skipped: 1Click could not be reached" });
  }

  // ---- API key: proven with a dry quote, which never creates a deposit address ----
  if (!config.oneClick.apiKey) {
    results.push({
      name: "API key",
      status: "warn",
      detail: "not set",
      hint: "Optional. Without one, quotes may carry an extra platform fee; run `pnpm dry-quote` to see the current fee. Get a key at https://partners.near-intents.org",
    });
  } else if (!settlement) {
    results.push({ name: "API key", status: "warn", detail: "skipped: the settlement asset is not available" });
  } else {
    const base = (await tokens.find("base", "USDC"))[0];
    if (!base) {
      results.push({ name: "API key", status: "warn", detail: "could not test it: no USDC on Base in the token list" });
    } else {
      try {
        await client.quote(
          paymentQuoteRequest({
            dry: true,
            originAsset: base,
            invoiceAmount: toBaseUnits("1", settlement.decimals),
            refundTo: "0x0000000000000000000000000000000000000001",
            settlementAssetId: settlement.assetId,
            settlementAccountId: config.settlementAccountId,
            slippageBps: config.slippageBps,
            deadlineMinutes: config.attemptDeadlineMinutes,
            memoChains: config.memoChains,
            now: (deps.now ?? (() => new Date()))(),
          }),
        );
        results.push({ name: "API key", status: "pass", detail: "accepted: a dry quote for 1 USDC succeeded" });
      } catch (e) {
        const rejected = e instanceof OneClickError && (e.status === 401 || e.status === 403);
        results.push({
          name: "API key",
          status: "fail",
          detail: rejected
            ? `1Click rejected the API key (HTTP ${(e as OneClickError).status})`
            : `a dry quote failed: ${message(e)}`,
          hint: rejected ? "Check ONECLICK_API_KEY, or remove it to run without one." : undefined,
        });
      }
    }
  }

  // ---- NEAR: the Intents balance (also proves RPC access and the token id format) ----
  const contract = config.intentsContract;
  const rpc = { rpcUrl: config.nearRpcUrl, contractId: contract, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  try {
    const balance = await getIntentsBalance({
      ...rpc,
      accountId: config.settlementAccountId,
      tokenId: config.settlementAssetId,
    });
    const shown = settlement
      ? `${fromBaseUnits(balance, settlement.decimals)} ${settlement.symbol}`
      : `${balance} (base units)`;
    results.push({
      name: "NEAR RPC",
      status: "pass",
      detail: `${contract} reachable; Intents balance of ${config.settlementAccountId}: ${shown}`,
    });
  } catch (e) {
    results.push({
      name: "NEAR RPC",
      status: "fail",
      detail: message(e),
      hint: "Set NEAR_RPC_URL to another public RPC (https://docs.near.org/api/rpc/providers).",
    });
  }

  // ---- the settlement key: only its public half is ever shown ----
  try {
    const publicKey = publicKeyOf(config.settlementPrivateKey);
    if (config.settlementAccountId === implicitAccountOf(config.settlementPrivateKey)) {
      // An implicit account is its key: the verifier needs nothing registered before it can sign.
      results.push({
        name: "settlement key",
        status: "pass",
        detail: `${publicKey} belongs to the implicit account ${config.settlementAccountId}: no registration needed on ${contract}`,
      });
    } else {
      try {
        const registered = await hasPublicKey({ ...rpc, accountId: config.settlementAccountId, publicKey });
        results.push(
          registered
            ? { name: "settlement key", status: "pass", detail: `${publicKey} is registered on ${contract}` }
            : {
                name: "settlement key",
                status: "warn",
                detail: `${publicKey} is not registered on ${contract}: payments work, refunds will not`,
                hint: `Refunds need this key registered. That is a one-time step you run yourself (it moves 1 yoctoNEAR): ${REGISTER_KEY(publicKey, config.settlementAccountId, contract)}`,
              },
        );
      } catch (e) {
        results.push({
          name: "settlement key",
          status: "warn",
          detail: `${publicKey}: could not check registration (${message(e)})`,
        });
      }
    }
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    results.push({ name: "settlement key", status: "fail", detail: e.message });
  }

  // ---- webhook ----
  let hook: URL | undefined;
  try {
    hook = new URL(config.webhookUrl);
  } catch {
    results.push({ name: "webhook", status: "fail", detail: "WEBHOOK_URL is not a valid URL" });
  }
  if (hook) {
    const where = `${hook.origin}${hook.pathname}`;
    if (!deps.webhook) {
      results.push({
        name: "webhook",
        status: "pass",
        detail: `${where} (not contacted; add --webhook to send a signed test ping)`,
      });
    } else {
      const scratch = openDb(":memory:");
      try {
        const ping = await createDispatcher({
          db: scratch,
          url: config.webhookUrl,
          secret: config.webhookSecret,
          log: { error: () => undefined },
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }).sendPing();
        results.push(
          ping.delivered
            ? { name: "webhook", status: "pass", detail: `${where} accepted a signed test ping (HTTP ${ping.status})` }
            : {
                name: "webhook",
                status: "fail",
                detail: `${where} did not accept the test ping: ${ping.error}`,
                hint: "Is your receiver running, and does it use the same WEBHOOK_SECRET?",
              },
        );
      } finally {
        scratch.close();
      }
    }
  }

  // ---- data directory ----
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const probe = join(config.dataDir, `.tilll-check-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
    results.push({ name: "data directory", status: "pass", detail: `${config.dataDir} is writable` });
  } catch (e) {
    results.push({
      name: "data directory",
      status: "fail",
      detail: `${config.dataDir} is not writable: ${message(e)}`,
    });
  }

  return results;
}

const SYMBOL: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", fail: "✗" };

export function formatChecks(results: CheckResult[]): string {
  const lines = results.flatMap((r) => [
    `${SYMBOL[r.status]} ${r.name.padEnd(17)} ${r.detail}`,
    ...(r.hint ? [`    → ${r.hint}`] : []),
  ]);
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const verdict = failed
    ? `${failed} failed${warned ? `, ${warned} with warnings` : ""}`
    : `all checks passed${warned ? ` (${warned} ${warned === 1 ? "warning" : "warnings"})` : ""}`;
  return `${lines.join("\n")}\n\n${verdict}`;
}

/** 1 if anything failed, so scripts can stop. Warnings do not fail. */
export const exitCode = (results: CheckResult[]): number => (results.some((r) => r.status === "fail") ? 1 : 0);
