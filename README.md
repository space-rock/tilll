# Tilll

Tilll is a crypto checkout you run yourself. A customer pays with the token they already hold, on the chain they hold it, and you get paid in your own NEAR Intents account. It's open source (MIT), runs as one container on your server, and charges no fee of its own. The checkout asks the customer for no name, email or account.

Built for the NEAR HACKATHON. Tracks: Real-World Money (`realworld`) and Unstoppable DeFi (`defi`).

- Try it with no funds: the [Quick start](#quick-start-5-minutes-no-funds-needed) takes five minutes.
- See why NEAR Intents is the backbone: [How NEAR is used](#how-near-is-used) lists what it does for Tilll, with a way to check each point.
- Try the live demo shop (real payments on mainnet, cents per item): https://tilll.up.railway.app/shop
- See every payment the demo shop took, with its transactions and refunds: https://tilll.up.railway.app/invoices

## What it does

A customer opens your payment link, or a button on your site. They pick the network they're paying from, then a token on it, and give an address for refunds. They get one payment address, the exact amount and a QR code. The chains offered are the ones whose refund addresses Tilll can check (EVM chains, Solana, NEAR, Bitcoin and Tron) plus any you list in `EXTRA_CHAINS`, limited to what 1Click lists. Networks and tokens come from 1Click's token list, not from a list in Tilll. To see the checkout, run `pnpm demo` and open http://127.0.0.1:3000.

You receive exactly the invoice amount in the asset you choose (USDC on NEAR by default), in your own NEAR Intents account. The customer pays the swap fee on top. Tilll sets no `appFees`, so any fee in a quote comes from 1Click. `pnpm dry-quote --from base:USDC --amount 5` prints the quote, and its `appFees` line says `(added by 1Click)` when there is one.

The dashboard at `/dashboard` shows your balance, your invoices, the refunds waiting for your approval, and the webhook log with a resend button. Invoices export to CSV. Webhooks (`invoice.paid`, `refund.succeeded` and more) are signed with HMAC-SHA256 and retried.

You can refund a payment in full or in part. The money goes to the refund address the customer gave, on the chain and in the token they paid with, at that moment's price. Your own wallet approves every refund, so no key on your server can spend your money. A second payment on a paid invoice, or one that arrives after the invoice expired, is queued for a refund too. To try this, run `pnpm demo`, open the dashboard, pay the sample invoice and press Refund.

The checkout sets no cookie and loads nothing from other hosts. [Privacy](#privacy) also says what isn't private.

## How NEAR is used

NEAR Intents is the payment network under Tilll. Tilll runs the checkout, the records and the refunds. NEAR Intents moves the money between chains, holds it, and signs it out again. Here is what that means in practice, with something you can check for each point.

- Customers pay from 18 networks (14 EVM chains, Solana, NEAR, Bitcoin and Tron), and you receive USDC on NEAR. Tilll has no bridge, node or wallet for any of those chains. Its server has five dependencies and none is a chain SDK. See `package.json` and `STRICT_CHAINS` in `src/validate/addresses.ts`.
- Your money sits in your own account on `intents.near`, the NEAR Intents contract, and not with Tilll. The server holds no wallet and sends no NEAR transaction. It only reads. If the server disappears, the balance is still yours. Anyone can read a balance from a public RPC. This reads the live demo's balance in USDC base units (6 decimals):

  ```sh
  curl -s https://rpc.mainnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"intents.near","method_name":"mt_balance_of","args_base64":"eyJhY2NvdW50X2lkIjoidGlsbGwubmVhciIsInRva2VuX2lkIjoibmVwMTQxOjE3MjA4NjI4Zjg0ZjVkNmFkMzNmMGRhM2JiYmViMjdmZmNiMzk4ZWFjNTAxYTMxYmQ2YWQyMDExZTM2MTMzYTEifQ=="}}' | jq -r '.result.result | implode'
  ```

- A refund is a NEAR intent that your own wallet signs (NEP-413), so no key on the server can spend your money. Before your wallet sees an intent, `src/refunds/intentPolicy.ts` checks that it moves no more than the refund amount, in the settlement asset, to the deposit address of the refund quote Tilll asked for. A refund that ran on mainnet is on [NearBlocks](https://nearblocks.io/txns/48WCE2pboKEBaFkaNJsD1ry7eCjsjdW3oTi4kAsF4xoe).
- Your NEAR account is your identity. Tilll accepts a new settlement account only from a wallet that signs a challenge with a full-access key of that account, so a typo can't send money to an account nobody controls. See `src/settings/accountProof.ts`.
- You receive exactly the invoice amount, because every payment is an `EXACT_OUTPUT` quote and the customer pays the swap fee on top. Tilll uses a quote only if it is for the request it made (the same account, assets, amount and addresses), and checks 1Click's signature on it, which covers the amounts and the deposit address. All three mainnet payments came back with `"proofVerified": true`.
- It has run on mainnet across chains. A payment in USDC on Base settled into `intents.near` ([Basescan](https://basescan.org/tx/0xcc1b58a67691fa3abe1a5849d62810c8478e604a4b7c57f9882e4fd3a6a72e15)), and the live demo shop settles into `tilll.near`. Its payments are listed at https://tilll.up.railway.app/invoices.

### Under the hood

- Tilll asks the 1Click API (NEAR Intents' swap API) for a quote with `EXACT_OUTPUT`. The quote gives each payment its own deposit address and the exact amount the customer must send. Tilll polls `/v0/status` to follow it.
- Payments are quoted with `recipientType: INTENTS`. The money lands in the balance of `SETTLEMENT_ACCOUNT_ID` inside the verifier contract `intents.near`, with no on-chain transfer to you. You can read the balance with `mt_balance_of` through any NEAR RPC.
- A refund is an `EXACT_INPUT` swap funded from that balance (`depositType: INTENTS`). Tilll asks 1Click for the intent (`/v0/generate-intent`) and checks it (see [Security](#security)). Your connected wallet signs it as a NEP-413 message, and Tilll submits it (`/v0/submit-intent`). The signature check is tested against the signed example in the NEAR Intents documentation (`test/nep413.test.ts`).
- A named NEAR account such as `shopname-pay.near` registers its wallet's key on `intents.near` once (`add_public_key`). The dashboard does it the first time the wallet approves a refund. An implicit account (64 hex characters, made from its key) needs nothing.
- NEAR Intents accepts `ed25519`, `secp256k1` and `p256` keys. NEAR also has post-quantum account keys (ML-DSA-65). The verifier doesn't accept them yet, so a wallet account that uses one can't approve refunds until it does.

## Quick start (5 minutes, no funds needed)

You need Node 22.12 or newer (tested on Node 26; Node 20 is end-of-life and the SQLite driver needs 22), [pnpm](https://pnpm.io), and Docker if you want the container. Nothing below sends or needs any money.

1. Get the code and install.
   ```bash
   git clone https://github.com/space-rock/tilll tilll && cd tilll
   pnpm install
   ```
2. Make `.env`.
   ```bash
   pnpm tilll init
   ```
   You see `Created .env from .env.example.` and two lines saying `MERCHANT_SECRET` and `WEBHOOK_SECRET` were generated. No secret is printed. They're in `.env`, readable only by you and ignored by git. Running it again changes nothing. It also warns that `SETTLEMENT_ACCOUNT_ID` is empty, and Tilll won't start until you set it. Open `.env` and set it to a mainnet NEAR account you control, the one whose wallet you will connect in the dashboard:
   ```bash
   SETTLEMENT_ACCOUNT_ID=your-account.near
   ```
   Nothing is sent to that account or taken from it by starting Tilll. With no NEAR account, skip to steps 7 and 8: the tests and `pnpm demo` need no `.env` and no account.
3. Start Tilll.
   ```bash
   docker compose up --build
   ```
   The first build takes a few minutes. You see `Tilll is listening on http://localhost:8080`. Without Docker, run `pnpm build && pnpm start:prod`.
4. Open the dashboard at http://localhost:8080/dashboard and log in with the value of `MERCHANT_SECRET` in `.env` (`grep ^MERCHANT_SECRET .env`). You see the overview. Click Create invoice, then open the pay link it shows. The hosted checkout page for that invoice appears. Don't pay it unless you want to move real money. The runbooks [`scripts/mainnet-smoke.md`](scripts/mainnet-smoke.md) and [`scripts/mainnet-refund.md`](scripts/mainnet-refund.md) do that on purpose.
5. Check the installation (read-only).
   ```bash
   pnpm tilll check
   ```
   You see a `✓` for config, 1Click, the settlement asset, NEAR RPC, the settlement account, webhook and data directory, and a `⚠` for the optional API key. Any `✗` says what to fix.
6. See a live quote (a `dry: true` quote, so nothing is created).
   ```bash
   pnpm dry-quote --from base:USDC --amount 5
   ```
   You see what the payer would send for a 5 USDC invoice, the fees, and what you would receive.
7. Run the tests (mocks only, no network).
   ```bash
   pnpm test
   ```
   Every test passes. They include a full run of pay, paid, refund and refunded against a mock 1Click that speaks the real HTTP API (`test/integration-refunds.test.ts`), the duplicate and late payment cases (`test/integration.test.ts`), and the dashboard.
8. Try the whole thing against a mock payment network.
   ```bash
   pnpm demo
   ```
   You see the URLs of a demo shop, a hosted pay page and the dashboard, and the dashboard login secret. Pay in the shop with any well-formed address (for example `0x1111111111111111111111111111111111111111` on an EVM chain). The mock payer "sends" the money a few seconds later. Then open the invoice in the dashboard and press Refund. No real funds move.

To receive webhooks while running in Docker, point `WEBHOOK_URL` at your server. For a receiver on this machine, use `http://host.docker.internal:9000/hooks/tilll` and run `pnpm webhook-receiver`. It prints each event and whether its signature verified.

## Refunds

A refund is a new swap at the current price. If a customer paid 0.05 SOL for a $5 item, they get about $5 of SOL back, minus route fees. Refunds return the value at today's price, so the customer may receive a different amount than they paid. The dialog and `POST .../refunds/preview` show what they would receive before you confirm.

- It goes to the refund address the customer gave at checkout, on the chain and in the token they paid with.
- Partial refunds are allowed up to the invoice amount. The server enforces `REFUND_MAX_PER_TX` and `REFUND_MAX_PER_DAY`, and every refund needs an `idempotencyKey`.
- It's paid from your Intents balance, so the balance must cover it. If a refund fails, the money is still in your balance.
- Your wallet approves every refund. A refund you ask for, in the dashboard or with `POST /v1/invoices/:id/refunds`, is saved as `awaiting_approval`, and Tilll sends a `refund.awaiting_approval` event. Nothing is quoted or signed until you open the dashboard and approve it with the connected wallet. It's prepared at that moment, because quotes and intents expire. If the wallet won't sign, or 1Click turns the intent down, the refund waits and you can try again or cancel it (`POST /v1/refunds/:id/cancel`).
- Duplicate and late payments wait for you too. 1Click returns only swaps that fail. A second payment on a paid invoice, or one that arrives after it expired, is a swap that worked, so the money is already in your balance and you have to send it back. Tilll queues a refund for the full amount to the address that payment came from, sends `payment.duplicate` and `refund.awaiting_approval`, and shows it under Needs your attention until you approve it.

## Privacy

- The checkout asks for no account, name or email. The payer chooses a token and gives a refund address.
- It sets no cookie and keeps nothing in the browser. The widget never reads or writes cookies or browser storage, and no page or call a payer makes sets a cookie. Only the dashboard does, for its login session. `pnpm test test/privacy.test.ts` passes, or you can run `pnpm demo`, open the hosted pay page and see that the cookies and storage in your browser's developer tools are empty.
- The checkout loads nothing from other hosts. The pay page's Content-Security-Policy lets it talk only to the Tilll server it came from (`connect-src 'self'`), and the project site loads nothing from other hosts either. The dashboard has one exception, below.
- Token and network images ship with Tilll. `public/icons` holds a snapshot of the images NEAR Intents' explorer shows (the logos belong to their projects), and Tilll serves them from your own address, so a payer's browser never contacts anyone else. Your server may fetch one thing from outside: an image for a token that 1Click lists and the snapshot lacks. A minute after start, and then daily, it downloads each missing image once from NEAR Intents' explorer (`explorer.near-intents.org`) and keeps it in `DATA_DIR/icons`. The requests name no payer and no invoice. The explorer publishes no icon API or terms, so this is best effort. If its files move, or there is no way out, those tokens show a letter badge. Which picture a token gets follows the explorer's own choices, in a table at `public/icons/token-map.json` that `pnpm icons:update` reads from the explorer's public browser script, since its source isn't published. wNEAR shows NEAR's logo, and a token the explorer shows nothing for gets a letter. Only plain images are kept (an SVG only if it has no script, handler or outside link). `pnpm icons:update` refreshes the snapshot, `pnpm demo` shows real images with no network, and `pnpm test test/icons-snapshot.test.ts` passes.
- The dashboard loads wallet code when you connect a wallet. The wallet connector (near-connect) is downloaded only when you press Connect wallet, or when a wallet you connected before is restored. It then fetches the list of wallets, and each wallet's code, from the hosts that library names, and runs that code in sandboxed frames. For that, and only on `/dashboard`, the Content-Security-Policy allows a script nonce (new on every page response), `connect-src https:`, `img-src https:` and `frame-src https:` (a wallet such as Intear opens its own page in a frame inside a sandboxed frame that can't reach the dashboard). The pay page and the checkout keep their strict policies, and a payer never loads any of this. The dashboard keeps two hints in the browser (`tilll-theme` and `tilll-wallet`, so it can reconnect your wallet). They hold no account, key or secret. Fonts and icons are served from your own address.
- Payments aren't confidential. Each customer deposit is a public transaction, and anyone can read your settlement balance (`mt_balance_of` on `intents.near`), because Tilll uses NEAR Intents' public balance and not its invite-only Confidential Intents. The checkout is private. The money isn't.
- NEAR Intents' 1Click API routes the payments and sees each quote request, including the refund address. Your own database keeps invoices, payment attempts and refund addresses on your server.

## Embed

Your server creates the invoice (with the merchant secret, which never goes to a browser), then your page opens the checkout for it:

```html
<script src="https://pay.example.com/checkout.js"></script>
<button data-tilll-invoice="inv_...">Pay with crypto</button>
```

- `data-tilll-invoice="<invoice id>"` on any element opens the checkout as a dialog.
- `<div data-tilll-inline="<invoice id>"></div>` renders it in the page. The hosted page at `/pay/<invoice id>` is exactly this, for merchants who don't embed anything.
- `Tilll.open({ invoiceId, onPaid })` does the same from code.
- The widget talks only to the server it was loaded from, so the 1Click API key never reaches a browser. Set `ALLOWED_ORIGINS` to your shop's origin or origins so only your site can call `/pay/*`.
- If your page sets a Content-Security-Policy, allow your Tilll address in `script-src` (the script), `connect-src` (its calls) and `img-src` (the token and network images; without it the checkout shows letter badges instead). Run `pnpm demo`, then `curl -sI http://127.0.0.1:3000/`. The demo shop's `content-security-policy` header does exactly this.

`pnpm demo` serves a demo shop (`demo-store/`) that embeds the checkout this way.

### Integration security

The checkout receives only an invoice id. The amount is fixed when your server creates the invoice with `MERCHANT_SECRET`, and the public `/pay/*` endpoints accept only a token and a refund address. A customer can't change what an invoice costs. To keep it that way, your integration has to meet four requirements:

1. Set amounts on your server. Create each invoice there, from your own catalogue. Never expose an endpoint that takes the amount from the browser.
2. Link each invoice to an order. Save the invoice id on the order. When a payment arrives, look the order up by that id in your own database, not by an id the browser sends, and check the amount against the order total.
3. Fulfil from webhooks, not from client callbacks. Fulfil an order only after a verified `invoice.paid` webhook, or after your server reads the invoice and finds it `paid`. `onPaid` runs in the browser and can be spoofed.
4. Keep secrets on your server. Never put `MERCHANT_SECRET` in page code. A site with no server can still sell: create each invoice in the dashboard and share its payment link.

## Configuration

Settings are environment variables, read from `.env`. `pnpm tilll init` fills the secrets, and everything else has a default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on. |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Where customers reach Tilll; used in pay links (a trailing slash is dropped). https makes the dashboard cookie `Secure`. A starting value: you can change it in the dashboard. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `TRUST_PROXY` | `false` | Whom to believe about where a request came from (`X-Forwarded-For`). Set `1` when exactly one reverse proxy sits in front of Tilll; see [Security](#security). |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call `/pay/*`, each a scheme and host such as `https://shop.example.com` (no path; a trailing slash is dropped). Set your shop's origin in production. |
| `ONECLICK_BASE_URL` | `https://1click.chaindefuser.com` | The 1Click API. |
| `ONECLICK_API_KEY` | empty | Optional partner key, sent as `X-API-Key`. Without one, 1Click may add a platform fee to quotes; `pnpm dry-quote` prints what applies to a route as `appFees`. |
| `SETTLEMENT_ACCOUNT_ID` | none: you set it | The NEAR account whose Intents balance receives the money. Tilll won't start without it. A starting value: you can change it in the dashboard. |
| `SETTLEMENT_ASSET_ID` | USDC on NEAR | What you are paid in: any asset 1Click lists. Checked against 1Click's token list at startup. A starting value: you can change it in the dashboard. |
| `MERCHANT_SECRET` | made by `tilll init` | Bearer secret for `/v1/*` and the dashboard login. |
| `WEBHOOK_URL` | `http://localhost:9000/hooks/tilll` | Where webhooks are sent. A starting value: you can change it in the dashboard. |
| `WEBHOOK_SECRET` | made by `tilll init` | Signs webhooks. |
| `INTENTS_CONTRACT` | `intents.near` | The verifier contract. |
| `NEAR_RPC_URL` | `https://rpc.mainnet.near.org` | Any public NEAR RPC; used for balance and key checks. |
| `ATTEMPT_DEADLINE_MINUTES` | `30` | How long a payer has. Bitcoin-like chains always get 120. A starting value: you can change it in the dashboard. |
| `SLIPPAGE_BPS` | `100` | Slippage tolerance, in basis points. A starting value: you can change it in the dashboard. |
| `EXTRA_CHAINS` | empty | More chains to offer at checkout beyond those with address checks, for example `ltc,doge`. |
| `MEMO_CHAINS` | `stellar` | Chains whose deposits need a memo. |
| `REFUND_MAX_PER_TX` | `50` | Largest single refund, in settlement asset units. A starting value: you can change it in the dashboard. |
| `REFUND_MAX_PER_DAY` | `200` | Most you can refund in a UTC day (refunds of duplicate and late payments don't count). A starting value: you can change it in the dashboard. |

A bad setting stops startup with a message that names the setting and never its value. Every URL setting must be http or https.

### Changing settings in the dashboard

The settlement account and asset, the public URL, the webhook URL, the payment window, slippage and the two refund limits can be changed on the dashboard's Settings page. The change applies at once, with no restart. `.env` gives the starting values. A value saved in the dashboard is stored in the database and wins from then on, even if you edit `.env` later. Each row says which one it comes from, "Reset to .env value" goes back, and Tilll prints one line at start for each value that overrides `.env`. The page lists the latest changes, and each one sends a `settings.updated` event. Secrets, ports, URLs of services and the verifier contract stay in `.env`.

Two changes move money, so they have rules:

- A new settlement account must be one you control. The dashboard asks the connected wallet to sign a message for that account, and Tilll accepts it only from a full-access ed25519 key of that account.
- A new settlement asset needs new refund limits in the same save, because the old ones are in the old asset's units.

Both are refused while a refund is still open or an open invoice has a payment under way. They apply to new invoices only. An invoice keeps the account and asset it was made with and is still paid there. Tilll can't refund such an invoice after the change, because the refund would come from the new account's balance. Send it from the old account's wallet.

## API

`/v1/*` needs `Authorization: Bearer <MERCHANT_SECRET>` (the dashboard uses a session cookie instead). Amounts are strings in display units (`"5.00"`), and responses carry both display and base-unit amounts. Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/invoices` | Create an invoice: `{ amount, description?, metadata?, expiresInMinutes? }`. Returns the invoice and its `payUrl`. |
| GET | `/v1/invoices` | List, newest first: `?status=&q=&limit=&cursor=`. `q` searches id, description and metadata. |
| GET | `/v1/invoices/:id` | The invoice with its attempts and refunds. |
| POST | `/v1/invoices/:id/cancel` | Cancel an open invoice with no payment on the way. |
| POST | `/v1/invoices/:id/refunds/preview` | A dry quote of a refund: what the customer would receive, where. `{ amount? }` |
| POST | `/v1/invoices/:id/refunds` | Ask for a refund: `{ amount?, idempotencyKey }`. It is saved as `awaiting_approval`; nothing is sent until the wallet approves it. The same key returns the same refund. |
| GET | `/v1/refunds` | Every refund, newest first: `?status=&limit=&cursor=`. Also returns the count in each status. |
| GET | `/v1/refunds/:id` | One refund. |
| POST | `/v1/refunds/:id/prepare` | Get a fresh, checked intent for the wallet to sign. Returns `payload`, `signerId`, `expiresAt` and a summary. |
| POST | `/v1/refunds/:id/submit` | Send the wallet's signature: `{ publicKey, signature }`. The server sends 1Click the payload it kept, never one from the request. |
| POST | `/v1/refunds/:id/cancel` | Cancel a refund that is still `awaiting_approval`. |
| GET | `/v1/balance` | The settlement balance. |
| GET | `/v1/overview` | Balance, paid today, refunded today against the limit, open invoices. |
| GET | `/v1/tokens` | The tokens the checkout offers, by chain. |
| GET | `/v1/webhooks` | The webhook log. |
| POST | `/v1/webhooks/:id/resend` | Send an event again. |
| POST | `/v1/webhooks/test` | Send a `ping` to the webhook URL now. Returns the status, the error if any, and how long it took. |
| GET | `/v1/settings` | How Tilll is set up (never a secret), where each value comes from, and the latest changes. |
| PATCH | `/v1/settings` | Change settings, all or none: `{ slippageBps?, attemptDeadlineMinutes?, webhookUrl?, publicBaseUrl?, refundMaxPerTx?, refundMaxPerDay?, settlementAssetId? }`. A new asset needs both limits in the same request. |
| POST | `/v1/settings/account-challenge` | Start changing the settlement account: `{ accountId }`. Returns a message for that account's wallet to sign. |
| PUT | `/v1/settings/account` | Finish it: `{ accountId, nonce, publicKey, signature }`. |
| DELETE | `/v1/settings/:key` | Go back to the `.env` value of one setting (`settlementAccount`, `settlementAsset`, `slippageBps`, `attemptDeadlineMinutes`, `webhookUrl`, `publicBaseUrl`, `refundMaxPerTx`, `refundMaxPerDay`). Resetting the asset resets the limits too. |
| GET | `/pay/:invoiceId` | The hosted checkout page. |
| GET | `/pay/invoices/:id` | Public invoice info. |
| GET | `/pay/tokens` | The tokens, for the widget. |
| POST | `/pay/invoices/:id/attempts` | Start a payment: `{ originAsset, refundTo }`. Limited to 5 per invoice per 10 minutes. |
| GET | `/pay/attempts/:id` | A payment's status. |
| POST | `/pay/attempts/:id/tx` | Tell Tilll the deposit's transaction hash, to speed up detection. |

To create an invoice:

```bash
set -a; source .env; set +a
curl -s -X POST http://localhost:8080/v1/invoices \
  -H "authorization: Bearer $MERCHANT_SECRET" -H 'content-type: application/json' \
  -d '{"amount":"5.00","description":"Test"}'
```

You get JSON with an `id` and a `payUrl`.

## Webhooks

Tilll POSTs JSON to `WEBHOOK_URL`:

```json
{ "id": "evt_...", "type": "invoice.paid", "createdAt": "...", "data": { "invoice": {}, "attempt": {} },
  "proof": { "oneclickQuoteSignature": "...", "oneclickCorrelationId": "..." }, "proofVerified": true }
```

Events: `invoice.paid`, `invoice.expired`, `invoice.canceled`, `payment.underpaid`, `payment.refunded_by_network`, `payment.failed`, `payment.duplicate`, `refund.awaiting_approval`, `refund.succeeded`, `refund.failed`, `settings.updated`, `ping`.

- Events about a payment or a refund carry the signature 1Click put on the quote behind it (`proof`), and `proofVerified`. That field says whether Tilll checked the signature against 1Click's published public key (`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`, from 1Click's TypeScript SDK) and found the quote unchanged. `false` means it didn't verify. That's expected for a mock or a test network, because they sign with their own key, and it's a reason to look closer on the real 1Click. The signature covers the amounts, the deposit address and memo, and the addresses and assets of the request. It does not cover a status value, so `proofVerified` says the quote is genuine, not that the swap succeeded. Events with no quote behind them (`invoice.expired`, `invoice.canceled`, `ping`) carry neither field. The dashboard shows the same verdict on each payment attempt.
- The signature is in the header `Tilll-Signature: t=<unix seconds>,v1=<hex>`. `v1` is the HMAC-SHA256, keyed with `WEBHOOK_SECRET`, of `"<t>.<raw body>"`. Verify it over the exact bytes you received and reject a timestamp more than five minutes old. [`demo-store/webhook-receiver.ts`](demo-store/webhook-receiver.ts) is a 20-line verifier to copy.
- Delivery is at least once, so dedupe on the `Tilll-Event-Id` header. Any 2xx counts as delivered. Tilll retries after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then stops (the dashboard shows it, and you can resend).

To see one, run `set -a; source .env; set +a; pnpm webhook-receiver` in one terminal and `POST /v1/webhooks/test` (with the bearer secret) in another. The receiver prints `ping ... (signature verified)`.

## Security

- Tilll holds no key that can spend your balance. Refunds are signed in your wallet, in your browser, so reading `.env` or the database gives an attacker no way to move the money already in your balance. `REFUND_MAX_PER_TX` and `REFUND_MAX_PER_DAY` still limit what the dashboard and API can ask for.
- `MERCHANT_SECRET` is still a password. Whoever has it can create and cancel invoices, queue refunds for your approval, and change the settings, including the account that new invoices are paid to (they only have to sign for an account of their own). Keep it on your server, and change it if it leaks. Invoices made before a change are still paid to the account they were made with.
- The wallet has to be the settlement account's. The dashboard refuses a wallet signed in as another account, and the server verifies the signature and checks that the key is registered for the settlement account before it sends anything to 1Click. It only ever sends the payload it kept, never one from the browser.
- Tilll checks what 1Click hands it before your wallet sees it. A quote that names another account, asset, amount or address than Tilll asked for is refused, for payments and refunds alike (`quoteMismatch` in `src/oneclick/requests.ts`). Your wallet is asked to sign only a transfer of exactly the refund amount to the refund quote's own deposit address (or a swap that spends only the settlement asset, up to that amount). The verifier, the signer and a deadline that is no later than the refund quote's own (and never more than 7 days away) must match. Every other intent kind (withdrawals, key changes, anything unknown) is refused. `test/intent-policy.test.ts` shows each case.
- Secrets live only in `.env` (owner-readable, git-ignored) and are never printed, logged, or sent to a browser. The widget talks only to Tilll, never to 1Click.
- The dashboard uses an HttpOnly, SameSite=Strict session cookie, a login limited to 10 tries a minute, a CSRF token on every write, and a Content-Security-Policy that allows nothing by default (the one relaxation, for the wallet connector, is described under [Privacy](#privacy)). Changing `MERCHANT_SECRET` ends every session.
- Public endpoints are rate limited and validate every input. SQL is parameterized.
- Tilll listens on `0.0.0.0` inside the container, and `docker-compose.yml` publishes it on `127.0.0.1` only. To make it public, put a reverse proxy with https in front, set `PUBLIC_BASE_URL` to the https address, and set `TRUST_PROXY=1`. Without that, Tilll sees every visitor as the proxy's address, so the rate limits (120 requests a minute on `/pay`, 10 login tries a minute) are shared by everyone. One busy visitor, or one person guessing the login, would block the rest. `TRUST_PROXY` takes `false` (the default), a number of proxies (`1` to `10`), or a list of proxy addresses (`10.0.0.0/8,192.168.1.5`, or `loopback`). A number is only safe when Tilll can be reached through those proxies and nothing else, which is what the loopback-only port gives you. With a list, `X-Forwarded-For` is believed only from those addresses. `true` believes any sender and is for a Tilll that can't be reached except through the proxy. The proxy must set `X-Forwarded-For` (and `Host`, or `X-Forwarded-Host`) to what it received.

## What is verified, and how

| Claim | How it is checked | Status |
|---|---|---|
| Invoices, attempts, the status mapping, underpaid, expired, duplicate and late-paid paths | `pnpm test`: unit tests and integration tests through a mock 1Click over real HTTP | Passing |
| Refunds: preview, caps, idempotency, the signature, success and failure | `pnpm test` (refund tests) | Passing |
| The server hands the wallet nothing but the refund it asked for, and sends 1Click only the payload it kept | `test/intent-policy.test.ts` (every other intent kind is refused) and `test/refunds.approval.test.ts` | Passing |
| The NEP-413 signature is what the verifier expects | `test/nep413.test.ts` verifies the signed example printed in the NEAR Intents docs | Passing |
| The 1Click request and response shapes | A recorded live quote is a test fixture; `pnpm dry-quote` makes a live `dry: true` quote | Passing |
| 1Click's signature on a quote verifies | `test/quote-signature.test.ts` verifies the recorded live quote against 1Click's public key (this checks the key and the scheme against real data, and that changing any signed field breaks it) | Passing for a `dry: true` quote |
| The same for the quote of a real payment (the deposit address and memo are signed too) | The mainnet payments of 2026-11-13: each `invoice.paid` event says `"proofVerified": true` | Passing: 3 of 3 real payments verified |
| Webhook signatures | `test/webhook-signature.test.ts`; `pnpm webhook-receiver` verifies them | Passing |
| A real payment and a real refund on mainnet | Run on 2026-11-13 with the runbooks [`scripts/mainnet-smoke.md`](scripts/mainnet-smoke.md) and [`scripts/mainnet-refund.md`](scripts/mainnet-refund.md): three payments (two from NEAR, one from Base) and one refund, each with its transaction in [`brand/mainnet-recording/shots.md`](brand/mainnet-recording/shots.md). The live demo shop keeps taking real payments, listed at [`/invoices`](https://tilll.up.railway.app/invoices) | Passing |
| Whether mainnet payments are confidential, and the exact intent 1Click returns on mainnet | Checked on 2026-11-13: the quotes say `confidentiality: public`, and the merchant's balance is readable by anyone (`mt_balance_of` on `intents.near`), so payments are not confidential. The refund intent is a plain `transfer` | Answered, see [`NOTES.md`](NOTES.md) |

Every finding behind a design choice is written down with its source in [`NOTES.md`](NOTES.md).

## Libraries used

Runtime (the server):

| Library | Used for |
|---|---|
| [fastify](https://fastify.dev) | The HTTP server |
| [@fastify/cors](https://github.com/fastify/fastify-cors) | CORS for `/pay/*` |
| [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) | Rate limits on public endpoints and login |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | The SQLite database |
| [zod](https://zod.dev) | Validating configuration and requests |

Build and development only (nothing here runs in production; the widget and dashboard are compiled to static files):

| Library | Used for |
|---|---|
| [typescript](https://www.typescriptlang.org) | Type checking and compiling the server |
| [tsx](https://tsx.is) | Running TypeScript scripts (`pnpm start`, `pnpm demo`, the CLI) |
| [esbuild](https://esbuild.github.io) | Bundling the checkout widget |
| [qrcode](https://github.com/soldair/node-qrcode) | QR codes, bundled into the widget |
| [react](https://react.dev), [react-dom](https://react.dev) | The dashboard |
| [lucide-react](https://lucide.dev) | The dashboard's icons, bundled as inline SVG |
| [@fontsource-variable/inter](https://fontsource.org/fonts/inter), [@fontsource-variable/manrope](https://fontsource.org/fonts/manrope), [@fontsource-variable/jetbrains-mono](https://fontsource.org/fonts/jetbrains-mono) | The dashboard's fonts, served from your own address |
| [@hot-labs/near-connect](https://github.com/hot-dao/near-selector) | Connecting a NEAR wallet in the dashboard. Loaded only when you connect a wallet |
| [vite](https://vite.dev), [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | Building the dashboard |
| [tailwindcss](https://tailwindcss.com), [@tailwindcss/vite](https://tailwindcss.com/docs/installation/using-vite) | The dashboard's styles |
| [vitest](https://vitest.dev) | Tests |
| [happy-dom](https://github.com/capricorn86/happy-dom) | A browser-like environment for widget and dashboard tests |
| [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) | Dashboard component tests |
| [oxlint](https://oxc.rs/docs/guide/usage/linter), [oxfmt](https://oxc.rs/docs/guide/usage/formatter) | Lint and format |
| `@types/better-sqlite3`, `@types/node`, `@types/qrcode`, `@types/react`, `@types/react-dom` | Type definitions |

Tooling: [pnpm](https://pnpm.io) (package manager) and [Docker](https://www.docker.com) with the official `node` image. Services: the 1Click API and the NEAR Intents verifier contract (`intents.near`) through a NEAR RPC, and, for token and network images, NEAR Intents' explorer (`explorer.near-intents.org`). The NEP-413 signing, Borsh encoding, base58 and the NEAR RPC calls are written in this repository (`src/near/`), using only Node's `crypto`.

## Project site

`site/` is the project's website: a landing page (`index.html`) and a docs page (`docs.html`) that covers running Tilll, adding the checkout and verifying payments. It's plain HTML and CSS built with Tailwind, it sets no cookies and it loads nothing from another host. The server doesn't serve it.

To see it, run `pnpm build:site`, then `pnpm preview:site`. The site is at the address the command prints, and the built files are in `site/dist/`.

The links on the site (`github`, `demoVideo`, `liveDemo`) are read from `site/links.json` when it's built. A link that isn't set is left out of the page.

## License

MIT. See [LICENSE](LICENSE).

## Other NEAR Hackathon submission

[Contagion ($FLU)](https://github.com/space-rock/contagion) is a NEAR memecoin that spreads like a flu. You can't buy it. You have to catch it.
