# Mainnet smoke test: one real payment (you run this, not the agent)

This takes **one real payment of about 3 USDC on Base** all the way through Tilll and checks that the invoice becomes `paid` and the signed `invoice.paid` webhook reaches your server. It moves real money, so every command here is for **you** to run. The coding agent prepares it and waits.

**What it costs:** about 3.03 USDC sent from your wallet, plus a few cents of Base gas. The merchant side receives exactly the invoice amount (3.00 USDC) as an **Intents balance on your NEAR account**. Refunding it is the second runbook, `scripts/mainnet-refund.md`.

**Read this before you start**

- Pay from a wallet **you** control and use **that same wallet's Base address as your refund address**. Never use an exchange deposit address as the refund address.
- Keep `.env` private. Never paste `MERCHANT_SECRET` or `WEBHOOK_SECRET` into a chat, an issue or a screenshot. Tilll holds no key that can spend your money: you approve refunds with your own wallet.

You need: Node 22.12 or newer and pnpm; a Base wallet with about 3.5 USDC and a little ETH for gas; and a **NEAR account you control, in a wallet that can sign messages** (for example HOT, Meteor or Intear), which the money settles into and which approves the refund in the second runbook.

---

## 1. Set up

```bash
pnpm install
pnpm tilll init
```

`pnpm tilll init` makes `.env` from `.env.example` and generates `MERCHANT_SECRET` and `WEBHOOK_SECRET`. It prints no secret. It does not choose your settlement account, because that has to be one **you control**.

Now edit `.env` and set `SETTLEMENT_ACCOUNT_ID` to the NEAR account of your wallet (never a placeholder or an account you do not own: the money would be unrecoverable). Tilll will not start without it. Payments work at once. A named account registers its wallet's key with NEAR Intents once, the first time it approves a refund (second runbook); an implicit account (64 hex characters) needs nothing.

Optional settings in `.env`:

| Setting | Value |
|---|---|
| `ONECLICK_API_KEY` | A partner key from https://partners.near-intents.org. Leave empty to run without one. |

Leave `WEBHOOK_URL=http://localhost:9000/hooks/tilll`, `PUBLIC_BASE_URL=http://localhost:8080` and the rest as they are.

## 2. Check the setup (read-only)

```bash
pnpm tilll check
```

**Expect** a `✓` for `config`, `1Click`, `settlement asset`, `NEAR RPC`, `webhook` and `data directory`. One `⚠` is fine for this test: `API key`, if you set none. **Any `✗`: stop and fix it first.**

Note the line `Intents balance of <your account>: … USDC`. That is your baseline.

## 3. See the price before paying (a dry quote: nothing is created)

```bash
pnpm dry-quote -- --from base:USDC --amount 3
```

**Expect** `Payer sends` about 3.03 USDC and `Merchant receives 3 USDC`. If the fee looks wrong to you, stop here.

## 4. Start the webhook receiver (terminal A)

```bash
set -a; source .env; set +a
pnpm webhook-receiver
```

**Expect** `Webhook receiver listening on http://localhost:9000/hooks/tilll`. Leave it running.

## 5. Start Tilll (terminal B)

```bash
pnpm build:widget
pnpm start
```

**Expect** `Tilll is listening on http://localhost:8080`. Leave it running.

Optional webhook check (terminal C): `pnpm tilll check --webhook`. **Expect** `✓ webhook … accepted a signed test ping`, and terminal A prints a `ping … (signature verified)` line.

## 6. Create the invoice (terminal C)

```bash
set -a; source .env; set +a
curl -s -X POST http://localhost:8080/v1/invoices \
  -H "authorization: Bearer $MERCHANT_SECRET" -H 'content-type: application/json' \
  -d '{"amount":"3.00","description":"Tilll mainnet smoke test"}'
```

**Expect** JSON with an `id` (`inv_…`) and a `payUrl`. Note the `id`.

## 7. Pay it (a real payment)

1. Open the `payUrl` in your browser and click **Pay with crypto**.
2. Choose **USDC on Base**.
3. Enter **your own Base address** as the refund address.
4. The page shows an **exact amount** (about 3.03 USDC), a **deposit address** and a QR code. In your wallet, send that amount of **USDC on the Base network** to that address.
   - Network must be **Base**, token must be **USDC**.
   - Send the shown amount, or slightly more (1Click refunds any excess). Never less.
   - You have 30 minutes (the countdown on the page).

**Expect** the page to go `Waiting for your payment…` then `Payment detected. Confirming…` (with a transaction link) then `Payment received ✓`, typically within a minute or two.

## 8. Verify (the Phase 4 exit check)

**a. The invoice is paid.**

```bash
curl -s http://localhost:8080/v1/invoices/<invoice id> -H "authorization: Bearer $MERCHANT_SECRET"
```

**Expect** `"status":"paid"`, a `paidAttemptId`, and an attempt with `"status":"paid"` and a transaction link. (The same is in the database: `sqlite3 data/tilll.db "select id, status from invoices;"`.)

**b. The webhook arrived and was verified.** Terminal A prints a line like

```
2026-… invoice.paid  evt_…  (signature verified)
```

If it does not appear within a minute, see "If something goes wrong".

On the real 1Click the line also ends `1Click proof: verified`, which means Tilll checked 1Click's signature on the quote behind this payment (including the deposit address you paid) against 1Click's public key. If it says `NOT verified`, do not treat it as a failure of the payment, but send the agent the invoice id: it is the first time the real-payment form of the signature is checked, and a mismatch tells us the check needs adjusting.

**c. The money is in your Intents balance.**

```bash
pnpm tilll check
```

**Expect** `Intents balance of <your account>` to be your baseline **plus 3 USDC**.

**d. The transfer is on-chain.** Open the transaction link from the page or the API response in a Base explorer and confirm your transfer.

## What to send back to the agent

Only these, never secrets: the invoice id, the `status` from step 8a, the `invoice.paid … (signature verified)  1Click proof: …` line from terminal A, the `Intents balance` line from step 8c, and the explorer link. With those the Phase 4 exit check is complete.

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| `pnpm tilll check` shows `✗` | Read the line and the `→` hint under it. Fix `.env` and run it again. |
| Nothing happens after you sent | Wait 2 to 3 minutes. Then ask 1Click directly (read-only): `curl "https://1click.chaindefuser.com/v0/status?depositAddress=<deposit address>"`. |
| You sent less than the minimum | The attempt shows `underpaid`. 1Click returns the deposit to your refund address after the 30 minute deadline. Start again with a new invoice. |
| The page says the invoice expired | The 60 minute invoice or the 30 minute payment window passed. Create a new invoice. |
| Paid, but no webhook | Run `pnpm tilll check --webhook`. Check that terminal A uses the **same** `WEBHOOK_SECRET` as Tilll. Tilll retries failed deliveries after 1 min, 5 min, 30 min, 2 h and 6 h. |
| You want the money out without refunding | It sits in your own account's Intents balance, so it is yours. Moving it needs a signature from your wallet, which Tilll does not do for you. Connecting that NEAR wallet at https://near-intents.org is the normal way. |

Stop the receiver and Tilll with Ctrl+C when you are done.
