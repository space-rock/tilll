# Tilll

Self-hosted, open-source crypto checkout on NEAR Intents.

Accept crypto from every major chain and settle in your own account. A customer pays with the token they already hold, on the chain they hold it; you receive the asset you choose (USDC on NEAR by default) in your own NEAR Intents account. Tilll is a payment server you run yourself: one container, your own keys, no hosted middleman, no sign-up, and no fee from Tilll. The checkout asks the payer for no name, email or account.

> Status: version 0.1, early software. Everything below marked "Try it" can be reproduced from a clean clone. [What is verified, and how](#what-is-verified-and-how) says plainly what has and has not been tried against real money.

## What it does

- **Takes payment from other chains.** The checkout offers the chains whose refund addresses Tilll can check (EVM chains, Solana, NEAR, Bitcoin, Tron) and any more you list in `EXTRA_CHAINS`, limited to what 1Click lists. The customer picks a network, then a token on it, gives a refund address, and gets a deposit address, an exact amount and a QR code. Networks and tokens come from 1Click's token list, not from a list in Tilll. *Try it:* `pnpm demo`, then open http://127.0.0.1:3000.
- **Settles into your NEAR Intents balance.** You receive exactly the invoice amount in the settlement asset (USDC on NEAR by default). The customer pays the swap fee on top.
- **Runs on your server.** One container and a SQLite file, your keys, no account with Tilll. *Try it:* the [Quick start](#quick-start-5-minutes-no-funds-needed) below.
- **Keeps the checkout private.** No name, email or account is asked for, no cookie is set, and nothing is loaded from other hosts. See [Privacy](#privacy), which also says what is not private.
- **Protects the settlement key.** It stays on your server, what Tilll signs is checked first, and what the dashboard and API can send is capped. See [Security](#security).
- **Takes no fee of its own.** Tilll sets no `appFees`; a fee in a quote comes from 1Click, and the customer pays the swap fee on top. *Try it:* `pnpm dry-quote --from base:USDC --amount 5` and read the `appFees` line, which says `(added by 1Click)` when there is one.
- **Has a merchant dashboard** at `/dashboard`: balance, invoices, refunds, webhook log with resend, CSV export.
- **Signs webhooks** (`invoice.paid`, `refund.succeeded`, and more) with HMAC-SHA256, and retries them.
- **Refunds a payment, in full or in part,** to the customer's refund address on the chain and in the token they paid with. The refund is the value at that moment's price, not the original token count. *Try it:* `pnpm demo`, open the dashboard, pay the sample invoice, press **Refund**.
- **Refunds duplicate and late payments by itself.** A second payment on a paid invoice, or one that arrives after the invoice expired, goes back in full.

## How NEAR is used

- **1Click API** (NEAR Intents' swap API): a quote with `EXACT_OUTPUT` gives each payment attempt its own deposit address and the exact amount the customer must send; `/v0/status` is polled to follow it.
- **Your NEAR Intents account:** payments are quoted with `recipientType: INTENTS`, so the money lands in the balance of `SETTLEMENT_ACCOUNT_ID` inside the verifier contract `intents.near`, with no on-chain transfer to you. The balance is read with `mt_balance_of` through any NEAR RPC.
- **Refunds are signed intents.** A refund is an `EXACT_INPUT` swap funded from that balance (`depositType: INTENTS`). Tilll asks 1Click for the intent (`/v0/generate-intent`), checks it (see [Security](#security)), signs it with your settlement key as a NEP-413 message, and submits it (`/v0/submit-intent`). The signature code is checked against the signed example in the NEAR Intents documentation (`test/nep413.test.ts`).
- **Key registration:** a *named* NEAR account (`shopname-pay.near`) must register the signing key on `intents.near` once (`add_public_key`); an *implicit* account (64 hex characters, made from the key) needs nothing. `pnpm tilll init` makes the second kind, `pnpm tilll key` shows how to do the first.

## Quick start (5 minutes, no funds needed)

You need Node 22.12 or newer (tested on Node 26; Node 20 is end-of-life and the SQLite driver needs 22), [pnpm](https://pnpm.io), and Docker if you want the container. Nothing below sends or needs any money.

1. **Get the code and install.**
   ```bash
   git clone <this repository> tilll && cd tilll
   pnpm install
   ```
2. **Make `.env`.**
   ```bash
   pnpm tilll init
   ```
   You see `Created .env from .env.example.` and four lines saying `MERCHANT_SECRET`, `WEBHOOK_SECRET`, `SETTLEMENT_PRIVATE_KEY` and `SETTLEMENT_ACCOUNT_ID` were generated. No secret is printed; they are in `.env`, readable only by you and ignored by git. Running it again changes nothing.
3. **Start Tilll.**
   ```bash
   docker compose up --build
   ```
   The first build takes a few minutes. You see `Tilll is listening on http://localhost:8080`. (Without Docker: `pnpm build && pnpm start:prod`.)
4. **Open the dashboard** at http://localhost:8080/dashboard. Log in with the value of `MERCHANT_SECRET` in `.env` (`grep ^MERCHANT_SECRET .env`). You see the overview. Click **Create invoice**, then open the pay link it shows: the hosted checkout page for that invoice appears. (Do not pay it; see [Real payment](#real-payment-mainnet).)
5. **Check the installation** (read-only):
   ```bash
   pnpm tilll check
   ```
   You see a `✓` for config, 1Click, the settlement asset, NEAR RPC, the settlement key ("implicit account, no registration needed"), webhook and data directory, and a `⚠` for the optional API key. Any `✗` says what to fix.
6. **See a live quote** (a `dry: true` quote: nothing is created):
   ```bash
   pnpm dry-quote --from base:USDC --amount 5
   ```
   You see what the payer would send for a 5 USDC invoice, the fees, and what you would receive.
7. **Run the tests** (mocks only, no network):
   ```bash
   pnpm test
   ```
   Every test passes. They include a full pay → paid → refund → refunded run against a mock 1Click that speaks the real HTTP API (`test/integration-refunds.test.ts`), the duplicate and late payment cases (`test/integration.test.ts`), and the dashboard.
8. **Try the whole thing against a mock payment network:**
   ```bash
   pnpm demo
   ```
   You see the URLs of a demo shop, a hosted pay page and the dashboard, and the dashboard login secret. Pay in the shop with any well-formed address (for example `0x1111111111111111111111111111111111111111` on an EVM chain); the mock payer "sends" the money a few seconds later. Then open the invoice in the dashboard and press **Refund**. No real funds move.

To receive webhooks while running in Docker, point `WEBHOOK_URL` at your server; for a receiver on this machine use `http://host.docker.internal:9000/hooks/tilll` and run `pnpm webhook-receiver` (it prints each event and whether its signature verified).

## What is verified, and how

| Claim | How it is checked | Status |
|---|---|---|
| Invoices, attempts, the status mapping, underpaid / expired / duplicate / late-paid paths | `pnpm test`: unit tests and integration tests through a mock 1Click over real HTTP | Passing |
| Refunds: preview, caps, idempotency, the signature, success and failure | `pnpm test` (refund tests) | Passing |
| The server refuses to sign anything but the refund it asked for | `test/intent-policy.test.ts` (every other intent kind is refused) | Passing |
| NEP-413 signature is what the verifier expects | `test/nep413.test.ts` verifies the signed example printed in the NEAR Intents docs | Passing |
| The 1Click request and response shapes | A recorded live quote is a test fixture; `pnpm dry-quote` makes a live `dry: true` quote | Passing |
| 1Click's signature on a quote verifies | `test/quote-signature.test.ts` verifies the recorded live quote against 1Click's public key (this checks the key and the scheme against real data, and that changing any signed field breaks it) | Passing for a `dry: true` quote |
| The same for the quote of a real payment (deposit address and memo are signed too) | The first mainnet payment: its `invoice.paid` event should say `"proofVerified": true` | Not yet run by the author |
| Webhook signatures | `test/webhook-signature.test.ts`; `pnpm webhook-receiver` verifies them | Passing |
| This README's commands, routes, settings and library list | `test/readme.test.ts` | Passing |
| A real payment and a real refund on mainnet | Runbooks: [`scripts/mainnet-smoke.md`](scripts/mainnet-smoke.md) and [`scripts/mainnet-refund.md`](scripts/mainnet-refund.md), run by a person with their own funds | Not yet run by the author |
| Whether mainnet's confidential settlement credits a public balance, and the exact intent 1Click returns on mainnet | Only the mainnet runbooks can show it | Not yet known |

Every finding behind a design choice is written down with its source in [`NOTES.md`](NOTES.md).

## Real payment (mainnet)

About 3 to 5 dollars of USDC on Base, from a wallet you control. [`scripts/mainnet-smoke.md`](scripts/mainnet-smoke.md) walks through it: create an invoice, pay it, watch it reach `paid` and the signed `invoice.paid` webhook arrive. [`scripts/mainnet-refund.md`](scripts/mainnet-refund.md) then refunds it and checks the money arrives back. Both are for you to run: they move real money.

## Embed

Your server creates the invoice (with the merchant secret, which never goes to a browser), then your page opens the checkout for it:

```html
<script src="https://pay.example.com/checkout.js"></script>
<button data-tilll-invoice="inv_...">Pay with crypto</button>
```

- `data-tilll-invoice="<invoice id>"` on any element opens the checkout as a dialog.
- `<div data-tilll-inline="<invoice id>"></div>` renders it in the page. The hosted page at `/pay/<invoice id>` is exactly this, for merchants who do not embed anything.
- `Tilll.open({ invoiceId, onPaid })` does the same from code.
- The widget talks only to the server it was loaded from, which is why the 1Click API key never reaches a browser. Set `ALLOWED_ORIGINS` to your shop's origin(s) so only your site can call `/pay/*`.
- If your page sets a Content-Security-Policy, allow your Tilll address in `script-src` (the script), `connect-src` (its calls) and `img-src` (the token and network images; without it the checkout shows letter badges instead). *Try it:* run `pnpm demo`, then `curl -sI http://127.0.0.1:3000/`: the demo shop's `content-security-policy` header does exactly this.

*Try it:* `pnpm demo` serves a demo shop (`demo-store/`) that does exactly this.

### Integration security

The checkout receives only an invoice id. The amount is fixed when your server creates the invoice with `MERCHANT_SECRET`, and the public `/pay/*` endpoints accept only a token and a refund address. A customer can't change what an invoice costs. To keep it that way, your integration has to meet four requirements:

1. **Set amounts on your server.** Create each invoice there, from your own catalogue. Never expose an endpoint that takes the amount from the browser.
2. **Link each invoice to an order.** Save the invoice id on the order. When a payment arrives, look the order up by that id in your own database, not by an id the browser sends, and check the amount against the order total.
3. **Fulfil from webhooks, not from client callbacks.** Fulfil an order only after a verified `invoice.paid` webhook, or after your server reads the invoice and finds it `paid`. `onPaid` runs in the browser and can be spoofed.
4. **Keep secrets on your server.** Never put `MERCHANT_SECRET` in page code. A site with no server can still sell: create each invoice in the dashboard and share its payment link.

## Configuration

Settings are environment variables, read from `.env`. `pnpm tilll init` fills the secrets; everything else has a default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on. |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Where customers reach Tilll; used in pay links (a trailing slash is dropped). https makes the dashboard cookie `Secure`. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `TRUST_PROXY` | `false` | Whom to believe about where a request came from (`X-Forwarded-For`). Set `1` when exactly one reverse proxy sits in front of Tilll; see [Security](#security). |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call `/pay/*`, each a scheme and host such as `https://shop.example.com` (no path; a trailing slash is dropped). Set your shop's origin in production. |
| `ONECLICK_BASE_URL` | `https://1click.chaindefuser.com` | The 1Click API. |
| `ONECLICK_API_KEY` | empty | Optional partner key, sent as `X-API-Key`. Without one, 1Click may add a platform fee to quotes; `pnpm dry-quote` prints what applies to a route as `appFees`. |
| `SETTLEMENT_ACCOUNT_ID` | made by `tilll init` | The NEAR account whose Intents balance receives the money. |
| `SETTLEMENT_PRIVATE_KEY` | made by `tilll init` | Signs refund intents. Server only; never logged or sent. |
| `SETTLEMENT_ASSET_ID` | USDC on NEAR | What you are paid in: any asset 1Click lists. Checked against 1Click's token list at startup. |
| `MERCHANT_SECRET` | made by `tilll init` | Bearer secret for `/v1/*` and the dashboard login. |
| `WEBHOOK_URL` | `http://localhost:9000/hooks/tilll` | Where webhooks are sent. |
| `WEBHOOK_SECRET` | made by `tilll init` | Signs webhooks. |
| `INTENTS_CONTRACT` | `intents.near` | The verifier contract. |
| `NEAR_RPC_URL` | `https://rpc.mainnet.near.org` | Any public NEAR RPC; used for balance and key checks. |
| `ATTEMPT_DEADLINE_MINUTES` | `30` | How long a payer has. Bitcoin-like chains always get 120. |
| `SLIPPAGE_BPS` | `100` | Slippage tolerance, in basis points. |
| `EXTRA_CHAINS` | empty | More chains to offer at checkout beyond those with address checks, for example `ltc,doge`. |
| `MEMO_CHAINS` | `stellar` | Chains whose deposits need a memo. |
| `REFUND_MAX_PER_TX` | `50` | Largest single refund, in settlement asset units. |
| `REFUND_MAX_PER_DAY` | `200` | Most you can refund in a UTC day (automatic refunds do not count). |

A bad setting stops startup with a message that names the setting, never its value. Every URL setting must be http or https.

## API

`/v1/*` needs `Authorization: Bearer <MERCHANT_SECRET>` (the dashboard uses a session cookie instead). Amounts are strings in display units (`"5.00"`); responses carry both display and base-unit amounts. Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/invoices` | Create an invoice: `{ amount, description?, metadata?, expiresInMinutes? }`. Returns the invoice and its `payUrl`. |
| GET | `/v1/invoices` | List, newest first: `?status=&q=&limit=&cursor=`. `q` searches id, description and metadata. |
| GET | `/v1/invoices/:id` | The invoice with its attempts and refunds. |
| POST | `/v1/invoices/:id/cancel` | Cancel an open invoice with no payment on the way. |
| POST | `/v1/invoices/:id/refunds/preview` | A dry quote of a refund: what the customer would receive, where. `{ amount? }` |
| POST | `/v1/invoices/:id/refunds` | Refund: `{ amount?, idempotencyKey }`. The same key returns the same refund. |
| GET | `/v1/refunds` | Every refund, newest first. |
| GET | `/v1/balance` | The settlement balance. |
| GET | `/v1/overview` | Balance, paid today, refunded today against the limit, open invoices. |
| GET | `/v1/tokens` | The tokens the checkout offers, by chain. |
| GET | `/v1/webhooks` | The webhook log. |
| POST | `/v1/webhooks/:id/resend` | Send an event again. |
| POST | `/v1/webhooks/test` | Send a `ping` to `WEBHOOK_URL`. |
| GET | `/v1/settings` | How Tilll is set up (never a secret). |
| GET | `/pay/:invoiceId` | The hosted checkout page. |
| GET | `/pay/invoices/:id` | Public invoice info. |
| GET | `/pay/tokens` | The tokens, for the widget. |
| POST | `/pay/invoices/:id/attempts` | Start a payment: `{ originAsset, refundTo }`. Limited to 5 per invoice per 10 minutes. |
| GET | `/pay/attempts/:id` | A payment's status. |
| POST | `/pay/attempts/:id/tx` | Tell Tilll the deposit's transaction hash, to speed up detection. |

*Try it:*
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

Events: `invoice.paid`, `invoice.expired`, `invoice.canceled`, `payment.underpaid`, `payment.refunded_by_network`, `payment.failed`, `payment.duplicate_refunded`, `refund.succeeded`, `refund.failed`, `ping`.

- **1Click proof:** events about a payment or a refund carry the signature 1Click put on the quote behind it (`proof`), and `proofVerified`: whether Tilll checked that signature against 1Click's published public key (`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`, from 1Click's TypeScript SDK) and found the quote unchanged. `false` means it did not verify: expected for a mock or a test network (they sign with their own key), and a reason to look closer on the real 1Click. The signature covers the amounts, the deposit address and memo, and the addresses and assets of the request; it does not cover a status value, so `proofVerified` says the quote is genuine, not that the swap succeeded. Events with no quote behind them (`invoice.expired`, `invoice.canceled`, `ping`) carry neither field. The dashboard shows the same verdict on each payment attempt.
- **Signature:** the header `Tilll-Signature: t=<unix seconds>,v1=<hex>` where `v1` is the HMAC-SHA256, keyed with `WEBHOOK_SECRET`, of `"<t>.<raw body>"`. Verify it over the exact bytes you received and reject a timestamp more than five minutes old. [`demo-store/webhook-receiver.ts`](demo-store/webhook-receiver.ts) is a 20-line verifier to copy.
- **Delivery** is at least once. Dedupe on the `Tilll-Event-Id` header. Any 2xx counts as delivered; Tilll retries after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then stops (the dashboard shows it, and you can resend).

*Try it:* in one terminal `set -a; source .env; set +a; pnpm webhook-receiver`; in another `POST /v1/webhooks/test` (with the bearer secret). The receiver prints `ping ... (signature verified)`.

## Refunds

- A refund is a **new swap at the current price**: if a customer paid 0.05 SOL for a $5 item, they get about $5 of SOL back, minus route fees. Refunds return the value at today's price, so the customer may receive a different amount than they paid. The dialog and `POST .../refunds/preview` show what they would receive first.
- It goes to the **refund address the customer gave** at checkout, on the chain and in the token they paid with.
- Partial refunds are allowed up to the invoice amount. `REFUND_MAX_PER_TX` and `REFUND_MAX_PER_DAY` are enforced on the server, and every refund needs an `idempotencyKey`.
- It is paid from your Intents balance, so the balance must cover it. If a refund fails, the money is still in your balance.
- Duplicate and late payments are refunded automatically, in full, to the address that payment came from. If that fails before any money has moved (including an intent 1Click turned down), Tilll retries (1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours), then tells you with `refund.failed`.

## Privacy

- **The checkout asks for no account, name or email.** The payer chooses a token and gives a refund address.
- **It sets no cookie and keeps nothing in the browser.** The widget never reads or writes cookies or browser storage, and no page or call a payer makes sets a cookie. Only the dashboard does, for its login session. *Try it:* `pnpm test test/privacy.test.ts` passes; or run `pnpm demo`, open the hosted pay page, and see that the cookies and storage in your browser's developer tools are empty.
- **It loads nothing from other hosts.** The pay page's Content-Security-Policy lets it talk only to the Tilll server it came from (`connect-src 'self'`), and the project site loads nothing from other hosts either. Token and network images ship with Tilll: `public/icons` holds a snapshot of the current ones (the images NEAR Intents' explorer shows; the logos belong to their projects). Tilll serves them from your own address, so a payer's browser never contacts anyone else. The one thing your *server* may fetch from outside is an image for a token that 1Click lists and the snapshot lacks: a minute after start, and then daily, it downloads each missing image once from NEAR Intents' explorer (`explorer.near-intents.org`) and keeps it in `DATA_DIR/icons`. The requests name no payer and no invoice. The explorer publishes no icon API or terms, so this is best effort: if its files move, or there is no way out, those tokens show a letter badge. Which picture each token shows follows NEAR Intents' explorer's own choices (a table in `public/icons/token-map.json`, read by `pnpm icons:update` from the explorer's public browser script, since its source is not published): wNEAR shows NEAR's logo, and a token the explorer pictures nothing for shows a letter. Only plain images are kept (an SVG only if it has no script, handler or outside link). Refresh the snapshot with `pnpm icons:update`. *Try it:* `pnpm demo` shows real images with no network, and `pnpm test test/icons-snapshot.test.ts` passes.
- **What is not private.** Payments are routed by the NEAR Intents 1Click API, which sees each quote request, including the refund address. Blockchains are public, so a payment can be seen on-chain. Your own database keeps invoices, payment attempts and refund addresses on your server.

## Security

- **The settlement key can spend the settlement balance.** Use a dedicated account, keep only what you need in it, and sweep it regularly. `REFUND_MAX_PER_TX` and `REFUND_MAX_PER_DAY` limit what the dashboard and API can send.
- **Tilll never signs what 1Click hands it without checking.** It signs only a transfer of exactly the refund amount to the refund quote's own deposit address (or a swap that spends only the settlement asset, up to that amount); the verifier, signer and a deadline within 24 hours must match; every other intent kind (withdrawals, key changes, anything unknown) is refused. `test/intent-policy.test.ts` shows each case.
- **Secrets live only in `.env`** (owner-readable, git-ignored) and are never printed, logged, or sent to a browser. The widget talks only to Tilll, never to 1Click.
- **The dashboard** uses an HttpOnly, SameSite=Strict session cookie, a login limited to 10 tries a minute, a CSRF token on every write, and a strict Content-Security-Policy. Changing `MERCHANT_SECRET` ends every session.
- **Public endpoints** are rate limited and validate every input; SQL is parameterized.
- Tilll listens on `0.0.0.0` inside the container and `docker-compose.yml` publishes it on `127.0.0.1` only. Put a reverse proxy with https in front to make it public, set `PUBLIC_BASE_URL` to the https address, and **set `TRUST_PROXY=1`**. Without it Tilll sees every visitor as the proxy's address, so the rate limits (120 requests a minute on `/pay`, 10 login tries a minute) are shared by everyone: one busy visitor, or one person guessing the login, would block the rest. `TRUST_PROXY` takes `false` (the default), a number of proxies (`1` to `10`), or a list of proxy addresses (`10.0.0.0/8,192.168.1.5`, or `loopback`). A number is only safe when Tilll can be reached through those proxies and nothing else, which is what the loopback-only port gives you; with a list, `X-Forwarded-For` is believed only from those addresses. `true` believes any sender and is for a Tilll that cannot be reached except through the proxy. The proxy must set `X-Forwarded-For` (and `Host`, or `X-Forwarded-Host`) to what it received.

## Limitations

- Refunds return the value at the current price, not the original token amount.
- Refunds depend on 1Click route availability and minimum amounts; a very small refund may not be possible.
- One deployment serves one merchant. No fiat, cards or KYC, and no subscriptions.
- Tilll relies on the 1Click API being reachable, and on one NEAR RPC endpoint for balance reads.
- Address checks are format checks; 1Click is the final authority and rejects what it does not accept. Testnet Bitcoin addresses are not accepted.
- Mainnet has not been exercised by the author yet (see [What is verified](#what-is-verified-and-how)).

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
| [vite](https://vite.dev), [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | Building the dashboard |
| [tailwindcss](https://tailwindcss.com), [@tailwindcss/vite](https://tailwindcss.com/docs/installation/using-vite) | The dashboard's styles |
| [vitest](https://vitest.dev) | Tests |
| [happy-dom](https://github.com/capricorn86/happy-dom) | A browser-like environment for widget and dashboard tests |
| [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) | Dashboard component tests |
| [oxlint](https://oxc.rs/docs/guide/usage/linter), [oxfmt](https://oxc.rs/docs/guide/usage/formatter) | Lint and format |
| `@types/better-sqlite3`, `@types/node`, `@types/qrcode`, `@types/react`, `@types/react-dom` | Type definitions |

Tooling: [pnpm](https://pnpm.io) (package manager), [Docker](https://www.docker.com) with the official `node` image. The project site workflow runs on GitHub, not on your machine, and uses five GitHub Actions, each pinned to a commit: `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `actions/upload-pages-artifact` and `actions/deploy-pages`. Services: the 1Click API and the NEAR Intents verifier contract (`intents.near`) through a NEAR RPC, and, for token and network images, NEAR Intents' explorer (`explorer.near-intents.org`). The NEP-413 signing, Borsh encoding, base58 and the NEAR RPC calls are written in this repository (`src/near/`), using only Node's `crypto`.

## Project site

`site/` is the project's website: a landing page (`index.html`) and a docs page (`docs.html`) that covers running Tilll, adding the checkout and verifying payments. It is plain HTML and CSS built with Tailwind, it sets no cookies and it loads nothing from another host. The server does not serve it.

*Try it:* `pnpm build:site`, then `pnpm preview:site`. You see the site at the address the command prints; the built files are in `site/dist/`.

To publish it with GitHub Pages, push this repository to GitHub and, once, set **Settings → Pages → Source** to **GitHub Actions**. The workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) then builds `site/` on every push to `main` and deploys it. The links on the site (`github`, `demoVideo`) are read from `site/links.json` when it is built; a link that is not set is left out of the page.

## Repository layout

| Path | What is in it |
|---|---|
| `src/` | The server: invoices, refunds, watcher, webhooks, routes, NEAR code, CLI |
| `widget/` | The checkout widget, bundled to `public/checkout.js` |
| `dashboard/` | The merchant dashboard (React), built to `public/dashboard/` |
| `site/` | The project website (static HTML and Tailwind), built to `site/dist/` with `pnpm build:site`. The server does not serve it; it is published on its own, for example on GitHub Pages |
| `demo-store/` | A tiny shop using the widget, and the webhook receiver example |
| `public/icons/` | The snapshot of token and network images (`pnpm icons:update` refreshes it) |
| `scripts/` | `dry-quote`, `icons:update`, the demo, the mainnet runbooks |
| `test/` | The tests, with recorded 1Click responses in `test/fixtures/` |
| `NOTES.md` | What was verified against the NEAR Intents documentation and live responses, and why each design choice was made |
| `PLAN.md` | The build plan |

Commands: `pnpm test`, `pnpm check` (types, lint, format and tests), `pnpm build`, `pnpm start`, `pnpm demo`, `pnpm tilll init|key|check`, `pnpm dry-quote`, `pnpm webhook-receiver`.

## Hackathon

Built for the NEAR HACKATHON (November 2026). Tracks: Real-World Money, Unstoppable DeFi.

- **Written during the hackathon window.** The first commit in this repository is from 2026-11-05 and there is no code from before the window (`git log --reverse` shows it). It is a new project, not an existing product from another chain.
- **How NEAR is used:** see [How NEAR is used](#how-near-is-used). Libraries are listed in [Libraries used](#libraries-used); every one is a dependency of this repository, none is a template or boilerplate.
- **To try it without funds:** [Quick start](#quick-start-5-minutes-no-funds-needed). **The demo, step by step:** [`scripts/demo-video.md`](scripts/demo-video.md).

Demo video: _added when the project is submitted._

## License

MIT. See [LICENSE](LICENSE).
