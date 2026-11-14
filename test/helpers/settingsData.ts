import type { Db } from "../../src/db/index.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import { createSettingsStoreWith, type SettingDefaults } from "../../src/settings/store.js";
import { TOKENS, USDC_NEAR, tokenById } from "./oneclickData.js";

/** What .env says in tests. */
export const SETTINGS_DEFAULTS: SettingDefaults = {
  settlementAccountId: "shop-pay.near",
  settlementAssetId: USDC_NEAR,
  slippageBps: 100,
  attemptDeadlineMinutes: 30,
  webhookUrl: "https://merchant.example/hooks/tilll",
  publicBaseUrl: "http://localhost:8080",
  refundMaxPerTx: "50",
  refundMaxPerDay: "200",
};

/** A settings store over `db` whose token list is the test fixture. The settlement asset is USDC on NEAR. */
export function makeSettingsStore(db: Db, defaults: Partial<SettingDefaults> = {}) {
  const asset = tokenById(defaults.settlementAssetId ?? USDC_NEAR);
  return createSettingsStoreWith(
    {
      db,
      defaults: { ...SETTINGS_DEFAULTS, ...defaults },
      tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    },
    { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, blockchain: asset.blockchain },
  );
}
