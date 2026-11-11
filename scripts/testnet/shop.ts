/**
 * Development harness (not part of the product): set up a *named* settlement account on the testnet whose server key
 * is registered with the verifier, the way a merchant with `shopname-pay.near` would have to do it. Then
 * `pnpm testnet:smoke --shop` pays an invoice into that account and refunds it, so the registered-key path is
 * tried end to end on a real verifier before anyone does it on mainnet.
 *
 * What it does, testnet only: creates the account through NEAR's testnet helper (10 test NEAR, one access key) and
 * calls `add_public_key` on the testnet verifier from the account's own access key to register a *different* key,
 * the one the server signs refunds with. It needs no test tokens: the smoke run pays an invoice into the account.
 */
import { fromBaseUnits } from "../../src/money.js";
import { getIntentsBalance, hasPublicKey } from "../../src/near/intents.js";
import { KEYS_PATH, NEAR_RPC_URL, USDC, VERIFIER, assertTestnet } from "./config.js";
import { ensureShop, loadOrCreateKeystore, setShopAccount } from "./keystore.js";
import { callFunction } from "./nearTx.js";

const HELPER = "https://helper.nearprotocol.com/account";
const TGAS_100 = 100_000_000_000_000n;

const shop = ensureShop(KEYS_PATH);
const keys = loadOrCreateKeystore(KEYS_PATH);
let accountId = shop.namedAccountId;
await assertTestnet([keys.settlement.accountId, keys.payer.accountId, ...(accountId ? [accountId] : [])]);
console.log("guard ok: Tidepool testnet only.");

if (!accountId) {
  accountId = `tilll-test-shop-${shop.accessKey.publicKey
    .slice(-6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x")}.testnet`;
  await assertTestnet([keys.settlement.accountId, keys.payer.accountId, accountId]);
  const response = await fetch(HELPER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: shop.accessKey.publicKey }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(
      `NEAR's testnet helper refused to create ${accountId}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  setShopAccount(KEYS_PATH, accountId);
  console.log(`created ${accountId}`);
} else {
  console.log(`using ${accountId}`);
}

const registered = await hasPublicKey({
  rpcUrl: NEAR_RPC_URL,
  contractId: VERIFIER,
  accountId,
  publicKey: shop.publicKey,
});
if (registered) {
  console.log(`server key ${shop.publicKey} is already registered`);
} else {
  // The account's own access key signs; the key being registered is a different one.
  const { txHash } = await callFunction({
    rpcUrl: NEAR_RPC_URL,
    signerId: accountId,
    secretKey: shop.accessKey.secretKey,
    receiverId: VERIFIER,
    method: "add_public_key",
    args: { public_key: shop.publicKey },
    gas: TGAS_100,
    deposit: 1n,
  });
  console.log(`add_public_key tx ${txHash}`);
}

let balance = "0";
for (let i = 0; i < 12 && balance === "0"; i++) {
  balance = await getIntentsBalance({ rpcUrl: NEAR_RPC_URL, contractId: VERIFIER, accountId, tokenId: USDC.assetId });
  if (balance === "0") await new Promise((r) => setTimeout(r, 3000));
}
const nowRegistered = await hasPublicKey({
  rpcUrl: NEAR_RPC_URL,
  contractId: VERIFIER,
  accountId,
  publicKey: shop.publicKey,
});
console.log(
  `\naccount ${accountId}\n  server key registered on the verifier: ${nowRegistered}\n  verifier balance: ${fromBaseUnits(balance, USDC.decimals)} USDC`,
);
console.log("\nNext: pnpm testnet:smoke --shop");
