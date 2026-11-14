# Mainnet smoke test, part 2: one real refund (you run this, not the agent)

This refunds the payment from `scripts/mainnet-smoke.md` through Tilll and checks that the money arrives back at **your own wallet** on Base. It moves real money, so every command here is for **you** to run. The coding agent prepares it and waits.

**What it costs:** the refund is paid out of the Intents balance of your settlement account, and 1Click takes its swap fee out of it, so your wallet receives a little less than the amount you refund. Step 4 shows the estimate before anything is sent. Refund **1.00 USDC**, not the whole 3, so the test stays small.

**Read this before you start**

- The refund goes to the **refund address you entered when you paid**, on the chain you paid from. Check that address in step 4 before you confirm. Never use an exchange deposit address.
- **Your wallet signs the refund.** Tilll holds no key. It checks the intent first and only hands your wallet a transfer of the refund amount to the refund quote's own deposit address. Read the message your wallet shows before you approve it: it must name `intents.near`, your settlement account, and about 1 USDC.
- Keep `.env` private. Never paste `MERCHANT_SECRET` or `WEBHOOK_SECRET` into a chat, an issue or a screenshot.

You need: the paid invoice from the first runbook (its `inv_…` id), the same `.env`, a browser with the wallet of your settlement account, and a little NEAR in that account if it is a named account (registering its key costs a fraction of a cent).

---

## 1. Check the setup (read-only)

```bash
pnpm tilll check
```

Look at the `settlement account` line. It should show your account and say that Tilll holds no key. Any `✗`: fix it first.

Then start Tilll (step 2), open `http://localhost:8080/dashboard`, sign in with `MERCHANT_SECRET`, and select **Connect wallet** in the top bar. Choose your wallet and connect **the settlement account**. The button should show that account. If it shows a warning, the wallet is signed in as another account: switch accounts in the wallet.

A named account (such as `shopname-pay.near`) registers its wallet's key with NEAR Intents once. You do not need to do it now: the first time you approve a refund, the dashboard says so and offers **Register key** (a mainnet transaction of 1 yoctoNEAR plus gas, which your wallet shows and signs). Registering a key does not hand over the account: the key can only act inside `intents.near`, and you can undo it with `remove_public_key`. An implicit account (64 hex characters) needs nothing. If your wallet's account uses a post-quantum key (ML-DSA-65), NEAR Intents does not accept it yet and the dashboard says so: use an account with an `ed25519`, `secp256k1` or `p256` key.

## 2. Start Tilll and the receiver

Same as steps 4 and 5 of `scripts/mainnet-smoke.md` (terminal A: `pnpm webhook-receiver`, terminal B: `pnpm start`). Then in terminal C:

```bash
set -a; source .env; set +a
INV=<the invoice id of your paid test invoice>
```

## 3. See the settlement balance

```bash
curl -s http://localhost:8080/v1/balance -H "authorization: Bearer $MERCHANT_SECRET"
```

**Expect** `"balance"` to be at least `1`. Note the number.

## 4. Preview the refund (a dry quote: nothing is sent)

```bash
curl -s -X POST http://localhost:8080/v1/invoices/$INV/refunds/preview \
  -H "authorization: Bearer $MERCHANT_SECRET" -H 'content-type: application/json' -d '{"amount":"1.00"}'
```

**Expect** `destination.address` to be **your own** Base address and `destination.chain` `base`, and `estimate.amountOutFormatted` to be a little under `1`. If the address is not yours, stop.

## 5. Ask for the refund, then approve it with your wallet (real money)

```bash
curl -s -X POST http://localhost:8080/v1/invoices/$INV/refunds \
  -H "authorization: Bearer $MERCHANT_SECRET" -H 'content-type: application/json' \
  -d '{"amount":"1.00","idempotencyKey":"mainnet-test-1"}'
```

**Expect** HTTP 201 and `"status":"awaiting_approval"`. Nothing has been sent. Running the same command again returns the same refund (`"replayed":true`).

Now approve it. In the dashboard, open **Refunds** (or the invoice) and select **Approve in wallet** on this refund. Tilll prepares it, your wallet asks you to sign a message, and you approve it there. **Expect** the refund to become `submitted`, with an `intentHash`.

Possible errors, all safe (nothing was sent):

| `error.code` | Meaning |
|---|---|
| `intent_refused` | 1Click's intent was not the plain transfer Tilll is willing to hand your wallet. **Stop and send the message to the agent**: it names what Tilll saw (this is the one thing testnet could not show). |
| `key_not_registered` | NEAR Intents does not know your wallet's key for this account. Select **Register key** in the dashboard, then approve again. |
| `unsupported_key_type` | The wallet signed with a key type NEAR Intents does not accept (for example a post-quantum key). Use an account with an `ed25519`, `secp256k1` or `p256` key. |
| `intent_expired` | You took too long. Approve the refund again. |
| `insufficient_balance` | The settlement balance is below the amount. |
| `upstream_unavailable` | The NEAR RPC could not be reached. Try again. |

## 6. Watch it finish

```bash
curl -s http://localhost:8080/v1/invoices/$INV -H "authorization: Bearer $MERCHANT_SECRET"
```

Repeat every ~10 seconds. **Expect** the refund to go `submitted` then `succeeded`, with `txLinks` pointing at the Base transaction, and the invoice's `refundedAmountBase` to become `1000000`.

## 7. Verify (the Phase 5 exit check)

a. **The refund shows `SUCCESS`**: `"status":"succeeded"` in step 6.
b. **The webhook arrived and verified**: terminal A prints `refund.succeeded  evt_…  (signature verified)`.
c. **The money arrived**: open the `txLinks` URL (or your wallet on Base) and confirm about 1 USDC arrived at your address.
d. **The balance fell**: repeat step 3; the balance is 1.00 lower.

## What to send back to the agent

Never secrets: the invoice id, the refund object from step 6, the message your wallet showed (it holds no secret), the `refund.succeeded … (signature verified)  1Click proof: …` line, the explorer link, and the balance before and after. With those the Phase 5 exit check is complete.

## If something goes wrong

| Symptom | What to do |
|---|---|
| Refund stays `submitted` for over 10 minutes | Ask 1Click (read-only): `curl "https://1click.chaindefuser.com/v0/status?depositAddress=<the refund's deposit address>"`. Send the output to the agent. Do not retry with a new key until it is `failed`. |
| Refund `failed` | Read its `error`. The money stays in your Intents balance (refunds are funded from it and returned to it). A new `idempotencyKey` retries. |
| You are unsure whether money moved | Check the settlement balance (step 3) and your wallet. Do not request another refund until you know. |
