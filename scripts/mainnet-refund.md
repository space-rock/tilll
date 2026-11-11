# Mainnet smoke test, part 2: one real refund (you run this, not the agent)

This refunds the payment from `scripts/mainnet-smoke.md` through Tilll and checks that the money arrives back at **your own wallet** on Base. It moves real money, so every command here is for **you** to run. The coding agent prepares it and waits.

**What it costs:** the refund is paid out of the Intents balance of your settlement account, and 1Click takes its swap fee out of it, so your wallet receives a little less than the amount you refund. Step 4 shows the estimate before anything is sent. Refund **1.00 USDC**, not the whole 3, so the test stays small.

**Read this before you start**

- The refund goes to the **refund address you entered when you paid**, on the chain you paid from. Check that address in step 4 before you confirm. Never use an exchange deposit address.
- The refund is signed by `SETTLEMENT_PRIVATE_KEY`. The signing key can only spend the Intents balance of the settlement account, and Tilll refuses to sign anything except a transfer of the refund amount to the refund quote's own deposit address.
- Keep `.env` private. Never paste `MERCHANT_SECRET`, `WEBHOOK_SECRET` or `SETTLEMENT_PRIVATE_KEY` into a chat, an issue or a screenshot.

You need: the paid invoice from the first runbook (its `inv_…` id), the same `.env`, and a little NEAR in the settlement account if it is a named account (the registration below costs a fraction of a cent). If you used `pnpm tilll init`, the account is an implicit one and there is nothing to register.

---

## 1. Is the settlement key allowed to sign? (read-only)

```bash
pnpm tilll check
```

Look at the `settlement key` line.

- **`✓ settlement key … no registration needed`**: your settlement account is a 64-character hex id derived from the key. Nothing to register. Go to step 2.
- **`✓ settlement key … is registered`**: go to step 2.
- **`⚠ settlement key … is not registered`** (a named account such as `shopname-pay.near`): the key must be registered once, from the **account's own wallet or access key**. The check prints the exact command in the `→` line under it. It looks like this, with your account and the public key it derived:

  ```bash
  near contract call-function as-transaction intents.near add_public_key json-args '{"public_key": "ed25519:…"}' \
    prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <your account> network-config mainnet sign-with-keychain send
  ```

  This is a mainnet transaction (1 yoctoNEAR plus gas). Registering a key does not hand over the account: the key can only act inside `intents.near`. You can undo it with `remove_public_key`. Run `pnpm tilll check` again and expect `✓ settlement key … is registered`.

  (Tried on a testnet verifier on 2026-11-08: a named account's own access key registered a different key, and refunds signed by it succeeded; see `NOTES.md` section 12.)

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

## 5. Refund 1.00 USDC (real money)

```bash
curl -s -X POST http://localhost:8080/v1/invoices/$INV/refunds \
  -H "authorization: Bearer $MERCHANT_SECRET" -H 'content-type: application/json' \
  -d '{"amount":"1.00","idempotencyKey":"mainnet-test-1"}'
```

**Expect** HTTP 201 and `"status":"submitted"` with an `intentHash`. Running the same command again returns the same refund (`"replayed":true`) and sends nothing twice.

Possible errors, all safe (nothing was sent):

| `error.code` | Meaning |
|---|---|
| `intent_refused` | 1Click's intent was not the plain transfer Tilll is willing to sign. **Stop and send the message to the agent**: it names what Tilll saw (this is the one thing testnet could not show). |
| `refund_failed` with `public key … doesn't exist for account` | The key is not registered. Do step 1. |
| `insufficient_balance` | The settlement balance is below the amount. |
| `upstream_unavailable` | The NEAR RPC could not be reached. Try again. |

## 6. Watch it finish

```bash
curl -s http://localhost:8080/v1/invoices/$INV -H "authorization: Bearer $MERCHANT_SECRET"
```

Repeat every ~10 seconds. **Expect** the refund to go `submitted` then `succeeded` (about 10 seconds on the testnet; the mainnet may take longer), with `txLinks` pointing at the Base transaction, and the invoice's `refundedAmountBase` to become `1000000`.

## 7. Verify (the Phase 5 exit check)

a. **The refund shows `SUCCESS`**: `"status":"succeeded"` in step 6.
b. **The webhook arrived and verified**: terminal A prints `refund.succeeded  evt_…  (signature verified)`.
c. **The money arrived**: open the `txLinks` URL (or your wallet on Base) and confirm about 1 USDC arrived at your address.
d. **The balance fell**: repeat step 3; the balance is 1.00 lower.

## What to send back to the agent

Never secrets: the invoice id, the refund object from step 6, the `refund.succeeded … (signature verified)  1Click proof: …` line, the explorer link, and the balance before and after. With those the Phase 5 exit check is complete.

## If something goes wrong

| Symptom | What to do |
|---|---|
| Refund stays `submitted` for over 10 minutes | Ask 1Click (read-only): `curl "https://1click.chaindefuser.com/v0/status?depositAddress=<the refund's deposit address>"`. Send the output to the agent. Do not retry with a new key until it is `failed`. |
| Refund `failed` | Read its `error`. The money stays in your Intents balance (refunds are funded from it and returned to it). A new `idempotencyKey` retries. |
| You are unsure whether money moved | Check the settlement balance (step 3) and your wallet. Do not request another refund until you know. |
