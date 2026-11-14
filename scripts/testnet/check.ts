/**
 * Development harness (not part of the product): run `tilll check` against the Tidepool testnet with an explicit
 * config (never your .env), so the readiness check itself can be tried end to end.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCode, formatChecks, runChecks } from "../../src/check.js";
import { BASE_URL, DUMMY_API_KEY, KEYS_PATH, NEAR_RPC_URL, USDC, VERIFIER, assertTestnet } from "./config.js";
import { loadOrCreateKeystore } from "./keystore.js";

const keys = loadOrCreateKeystore(KEYS_PATH);
await assertTestnet([keys.settlement.accountId]);

const dataDir = mkdtempSync(join(tmpdir(), "tilll-check-testnet-"));
try {
  const results = await runChecks({
    env: {
      ONECLICK_BASE_URL: BASE_URL,
      ONECLICK_API_KEY: DUMMY_API_KEY,
      NEAR_RPC_URL,
      INTENTS_CONTRACT: VERIFIER,
      SETTLEMENT_ACCOUNT_ID: keys.settlement.accountId,
      SETTLEMENT_ASSET_ID: USDC.assetId,
      MERCHANT_SECRET: `sk_check_${randomBytes(8).toString("hex")}`,
      WEBHOOK_URL: "http://127.0.0.1:9/hooks/tilll",
      WEBHOOK_SECRET: `whsec_check_${randomBytes(8).toString("hex")}`,
      DATA_DIR: dataDir,
    },
  });
  console.log(formatChecks(results));
  process.exitCode = exitCode(results);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
