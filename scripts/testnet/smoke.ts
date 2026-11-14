/**
 * Development harness (not part of the product): the Phase 4 and 5 smoke test on the Tidepool testnet.
 * An invoice is paid by a throwaway testnet customer through the real Tilll server (real HTTP, real SQLite, real
 * poller and dispatcher), and we check the invoice becomes `paid`, the signed `invoice.paid` webhook arrives and
 * verifies, and the settlement balance inside the testnet verifier goes up by the invoice amount. Then part of it
 * is refunded: the harness plays the merchant's wallet (it prepares the refund, signs the NEP-413 intent with the testnet
 * key, and sends the signature back), Tidepool pays the customer's account, and we check the
 * invoice, the webhook, the settlement balance and the customer's token balance.
 * Testnet only: the guard refuses to run against anything else.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReceiverServer, type ReceivedEvent } from "../../demo-store/webhook-receiver.js";
import { fromBaseUnits } from "../../src/money.js";
import { getIntentsBalance } from "../../src/near/intents.js";
import { signNep413 } from "../../src/near/nep413.js";
import { callView } from "../../src/near/rpc.js";
import { startTilll } from "../../src/start.js";
import { BASE_URL, DUMMY_API_KEY, KEYS_PATH, NEAR_RPC_URL, USDC, USDT, VERIFIER, assertTestnet } from "./config.js";
import { loadOrCreateKeystore } from "./keystore.js";
import { callFunction } from "./nearTx.js";

const INVOICE_AMOUNT = "3.00";
const REFUND_AMOUNT = "1.00";
const TGAS_30 = 30_000_000_000_000n;
const started = Date.now();
const log = (message: string) =>
  console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push([name, ok, detail]);
  log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};

const keys = loadOrCreateKeystore(KEYS_PATH);
const payerAccount = keys.payer.namedAccountId;
if (!payerAccount) throw new Error("No named payer account in the keystore. Run the setup first.");
// With --shop the merchant is a named account whose server key had to be registered (see shop.ts); otherwise an
// implicit account, which needs no registration.
const shopMode = process.argv.includes("--shop");
if (shopMode && !keys.shop?.namedAccountId) throw new Error("No shop account yet. Run `pnpm testnet:shop` first.");
const merchantAccount = shopMode ? keys.shop!.namedAccountId! : keys.settlement.accountId;
const merchantKey = shopMode ? keys.shop!.secretKey : keys.settlement.secretKey;
await assertTestnet([merchantAccount, payerAccount, keys.payer.accountId]);
log(
  `guard ok: Tidepool testnet only; merchant is ${shopMode ? "the named shop account" : "an implicit account"} ${merchantAccount.slice(0, 24)}`,
);

// ---- the merchant's webhook receiver, on loopback ----
const webhookSecret = `whsec_smoke_${randomBytes(8).toString("hex")}`;
const received: ReceivedEvent[] = [];
const receiver = createReceiverServer({ secret: webhookSecret, onEvent: (e) => void received.push(e) });
await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const receiverPort = (receiver.address() as { port: number }).port;

// ---- Tilll, in-process, pointed at the testnet by an explicit config (never your .env) ----
const merchantSecret = `sk_smoke_${randomBytes(12).toString("hex")}`;
const dataDir = mkdtempSync(join(tmpdir(), "tilll-smoke-"));
const tilll = await startTilll(
  {
    ONECLICK_BASE_URL: BASE_URL,
    ONECLICK_API_KEY: DUMMY_API_KEY,
    NEAR_RPC_URL,
    INTENTS_CONTRACT: VERIFIER,
    SETTLEMENT_ACCOUNT_ID: merchantAccount,
    SETTLEMENT_ASSET_ID: USDC.assetId,
    MERCHANT_SECRET: merchantSecret,
    WEBHOOK_URL: `http://127.0.0.1:${receiverPort}/hooks/tilll`,
    WEBHOOK_SECRET: webhookSecret,
    DATA_DIR: dataDir,
  },
  { port: 0, host: "127.0.0.1" },
);
log(`Tilll is up at ${tilll.url}, talking to ${BASE_URL}`);

async function api(method: string, path: string, body?: unknown, auth = true) {
  const response = await fetch(`${tilll.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${merchantSecret}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await response.json()) as any;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

const intentsBalance = () =>
  getIntentsBalance({
    rpcUrl: NEAR_RPC_URL,
    contractId: VERIFIER,
    accountId: merchantAccount,
    tokenId: USDC.assetId,
  });

try {
  const before = BigInt(await intentsBalance());
  log(`settlement verifier balance before: ${fromBaseUnits(before.toString(), USDC.decimals)} USDC`);

  // ---- merchant creates an invoice; the customer picks NEAR USDT (paying NEAR USDC for a USDC invoice is rejected by Tidepool) ----
  const invoice = await api("POST", "/v1/invoices", {
    amount: INVOICE_AMOUNT,
    description: "Tilll testnet smoke test",
  });
  log(`invoice ${invoice.id} for ${invoice.amount} ${invoice.asset.symbol}`);
  const attempt = await api(
    "POST",
    `/pay/invoices/${invoice.id}/attempts`,
    { originAsset: USDT.assetId, refundTo: payerAccount },
    false,
  );
  const detail = await api("GET", `/v1/invoices/${invoice.id}`);
  const amountInBase = detail.attempts[0].amountInBase as string;
  check(
    "attempt created on Tidepool",
    /^[0-9a-f]{64}$/.test(attempt.depositAddress),
    `deposit address ${attempt.depositAddress.slice(0, 12)}…, send ${attempt.amountIn} ${attempt.symbol}`,
  );
  const minutesLeft = (Date.parse(attempt.deadline) - Date.now()) / 60_000;
  check(
    "payer deadline is the 30 minutes we asked for",
    minutesLeft > 28 && minutesLeft <= 30.1,
    `${minutesLeft.toFixed(1)} minutes`,
  );

  // ---- the customer pays from their NEAR testnet account: register the deposit address, then ft_transfer ----
  const bounds = (await callView({
    rpcUrl: NEAR_RPC_URL,
    contractId: USDT.contract,
    method: "storage_balance_bounds",
    args: {},
  })) as { min: string };
  const registered = await callFunction({
    rpcUrl: NEAR_RPC_URL,
    signerId: payerAccount,
    secretKey: keys.payer.secretKey,
    receiverId: USDT.contract,
    method: "storage_deposit",
    args: { account_id: attempt.depositAddress, registration_only: true },
    gas: TGAS_30,
    deposit: BigInt(bounds.min),
  });
  log(`storage_deposit tx ${registered.txHash}`);
  const sent = await callFunction({
    rpcUrl: NEAR_RPC_URL,
    signerId: payerAccount,
    secretKey: keys.payer.secretKey,
    receiverId: USDT.contract,
    method: "ft_transfer",
    args: { receiver_id: attempt.depositAddress, amount: amountInBase },
    gas: TGAS_30,
    deposit: 1n,
  });
  log(`ft_transfer tx ${sent.txHash}: ${fromBaseUnits(amountInBase, USDT.decimals)} USDT sent`);

  // telling 1Click the tx hash early is optional; this exercises our /pay/attempts/:id/tx route against the real thing
  const early = await api("POST", `/pay/attempts/${attempt.id}/tx`, { txHash: sent.txHash }, false);
  log(`told the server the tx hash; attempt is now ${early.status}`);

  // ---- watch it settle ----
  let status = "";
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const view = await api("GET", `/pay/attempts/${attempt.id}`, undefined, false);
    if (view.status !== status) {
      status = view.status;
      log(`attempt ${status}, invoice ${view.invoiceStatus}`);
    }
    if (view.invoiceStatus === "paid" || ["failed", "refunded"].includes(view.status)) break;
    await sleep(3000);
  }
  const final = await api("GET", `/v1/invoices/${invoice.id}`);
  // Keep the real Tidepool quote and status for inspection (gitignored; no secrets in it).
  const record = join("data", "testnet", "last-run.json");
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ invoice: final.invoice, attempt: final.attempts[0] }, null, 2));
  check(
    "invoice reached paid",
    final.invoice.status === "paid",
    `invoice ${final.invoice.status}, attempt ${final.attempts[0].status}`,
  );
  check(
    "explorer link recorded",
    final.attempts[0].txLinks.length > 0 || !!final.attempts[0].depositTxHash,
    JSON.stringify(final.attempts[0].txLinks.map((l: { explorerUrl: string }) => l.explorerUrl)).slice(0, 120),
  );

  // ---- the signed webhook ----
  for (let i = 0; i < 20 && !received.some((e) => e.type === "invoice.paid"); i++) await sleep(1000);
  const paidEvent = received.find((e) => e.type === "invoice.paid");
  check(
    "signed invoice.paid webhook arrived and verified",
    !!paidEvent,
    paidEvent ? `${paidEvent.id}, proof ${paidEvent.proof?.oneclickQuoteSignature.slice(0, 18)}…` : "none received",
  );

  // ---- the money ----
  const wanted = before + BigInt(invoice.amountBase);
  let after = BigInt(await intentsBalance());
  for (let i = 0; i < 20 && after < wanted; i++) {
    await sleep(3000);
    after = BigInt(await intentsBalance());
  }
  check(
    "settlement verifier balance rose by the invoice amount",
    after - before === BigInt(invoice.amountBase),
    `${fromBaseUnits(before.toString(), USDC.decimals)} -> ${fromBaseUnits(after.toString(), USDC.decimals)} USDC (delta ${fromBaseUnits((after - before).toString(), USDC.decimals)})`,
  );

  // ================= Phase 5: refund part of it =================
  const payerUsdt = async () =>
    BigInt(
      (await callView({
        rpcUrl: NEAR_RPC_URL,
        contractId: USDT.contract,
        method: "ft_balance_of",
        args: { account_id: payerAccount },
      })) as string,
    );
  const settlementBefore = after;
  const payerBefore = await payerUsdt();
  log(
    `before the refund: settlement ${fromBaseUnits(settlementBefore.toString(), USDC.decimals)} USDC, customer ${fromBaseUnits(payerBefore.toString(), USDT.decimals)} USDT`,
  );

  const balanceView = await api("GET", "/v1/balance");
  check(
    "GET /v1/balance matches the verifier",
    balanceView.balanceBase === settlementBefore.toString(),
    `${balanceView.balance} ${balanceView.asset.symbol} on ${balanceView.account.slice(0, 12)}…`,
  );

  const preview = await api("POST", `/v1/invoices/${invoice.id}/refunds/preview`, { amount: REFUND_AMOUNT });
  check(
    "refund preview names the customer's own account on near",
    preview.destination.address === payerAccount && preview.destination.chain === "near",
    `would send about ${preview.estimate.amountOutFormatted} ${preview.destination.symbol} to ${preview.destination.address} (withdrawFee ${preview.estimate.withdrawFee})`,
  );

  const key = `smoke-${randomBytes(6).toString("hex")}`;
  const started1 = await api("POST", `/v1/invoices/${invoice.id}/refunds`, {
    amount: REFUND_AMOUNT,
    idempotencyKey: key,
  });
  const refundId = started1.refund.id as string;
  check(
    "refund request saved, waiting for the wallet, nothing sent yet",
    started1.refund.status === "awaiting_approval" && !started1.refund.intentHash,
    started1.refund.status,
  );
  // The merchant's wallet: prepare the refund, sign what the server prepared, send the signature back.
  const prepared = await api("POST", `/v1/refunds/${refundId}/prepare`, {});
  const signed = signNep413(merchantKey, prepared.payload);
  const approved = await api("POST", `/v1/refunds/${refundId}/submit`, {
    publicKey: signed.public_key,
    signature: signed.signature,
  });
  log(`refund ${refundId} ${approved.refund.status}, intent ${approved.refund.intentHash}`);
  check(
    "the wallet's signature accepted and the intent submitted",
    approved.refund.status === "submitted" && !!approved.refund.intentHash,
    `${approved.refund.status}, intent hash ${approved.refund.intentHash}`,
  );

  const again = await api("POST", `/v1/invoices/${invoice.id}/refunds`, { amount: REFUND_AMOUNT, idempotencyKey: key });
  check(
    "the same idempotencyKey returns the same refund",
    again.replayed === true && again.refund.id === refundId,
    `replayed=${again.replayed}`,
  );

  let refundStatus = "";
  const refundDeadline = Date.now() + 240_000;
  let refundDetail = await api("GET", `/v1/invoices/${invoice.id}`);
  while (Date.now() < refundDeadline) {
    refundDetail = await api("GET", `/v1/invoices/${invoice.id}`);
    const current = refundDetail.refunds.find((r: { id: string }) => r.id === refundId);
    if (current.status !== refundStatus) {
      refundStatus = current.status;
      log(`refund ${refundStatus}${current.error ? ` (${current.error})` : ""}`);
    }
    if (["succeeded", "failed"].includes(current.status)) break;
    await sleep(3000);
  }
  const ended = refundDetail.refunds.find((r: { id: string }) => r.id === refundId);
  writeFileSync(join("data", "testnet", "last-refund.json"), JSON.stringify(refundDetail, null, 2));
  check(
    "refund reached succeeded",
    ended.status === "succeeded",
    `${ended.status}${ended.error ? `: ${ended.error}` : ""}`,
  );
  check(
    "invoice counts the refund",
    refundDetail.invoice.refundedAmountBase === "1000000",
    `refunded ${refundDetail.invoice.refundedAmount} of ${refundDetail.invoice.amount}`,
  );
  check(
    "transfer link recorded",
    ended.txLinks.length > 0,
    JSON.stringify(ended.txLinks.map((l: { explorerUrl: string }) => l.explorerUrl)).slice(0, 140),
  );

  for (let i = 0; i < 20 && !received.some((e) => e.type === "refund.succeeded"); i++) await sleep(1000);
  const refundEvent = received.find((e) => e.type === "refund.succeeded");
  check(
    "signed refund.succeeded webhook arrived and verified",
    !!refundEvent,
    refundEvent ? refundEvent.id : "none received",
  );

  let settlementAfter = BigInt(await intentsBalance());
  let payerAfter = await payerUsdt();
  for (let i = 0; i < 10 && (settlementAfter === settlementBefore || payerAfter === payerBefore); i++) {
    await sleep(3000);
    settlementAfter = BigInt(await intentsBalance());
    payerAfter = await payerUsdt();
  }
  check(
    "settlement balance fell by the refund amount",
    settlementBefore - settlementAfter === 1_000_000n,
    `${fromBaseUnits(settlementBefore.toString(), USDC.decimals)} -> ${fromBaseUnits(settlementAfter.toString(), USDC.decimals)} USDC`,
  );
  const gained = payerAfter - payerBefore;
  const estimate = BigInt(preview.estimate.amountOut);
  const drift = gained > estimate ? gained - estimate : estimate - gained;
  check(
    "the customer's account received what the preview promised (within 1%)",
    gained > 0n && drift * 100n <= estimate,
    `+${fromBaseUnits(gained.toString(), USDT.decimals)} USDT, preview said ${fromBaseUnits(estimate.toString(), USDT.decimals)} (${fromBaseUnits(payerBefore.toString(), USDT.decimals)} -> ${fromBaseUnits(payerAfter.toString(), USDT.decimals)})`,
  );
} catch (error) {
  check("smoke run completed without an error", false, error instanceof Error ? error.message : String(error));
} finally {
  await tilll.stop();
  receiver.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length ? `${failed.length} of ${checks.length} checks FAILED` : `all ${checks.length} checks passed`}`,
);
process.exitCode = failed.length ? 1 : 0;
