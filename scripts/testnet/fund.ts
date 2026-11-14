/**
 * Development harness (not part of the product): give the throwaway testnet accounts some test tokens from
 * Tidepool's faucet. Safe to run repeatedly; the faucet allows one claim per address per 24 hours.
 */
import { fromBaseUnits } from "../../src/money.js";
import { getIntentsBalance } from "../../src/near/intents.js";
import { callView } from "../../src/near/rpc.js";
import { BASE_URL, KEYS_PATH, NEAR_RPC_URL, USDC, USDT, VERIFIER, assertTestnet } from "./config.js";
import { loadOrCreateKeystore } from "./keystore.js";
import { FaucetLimitedError, faucet } from "./tidepool.js";

const keys = loadOrCreateKeystore(KEYS_PATH);
const payer = keys.payer.namedAccountId;
if (!payer) throw new Error("No named payer account is recorded in the keystore yet.");

await assertTestnet([keys.settlement.accountId, payer, keys.payer.accountId]);
console.log("guard ok: Tidepool testnet only.");

async function claim(label: string, accountId: string, mode: "wallet" | "intents") {
  try {
    const result = (await faucet({ baseUrl: BASE_URL, accountId, mode })) as {
      drips?: { symbol: string; amount: string }[];
    };
    console.log(
      `${label}: dripped ${(result.drips ?? []).map((d) => `${d.amount} ${d.symbol}`).join(", ") || "(no drips listed)"}`,
    );
  } catch (e) {
    if (e instanceof FaucetLimitedError)
      console.log(`${label}: already claimed in the last 24 hours, skipping (${e.message})`);
    else throw e;
  }
}

await claim("payer (on-chain balances)", payer, "wallet");
await claim("settlement (verifier balance)", keys.settlement.accountId, "intents");

const ftBalance = async (contract: string) =>
  String(
    await callView({
      rpcUrl: NEAR_RPC_URL,
      contractId: contract,
      method: "ft_balance_of",
      args: { account_id: payer },
    }),
  );
console.log(`\npayer ${payer}`);
console.log(`  USDC  ${fromBaseUnits(await ftBalance(USDC.contract), USDC.decimals)}`);
console.log(`  USDT  ${fromBaseUnits(await ftBalance(USDT.contract), USDT.decimals)}`);
// The chain reports "final" a few seconds after the faucet's transaction, so wait for the balance to show up.
let settlementUsdc = "0";
for (let i = 0; i < 12 && settlementUsdc === "0"; i++) {
  settlementUsdc = await getIntentsBalance({
    rpcUrl: NEAR_RPC_URL,
    contractId: VERIFIER,
    accountId: keys.settlement.accountId,
    tokenId: USDC.assetId,
  });
  if (settlementUsdc === "0") await new Promise((r) => setTimeout(r, 3000));
}
console.log(
  `settlement ${keys.settlement.accountId.slice(0, 12)}…  verifier balance USDC  ${fromBaseUnits(settlementUsdc, USDC.decimals)}`,
);
