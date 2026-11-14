import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { enqueueEvent } from "../events.js";
import { MoneyError, fromBaseUnits, toBaseUnits } from "../money.js";
import { NEAR_ACCOUNT, POSITIVE_DECIMAL } from "../config.js";
import { SettlementAssetError, type TokenCache } from "../oneclick/tokens.js";
import type { Token } from "../oneclick/types.js";

/** What an invoice needs to know about the asset it is priced in. */
export type SettlementAsset = Pick<Token, "assetId" | "symbol" | "decimals" | "blockchain">;

/** The settings the merchant can change in the dashboard. Each is also a starting value in `.env`. */
export const SETTING_KEYS = [
  "settlementAccount",
  "settlementAsset",
  "slippageBps",
  "attemptDeadlineMinutes",
  "webhookUrl",
  "publicBaseUrl",
  "refundMaxPerTx",
  "refundMaxPerDay",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** The `.env` values the settings start from. Limits are in display units, like the variables themselves. */
export interface SettingDefaults {
  settlementAccountId: string;
  settlementAssetId: string;
  slippageBps: number;
  attemptDeadlineMinutes: number;
  webhookUrl: string;
  publicBaseUrl: string;
  refundMaxPerTx: string;
  refundMaxPerDay: string;
}

/** The settings in force right now. A snapshot: it never changes after it is handed out. */
export interface Settings {
  accountId: string;
  asset: SettlementAsset;
  slippageBps: number;
  attemptDeadlineMinutes: number;
  webhookUrl: string;
  /** Where customers reach Tilll, without a trailing slash: pay links are made from it. */
  publicBaseUrl: string;
  /** Base units of `asset`. */
  maxPerTx: bigint;
  maxPerDay: bigint;
}

/** What the services read. */
export interface SettingsReader {
  current(): Settings;
  /** The asset an invoice was priced in, which may not be today's settlement asset. */
  tokenFor(assetId: string): SettlementAsset;
}

export interface SettingSource {
  source: "env" | "dashboard";
  /** When it was changed in the dashboard. */
  updatedAt: string | null;
}

/** What the caller wants changed. Limits and the payment window are given as the merchant types them. */
export interface SettingsPatch {
  slippageBps?: number;
  attemptDeadlineMinutes?: number;
  webhookUrl?: string;
  publicBaseUrl?: string;
  refundMaxPerTx?: string;
  refundMaxPerDay?: string;
  settlementAssetId?: string;
}

export interface SettingChange {
  key: SettingKey;
  from: string;
  to: string;
}

export interface SettingsHistoryEntry extends SettingChange {
  changedAt: string;
}

export interface SettingsStoreDeps {
  db: Db;
  defaults: SettingDefaults;
  tokens: Pick<TokenCache, "resolveSettlementAsset">;
  now?: () => Date;
}

/** Why a setting was not accepted: bad input, so the merchant can fix it. */
const invalid = (field: string, message: string) => new ApiError(400, "invalid_setting", `${field}: ${message}`);

const LABELS: Record<SettingKey, string> = {
  settlementAccount: "Settlement account",
  settlementAsset: "Settlement asset",
  slippageBps: "Slippage",
  attemptDeadlineMinutes: "Payment window",
  webhookUrl: "Webhook URL",
  publicBaseUrl: "Public URL",
  refundMaxPerTx: "Limit per refund",
  refundMaxPerDay: "Limit per day",
};
export const settingLabel = (key: SettingKey) => LABELS[key];

/** A URL without any user:password in it, otherwise exactly as it was written. */
export function withoutCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

/** A setting's value as it may be written to history and to webhooks: never with a password in it. */
const shown = (key: SettingKey, value: string) =>
  key === "webhookUrl" || key === "publicBaseUrl" ? withoutCredentials(value) : value;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function checkDecimal(key: SettingKey, value: string, decimals: number): string {
  const text = value.trim();
  if (!POSITIVE_DECIMAL.test(text)) throw invalid(LABELS[key], "must be a positive decimal number, like 50");
  try {
    toBaseUnits(text, decimals);
  } catch (e) {
    if (e instanceof MoneyError)
      throw invalid(LABELS[key], `${e.message} (the settlement asset has ${decimals} decimals)`);
    throw e;
  }
  return text;
}

function checkUrl(key: SettingKey, value: string): string {
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(LABELS[key], "must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(LABELS[key], "must be an http or https URL");
  }
  return text;
}

const checkWebhookUrl = (value: string) => checkUrl("webhookUrl", value);
/** Pay links are `${publicBaseUrl}/pay/...`, so a trailing slash would double up. */
const checkPublicUrl = (value: string) => checkUrl("publicBaseUrl", value).replace(/\/+$/, "");

function checkInteger(key: SettingKey, value: unknown, min: number, max: number, hint: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(LABELS[key], hint);
  }
  return value;
}

const ASSET_ID = /^[a-z0-9_]+:\S+$/;

/**
 * The settings in force: `.env` gives the starting values, and anything saved in the dashboard wins from then on.
 * Services read `current()` for each operation, so a change applies at once without a restart.
 * Looks up the settlement asset in the 1Click token list, which takes a request, so this is async.
 */
export async function createSettingsStore(deps: SettingsStoreDeps) {
  const saved = deps.db.prepare("SELECT value FROM settings WHERE key = 'settlementAsset'").get() as
    | { value: string }
    | undefined;
  const assetId = saved?.value ?? deps.defaults.settlementAssetId;
  if (!ASSET_ID.test(assetId))
    throw invalid(LABELS.settlementAsset, "must be an asset that NEAR Intents supports. Choose one from the list");
  return createSettingsStoreWith(deps, await resolveSettlementAsset(deps.tokens, assetId));
}

async function resolveSettlementAsset(tokens: SettingsStoreDeps["tokens"], assetId: string): Promise<SettlementAsset> {
  try {
    const token = await tokens.resolveSettlementAsset(assetId);
    return { assetId: token.assetId, symbol: token.symbol, decimals: token.decimals, blockchain: token.blockchain };
  } catch (e) {
    if (e instanceof SettlementAssetError) throw invalid(LABELS.settlementAsset, e.message);
    throw e;
  }
}

/** The same store, for when the settlement asset is already known (it is the one in use now). */
export function createSettingsStoreWith(deps: SettingsStoreDeps, initialAsset: SettlementAsset) {
  const { db, defaults } = deps;
  const now = deps.now ?? (() => new Date());

  const stored = () =>
    new Map(
      (
        db.prepare("SELECT key, value, updated_at AS updatedAt FROM settings").all() as {
          key: SettingKey;
          value: string;
          updatedAt: string;
        }[]
      ).map((r) => [r.key, r]),
    );

  /** The effective value of every setting as text: the dashboard's when there is one, else `.env`'s. */
  const rawValues = (overrides: ReturnType<typeof stored>): Record<SettingKey, string> => ({
    settlementAccount: overrides.get("settlementAccount")?.value ?? defaults.settlementAccountId,
    settlementAsset: overrides.get("settlementAsset")?.value ?? defaults.settlementAssetId,
    slippageBps: overrides.get("slippageBps")?.value ?? String(defaults.slippageBps),
    attemptDeadlineMinutes: overrides.get("attemptDeadlineMinutes")?.value ?? String(defaults.attemptDeadlineMinutes),
    webhookUrl: overrides.get("webhookUrl")?.value ?? defaults.webhookUrl,
    publicBaseUrl: overrides.get("publicBaseUrl")?.value ?? defaults.publicBaseUrl,
    refundMaxPerTx: overrides.get("refundMaxPerTx")?.value ?? defaults.refundMaxPerTx,
    refundMaxPerDay: overrides.get("refundMaxPerDay")?.value ?? defaults.refundMaxPerDay,
  });

  const resolveAsset = (assetId: string) => resolveSettlementAsset(deps.tokens, assetId);

  const remember = (asset: SettlementAsset) =>
    db
      .prepare(
        `INSERT INTO settlement_assets (asset_id, symbol, decimals, chain) VALUES (?, ?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals, chain = excluded.chain`,
      )
      .run(asset.assetId, asset.symbol, asset.decimals, asset.blockchain);

  /** Turn the text values into a snapshot, checking every one. `asset` is what `raw.settlementAsset` names. */
  function build(raw: Record<SettingKey, string>, asset: SettlementAsset): Settings {
    if (
      raw.settlementAccount.length < 2 ||
      raw.settlementAccount.length > 64 ||
      !NEAR_ACCOUNT.test(raw.settlementAccount)
    ) {
      throw invalid(LABELS.settlementAccount, "must be the NEAR account of a wallet you control, like shop-pay.near");
    }
    if (!ASSET_ID.test(raw.settlementAsset)) {
      throw invalid(LABELS.settlementAsset, "must be an asset that NEAR Intents supports. Choose one from the list");
    }
    const slippageBps = checkInteger(
      "slippageBps",
      Number(raw.slippageBps),
      0,
      10_000,
      "must be a whole number from 0 to 10000, where 100 means 1%",
    );
    const attemptDeadlineMinutes = checkInteger(
      "attemptDeadlineMinutes",
      Number(raw.attemptDeadlineMinutes),
      1,
      1440,
      "must be a whole number of minutes from 1 to 1440",
    );
    return {
      accountId: raw.settlementAccount,
      asset,
      slippageBps,
      attemptDeadlineMinutes,
      webhookUrl: checkWebhookUrl(raw.webhookUrl),
      publicBaseUrl: checkPublicUrl(raw.publicBaseUrl),
      maxPerTx: BigInt(toBaseUnits(checkDecimal("refundMaxPerTx", raw.refundMaxPerTx, asset.decimals), asset.decimals)),
      maxPerDay: BigInt(
        toBaseUnits(checkDecimal("refundMaxPerDay", raw.refundMaxPerDay, asset.decimals), asset.decimals),
      ),
    };
  }

  let overrides = stored();
  let snapshot = build(rawValues(overrides), initialAsset);
  remember(snapshot.asset);

  /** The asset the values name: the one in use, or one looked up in the token list. */
  const assetFor = (raw: Record<SettingKey, string>) =>
    raw.settlementAsset === snapshot.asset.assetId ? snapshot.asset : resolveAsset(raw.settlementAsset);

  const current = (): Settings => snapshot;

  /** What would be stranded by moving the money to another account or asset. */
  function inMotion(): string | undefined {
    const refunds = (
      db
        .prepare("SELECT count(*) AS n FROM refunds WHERE status IN ('awaiting_approval', 'pending', 'submitted')")
        .get() as { n: number }
    ).n;
    if (refunds > 0) {
      return `Finish or cancel the ${plural(refunds, "refund", "refunds")} still open first.`;
    }
    const invoices = (
      db
        .prepare(
          `SELECT count(*) AS n FROM invoices i
           WHERE i.status = 'open' AND EXISTS (SELECT 1 FROM attempts a WHERE a.invoice_id = i.id)`,
        )
        .get() as { n: number }
    ).n;
    if (invoices > 0) {
      return `${plural(invoices, "open invoice has", "open invoices have")} a payment under way. Wait for ${invoices === 1 ? "it" : "them"} to be paid or to expire, or cancel ${invoices === 1 ? "it" : "them"}, first.`;
    }
    return undefined;
  }

  const lockedReason = () => inMotion();

  const assertQuiet = () => {
    const reason = inMotion();
    if (reason) throw new ApiError(409, "money_in_motion", reason);
  };

  /** Save the text values that differ from today's, with their history, and publish the new snapshot. */
  function commit(
    next: Settings,
    nextRaw: Record<SettingKey, string>,
    sets: Map<SettingKey, string>,
    resets: Set<SettingKey>,
  ) {
    const before = rawValues(overrides);
    const at = now();
    const iso = at.toISOString();
    const changes: SettingChange[] = [];
    db.transaction(() => {
      for (const key of SETTING_KEYS) {
        if (before[key] === nextRaw[key]) {
          // Same effective value. A reset still drops a dashboard value that happens to equal `.env`'s.
          if (resets.has(key)) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
          continue;
        }
        changes.push({ key, from: shown(key, before[key]), to: shown(key, nextRaw[key]) });
        db.prepare("INSERT INTO settings_history (key, old_value, new_value, changed_at) VALUES (?, ?, ?, ?)").run(
          key,
          shown(key, before[key]),
          shown(key, nextRaw[key]),
          iso,
        );
        if (resets.has(key)) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
        else if (sets.has(key)) {
          db.prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          ).run(key, sets.get(key), iso);
        }
      }
      remember(next.asset);
      if (changes.length > 0) {
        enqueueEvent(
          db,
          {
            type: "settings.updated",
            data: { changes: changes.map((c) => ({ setting: c.key, from: c.from, to: c.to })) },
          },
          at,
        );
      }
    })();
    overrides = stored();
    snapshot = next;
    return changes;
  }

  return {
    current,

    tokenFor(assetId: string): SettlementAsset {
      if (snapshot.asset.assetId === assetId) return snapshot.asset;
      const row = db
        .prepare("SELECT symbol, decimals, chain FROM settlement_assets WHERE asset_id = ?")
        .get(assetId) as { symbol: string; decimals: number; chain: string } | undefined;
      if (!row)
        throw new Error(`Settlement asset ${assetId} was never in use here, so its symbol and decimals are unknown.`);
      return { assetId, symbol: row.symbol, decimals: row.decimals, blockchain: row.chain };
    },

    /** Where each setting's value comes from, for the dashboard. */
    sources(): Record<SettingKey, SettingSource> {
      return Object.fromEntries(
        SETTING_KEYS.map((key) => {
          const o = overrides.get(key);
          return [key, o ? { source: "dashboard", updatedAt: o.updatedAt } : { source: "env", updatedAt: null }];
        }),
      ) as Record<SettingKey, SettingSource>;
    },

    /** The values as the merchant types them: limits in display units. */
    values() {
      const raw = rawValues(overrides);
      return {
        settlementAccount: raw.settlementAccount,
        settlementAsset: raw.settlementAsset,
        slippageBps: snapshot.slippageBps,
        attemptDeadlineMinutes: snapshot.attemptDeadlineMinutes,
        webhookUrl: snapshot.webhookUrl,
        publicBaseUrl: snapshot.publicBaseUrl,
        refundMaxPerTx: fromBaseUnits(snapshot.maxPerTx.toString(), snapshot.asset.decimals),
        refundMaxPerDay: fromBaseUnits(snapshot.maxPerDay.toString(), snapshot.asset.decimals),
      };
    },

    /** Why the settlement account and asset cannot be changed right now, or undefined when they can. */
    lockedReason,

    /** Dashboard values that override `.env`, for the line printed at start. */
    overridden(): SettingKey[] {
      return SETTING_KEYS.filter((key) => overrides.has(key));
    },

    history(limit = 20): SettingsHistoryEntry[] {
      return db
        .prepare(
          "SELECT key, old_value AS 'from', new_value AS 'to', changed_at AS changedAt FROM settings_history ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as SettingsHistoryEntry[];
    },

    /**
     * Save changes to the payment, webhook and limit settings, all or none. Changing the settlement asset moves the
     * money to another token, so it must come with new limits (the old ones are in the old asset's units), and it is
     * refused while a payment or refund is still open.
     */
    async update(patch: SettingsPatch): Promise<SettingChange[]> {
      const raw = rawValues(overrides);
      const next = { ...raw };
      const sets = new Map<SettingKey, string>();
      const set = (key: SettingKey, value: string) => {
        next[key] = value;
        sets.set(key, value);
      };

      if (patch.slippageBps !== undefined) {
        set(
          "slippageBps",
          String(
            checkInteger(
              "slippageBps",
              patch.slippageBps,
              0,
              10_000,
              "must be a whole number from 0 to 10000, where 100 means 1%",
            ),
          ),
        );
      }
      if (patch.attemptDeadlineMinutes !== undefined) {
        set(
          "attemptDeadlineMinutes",
          String(
            checkInteger(
              "attemptDeadlineMinutes",
              patch.attemptDeadlineMinutes,
              1,
              1440,
              "must be a whole number of minutes from 1 to 1440",
            ),
          ),
        );
      }
      if (patch.webhookUrl !== undefined) set("webhookUrl", checkWebhookUrl(patch.webhookUrl));
      if (patch.publicBaseUrl !== undefined) set("publicBaseUrl", checkPublicUrl(patch.publicBaseUrl));
      if (patch.refundMaxPerTx !== undefined) set("refundMaxPerTx", patch.refundMaxPerTx.trim());
      if (patch.refundMaxPerDay !== undefined) set("refundMaxPerDay", patch.refundMaxPerDay.trim());

      if (patch.settlementAssetId !== undefined && patch.settlementAssetId !== raw.settlementAsset) {
        if (!ASSET_ID.test(patch.settlementAssetId)) {
          throw invalid(
            LABELS.settlementAsset,
            "must be an asset that NEAR Intents supports. Choose one from the list",
          );
        }
        if (patch.refundMaxPerTx === undefined || patch.refundMaxPerDay === undefined) {
          throw invalid(
            LABELS.settlementAsset,
            "refund limits are in the asset's units, so set both limits when you change the asset",
          );
        }
        assertQuiet();
        set("settlementAsset", patch.settlementAssetId);
      }

      const built = build(next, await assetFor(next));
      return commit(built, next, sets, new Set());
    },

    /** Change the settlement account. The caller has already proved the merchant controls it. */
    async changeAccount(accountId: string): Promise<SettingChange[]> {
      const raw = rawValues(overrides);
      if (accountId === raw.settlementAccount) return [];
      const next = { ...raw, settlementAccount: accountId };
      const built = build(next, await assetFor(next));
      assertQuiet();
      return commit(built, next, new Map([["settlementAccount", accountId]]), new Set());
    },

    /** Go back to the `.env` value. Resetting the asset also resets the limits, which are in its units. */
    async reset(key: SettingKey): Promise<SettingChange[]> {
      const keys: SettingKey[] =
        key === "settlementAsset" ? ["settlementAsset", "refundMaxPerTx", "refundMaxPerDay"] : [key];
      if (key === "settlementAsset" || key === "settlementAccount") assertQuiet();
      const resets = new Set(keys);
      const without = new Map(overrides);
      for (const k of keys) without.delete(k);
      const next = rawValues(without);
      const built = build(next, await assetFor(next));
      return commit(built, next, new Map(), resets);
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStoreWith>;

/** A fixed set of settings, for tests and scripts that have no database of settings. */
export function fixedSettings(settings: Settings, assets: SettlementAsset[] = []): SettingsReader {
  return {
    current: () => settings,
    tokenFor(assetId) {
      const found = [settings.asset, ...assets].find((a) => a.assetId === assetId);
      if (!found) throw new Error(`Settlement asset ${assetId} is not known to these settings.`);
      return found;
    },
  };
}
