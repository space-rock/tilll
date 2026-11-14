import { NearRpcError, callView } from "./rpc.js";

/** The NEAR Intents verifier on mainnet. A testnet runs its own copy under a different account id. */
export const MAINNET_VERIFIER = "intents.near";

interface Rpc {
  rpcUrl: string;
  /** The verifier contract. Defaults to the mainnet one. */
  contractId?: string;
  fetch?: typeof fetch;
}

/**
 * An account's balance of one token inside the NEAR Intents verifier contract, in base units.
 * `tokenId` is the 1Click assetId, e.g. `nep141:<contract>`.
 */
export async function getIntentsBalance(options: Rpc & { accountId: string; tokenId: string }): Promise<string> {
  const contractId = options.contractId ?? MAINNET_VERIFIER;
  const result = await callView({
    rpcUrl: options.rpcUrl,
    contractId,
    method: "mt_balance_of",
    args: { account_id: options.accountId, token_id: options.tokenId },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (typeof result !== "string" || !/^\d+$/.test(result)) {
    throw new NearRpcError(`${contractId}.mt_balance_of did not return a balance.`);
  }
  return result;
}

/** Whether `publicKey` (`ed25519:<base58>`) is registered for `accountId` on the verifier, so it can sign intents. */
export async function hasPublicKey(options: Rpc & { accountId: string; publicKey: string }): Promise<boolean> {
  const contractId = options.contractId ?? MAINNET_VERIFIER;
  const result = await callView({
    rpcUrl: options.rpcUrl,
    contractId,
    method: "has_public_key",
    args: { account_id: options.accountId, public_key: options.publicKey },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (typeof result !== "boolean") throw new NearRpcError(`${contractId}.has_public_key did not return true or false.`);
  return result;
}
