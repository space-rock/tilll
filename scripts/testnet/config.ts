/** Fixed testnet targets for the development harness. Nothing here is read from the environment or from .env. */
import { join } from "node:path";
import {
  DUMMY_API_KEY,
  TESTNET_BASE_URL,
  assertTestnetHealth,
  assertTestnetTargets,
  type TestnetTargets,
} from "./guard.js";
import { getHealth } from "./tidepool.js";

export const BASE_URL = TESTNET_BASE_URL;
export const NEAR_RPC_URL = "https://test.rpc.fastnear.com";
export const VERIFIER = "verifier.tidepool-sandbox.testnet";
export const USDC = {
  assetId: "nep141:usdc.tidepool-sandbox.testnet",
  contract: "usdc.tidepool-sandbox.testnet",
  decimals: 6,
};
export const USDT = {
  assetId: "nep141:usdt.tidepool-sandbox.testnet",
  contract: "usdt.tidepool-sandbox.testnet",
  decimals: 6,
};
export const KEYS_PATH = join("data", "testnet", "keys.json");
export { DUMMY_API_KEY };

/** Refuse to continue unless every target is the testnet, and Tidepool itself says it is one. Returns its health. */
export async function assertTestnet(accountIds: string[]): Promise<unknown> {
  const targets: TestnetTargets = {
    oneClickBaseUrl: BASE_URL,
    nearRpcUrl: NEAR_RPC_URL,
    intentsContract: VERIFIER,
    accountIds,
    apiKey: DUMMY_API_KEY,
  };
  assertTestnetTargets(targets);
  const health = await getHealth(BASE_URL);
  assertTestnetHealth(health, VERIFIER);
  return health;
}
