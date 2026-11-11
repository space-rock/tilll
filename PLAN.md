# Tilll — Build Plan

Self-hosted, open-source crypto checkout on NEAR Intents, with refunds that travel back along the route the payment came in on.

Name: **Tilll** (a play on a shop's cash till; renamed from Till). Brand, logo, landing page and dashboard design are in §21.

> **Amendment 2026-11-09 (product direction, decided by the human).** Tilll is treated as a product, not only a hackathon entry. Positioning: cross-chain payments first, then self-hosted, open source, private and secure; refunds are one feature among the others, no longer the headline. Consequences: (1) the container serves only the API, the checkout and the dashboard; `/` redirects to `/dashboard` and `SERVE_LANDING` is gone (§4, §5); (2) the landing page is the repository's project site, built from `site/` to `site/dist/` and published with GitHub Pages (`.github/workflows/pages.yml`), and its sections follow the order in the amended §21; (3) buttons are navy (`#0B1F3A`, hover `#1E3A5F`, pressed `#071426`, disabled `#E2E8F0` on `#94A3B8`), never green, and the focus ring is indigo (`#6366F1`, `#818CF8` on dark), so §21's `--ring` = emerald no longer applies; emerald stays for logo, paid and live signs; (4) the widget has a step header with back arrow, a progress bar and a footer (§12), with no new options; (5) "censorship-resistant" is not claimed, because Tilll depends on the 1Click API. §21's landing section list is replaced (second amendment, same day: the page is for users, short, no technology talk) by: header, hero ("Get paid in crypto, from any chain.", two buttons: Self-host in 5 minutes and View on GitHub), values (self-hosted, open source, private, secure), how it works, features, developers, self-host, footer. NEAR Intents is named in the hero and footer only; 1Click and the settlement asset are not named, and nothing is said about confidential payments (the recorded real quote says `confidentiality: public`).

This document is the full spec for building the project. Read it fully before writing code. Where this plan says **VERIFY**, check the linked docs before relying on the assumption.

---

## 0. Ground rules for the coding agent

- **Hackathon:** NEAR HACKATHON (https://nearhackathon.com). Hard deadline **2026-11-14 23:59 UTC**. Re-read https://nearhackathon.com/HACKATHON.md before submitting.
- **Mainnet only.** NEAR Intents has no testnet. Never send real funds, sign mainnet transactions, or run anything that moves money without the human explicitly confirming in chat. Use `dry: true` quotes for all automated tests.
- **Secrets** (1Click API key, settlement private key, merchant secret, webhook secret) live only in `.env`. Never commit them. Ship `.env.example`.
- **The README is screened by Claude Code and Codex** before human judges. It must contain reproducible "do X → see Y" steps. No marketing.
- Add an MIT `LICENSE`. List all third-party libraries in the README.
- Prefer small dependencies and plain code. Every feature in the README must actually work.

---

## 1. What we are building

### Problem
Merchants who want to accept crypto from any chain either use a hosted payments company (API key, account, middleman, e.g. Ping or HOT PAY), or build it themselves. Neither existing option handles **refunds**. When a customer pays in SOL on Solana and the merchant settles in USDC on NEAR, there is no button that sends the money back to that customer on Solana.

### Product
1. **Self-hosted server**, one Docker image: invoice API, 1Click integration, status watcher, signed webhooks, merchant dashboard.
2. **Embeddable checkout widget**, one script tag. The payer picks any supported chain and token, enters a refund address, and gets a deposit address and QR code.
3. **Route-aware refunds**: full or partial refunds from the merchant dashboard or API, delivered to the payer's original chain and token, executed from the merchant's NEAR Intents balance with a server-side signed intent.

Funds settle directly into the merchant's own NEAR Intents account. There is no custodian and no third-party account other than NEAR Intents itself.

### Demo moment (the whole video is built around this)
1. On the demo store, click **Pay with crypto** → choose **USDC on Base** → enter the Base refund address → send ~$5.
2. The widget moves through confirming → paid, and the merchant dashboard shows the invoice as paid, with USDC credited in the merchant's NEAR Intents balance.
3. In the dashboard, click **Refund** → USDC lands back in the same Base wallet. Show the transactions in explorers.

---

## 2. Key facts from the 1Click API (already researched)

Base URL: `https://1click.chaindefuser.com`. Docs index: https://docs.near-intents.org/llms.txt

Endpoints used:
- `GET /v0/tokens`: list of supported assets (`assetId`, `blockchain`, `symbol`, `decimals`, `price`, etc.).
- `POST /v0/quote`: creates a swap and returns a unique deposit address when `dry: false`.
- `GET /v0/status?depositAddress=...&depositMemo=...`: swap status.
- `POST /v0/deposit/submit`: optional; tells 1Click the deposit tx hash early.
- `POST /v0/generate-intent` and `POST /v0/submit-intent`: signed-intent execution for `depositType: INTENTS`. Used for refunds.

Auth: header `X-API-Key: <partner JWT>` from https://partners.near-intents.org. The key is optional. Without it, an extra 0.25% fee applies per quote; with it, partner fees apply (about 0.20%, or about 0.01% on stablecoin routes). The server must work with or without a key.

### Quote request: required fields
`dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, refundTo, refundType, recipient, recipientType, deadline`.

`amount` is an integer string in base units. Optional fields we use: `depositMode` (`SIMPLE` | `MEMO`), `quoteWaitingTimeMs`, `referral`, `connectedWallets`, `sessionId`.

### Quote response (`quote` object)
`depositAddress`, `depositMemo` (some chains need it), `amountIn`, `amountInFormatted`, `amountInUsd`, `minAmountIn`, `amountOut`, `minAmountOut`, `deadline`, `timeWhenInactive`, `timeEstimate`, `refundFee`, `withdrawFee`. The top level of the response also has `signature`, `timestamp` and `correlationId`. **Store the whole response.** The signature is the dispute proof.

### Swap semantics we rely on
- `EXACT_OUTPUT`: `amountOut` is fixed. `amountIn` includes the slippage buffer and is larger than `minAmountIn`. Any input not needed is refunded to `refundTo` after the swap. A deposit below `minAmountIn` is refunded by the deadline. A deposit above `amountIn` is processed and the excess refunded.
- `EXACT_INPUT`: used for refunds. The input amount is fixed.

### Status values
`PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, `FAILED`.

`swapDetails` contains: `amountIn`, `amountOut`, `depositedAmount`, `refundedAmount`, `refundReason`, `originChainTxHashes[]`, `destinationChainTxHashes[]`, `nearTxHashes[]`, `intentHashes[]` (each tx entry has `hash` and `explorerUrl`).

1Click has **no webhooks**. We poll `/v0/status` and emit our own webhooks.

---

## 3. Design decisions (these change the original idea; do not revert them)

1. **The refund address is collected before the deposit address is shown.** `refundTo` is required in the quote. The widget asks for it, or fills it from a connected wallet. Never derive it from the deposit sender, because exchange withdrawals come from exchange hot wallets.
2. **Invoices settle into the merchant's NEAR Intents balance** (`recipientType: INTENTS`, `recipient: SETTLEMENT_ACCOUNT_ID`), not to an external wallet. This is what makes refunds possible without an on-chain deposit: a refund is a `depositType: INTENTS` quote funded with a server-signed intent.
3. **Refund policy: refund the value, not the token count.** A refund is a new swap at the current price. If a customer paid 0.05 SOL for a $5 item, they get $5 worth of SOL back, minus route fees. The refund dialog and the README say so explicitly, and the dialog shows a dry quote of what the payer will receive before confirming.
4. **Invoice and payment attempt are separate entities.** A merchant creates an invoice in the settlement asset. A quote is only created once the payer picks a token and enters a refund address, and that quote is a payment attempt. A payer can switch tokens, which creates a new attempt. If a second attempt is also paid after the invoice is already paid, it is auto-refunded (overpayment handling).
5. **Webhooks come from our server**, HMAC-SHA256 signed, with retries.
6. **A dedicated settlement account** (for example `shopname-pay.near`) holds the Intents balance. Its key lives on the server. The dashboard has per-refund and daily refund caps. The merchant sweeps the balance out regularly (the sweep is a stretch goal; documenting it as a manual step is fine).

---

## 4. Architecture

```
 Merchant site                 Tilll server (Docker)                    NEAR Intents
 ┌──────────────┐  script tag  ┌─────────────────────────────────┐  HTTPS   ┌──────────────┐
 │ checkout.js  │─────────────▶│ Public pay API  (/pay/*)        │─────────▶│ 1Click API   │
 │ (widget)     │◀─── poll ────│ Merchant API    (/v1/*)         │◀─ poll ──│              │
 └──────────────┘              │ Watcher (status poller)         │          └──────┬───────┘
 ┌──────────────┐  webhooks    │ Webhook dispatcher              │                 │ settles
 │ Merchant app │◀─────────────│ Refund executor (NEP-413 sign)  │          ┌──────▼───────┐
 └──────────────┘              │ Dashboard (/dashboard)          │  RPC     │ intents.near │
                               │ SQLite                          │─────────▶│ (balances)   │
                               └─────────────────────────────────┘          └──────────────┘
```

### Stack
- **Runtime:** Node 20+, TypeScript.
- **HTTP:** Fastify.
- **DB:** SQLite via `better-sqlite3`, single file under `./data`. This keeps self-hosting to one container. Write plain SQL migrations.
- **NEAR:** `@near-js/crypto` (or `near-api-js`) for ed25519 keys and signing, plus JSON-RPC `fetch` for view calls.
- **Widget:** vanilla TypeScript bundled with esbuild into one `checkout.js`, rendered inside Shadow DOM. QR codes via the `qrcode` package (bundled).
- **Dashboard:** React + Vite + Tailwind CSS + shadcn/ui, in `dashboard/`. It builds to static files in `public/dashboard/` that Fastify serves, so it is still one container. It talks only to the `/v1/*` API.
- **Landing page:** static site in `site/` (plain HTML + Tailwind, or Vite + React reusing the dashboard's Tailwind config). Not served by the container (see the 2026-11-09 amendment): it is published on its own with GitHub Pages.
- **Tests:** vitest. Mock 1Click with recorded fixtures.
- **Tooling:** pnpm (package manager), oxlint (lint), oxfmt (format). `pnpm check` runs typecheck, lint, format check and tests.
- **Packaging:** `Dockerfile` plus `docker-compose.yml`.

---

## 5. Repository layout

```
tilll/
├─ README.md
├─ LICENSE                      # MIT
├─ PLAN.md                      # this file
├─ .env.example
├─ Dockerfile
├─ docker-compose.yml
├─ package.json
├─ src/
│  ├─ server.ts                 # Fastify bootstrap, routes, static files
│  ├─ config.ts                 # env parsing and validation (zod)
│  ├─ db/
│  │  ├─ index.ts
│  │  └─ migrations/001_init.sql
│  ├─ oneclick/
│  │  ├─ client.ts              # typed fetch wrapper: tokens, quote, status, depositSubmit, generateIntent, submitIntent
│  │  ├─ types.ts
│  │  └─ tokens.ts              # cached /v0/tokens (refresh every 10 min)
│  ├─ near/
│  │  ├─ nep413.ts              # sign NEP-413 payload with ed25519 key
│  │  └─ intentsBalance.ts      # view mt_balance_of on intents.near
│  ├─ invoices/
│  │  ├─ service.ts             # create invoice, create attempt (quote), state machine
│  │  └─ states.ts
│  ├─ watcher/poller.ts         # polls open attempts and refunds
│  ├─ refunds/service.ts        # preview (dry quote), execute (quote, generate, sign, submit), track
│  ├─ webhooks/dispatcher.ts    # HMAC sign, retry with backoff
│  ├─ routes/
│  │  ├─ merchant.ts            # /v1/* (auth: merchant secret)
│  │  ├─ pay.ts                 # /pay/* (public, rate-limited)
│  │  └─ dashboard.ts           # /dashboard session login/logout; serves public/dashboard SPA
│  ├─ validate/addresses.ts     # refundTo format checks per chain
│  └─ cli.ts                    # `tilll init`, `tilll key`, `tilll check`
├─ widget/
│  ├─ src/checkout.ts
│  └─ build.mjs                 # esbuild → public/checkout.js
├─ dashboard/                   # React + Vite + Tailwind + shadcn/ui → builds to public/dashboard/
├─ site/                        # landing page → builds to public/site/
├─ brand/                       # logo SVGs and favicon (§21)
├─ public/                      # served statically: checkout.js, dashboard/, site/
├─ demo-store/                  # tiny static shop page using the widget, plus webhook receiver example
├─ scripts/
│  ├─ dry-quote.ts              # prints a dry quote for any route (safe)
│  └─ mainnet-smoke.md          # manual steps the HUMAN runs with tiny amounts
└─ test/
   ├─ fixtures/                 # recorded 1Click responses
   └─ *.test.ts
```

---

## 6. Configuration (`.env.example`)

```
PORT=8080
PUBLIC_BASE_URL=https://pay.example.com      # used by the widget and in webhook links
DATA_DIR=./data

ONECLICK_BASE_URL=https://1click.chaindefuser.com
ONECLICK_API_KEY=                            # optional partner JWT; empty = unauthenticated (+0.25% fee)

SETTLEMENT_ACCOUNT_ID=shopname-pay.near      # merchant's NEAR account that holds the Intents balance
SETTLEMENT_PRIVATE_KEY=ed25519:...           # key used to sign refund intents (VERIFY registration, §15)
SETTLEMENT_ASSET_ID=nep141:...               # e.g. USDC on NEAR; must exist in /v0/tokens

MERCHANT_SECRET=sk_live_...                  # generated by `tilll init`; merchant API and dashboard auth
WEBHOOK_URL=https://merchant.example.com/hooks/tilll
WEBHOOK_SECRET=whsec_...                     # generated by `tilll init`

NEAR_RPC_URL=https://rpc.mainnet.near.org    # any public RPC (see docs.near.org/api/rpc/providers)

ATTEMPT_DEADLINE_MINUTES=30                  # BTC-like chains get 120 (see §8)
SLIPPAGE_BPS=100
REFUND_MAX_PER_TX=50                         # in settlement asset display units
REFUND_MAX_PER_DAY=200
```

`SETTLEMENT_ASSET_ID` must be resolved from `/v0/tokens` at startup. Look up USDC on NEAR there rather than hardcoding it, and fail fast with a clear message if it is missing.

---

## 7. Data model (`001_init.sql`)

```sql
CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,           -- inv_<ulid>
  amount          TEXT NOT NULL,              -- base units of SETTLEMENT_ASSET_ID
  asset_id        TEXT NOT NULL,
  description     TEXT,
  metadata_json   TEXT,                       -- merchant's own data (order id etc.)
  status          TEXT NOT NULL,              -- open | paid | expired | canceled
  paid_attempt_id TEXT,
  refunded_amount TEXT NOT NULL DEFAULT '0',
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE attempts (
  id                TEXT PRIMARY KEY,         -- att_<ulid>
  invoice_id        TEXT NOT NULL REFERENCES invoices(id),
  origin_asset      TEXT NOT NULL,            -- 1Click assetId chosen by payer
  origin_chain      TEXT NOT NULL,            -- blockchain from /v0/tokens
  refund_to         TEXT NOT NULL,            -- payer refund address on origin chain
  deposit_address   TEXT NOT NULL UNIQUE,
  deposit_memo      TEXT,
  amount_in         TEXT NOT NULL,            -- what we show the payer
  min_amount_in     TEXT NOT NULL,
  deadline          TEXT NOT NULL,
  quote_json        TEXT NOT NULL,            -- full quote response incl. signature
  oneclick_status   TEXT NOT NULL,            -- last raw status
  status            TEXT NOT NULL,            -- awaiting | confirming | underpaid | paid | refunded | failed | superseded
  status_json       TEXT,                     -- last full /v0/status response
  deposit_tx_hash   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE refunds (
  id               TEXT PRIMARY KEY,          -- ref_<ulid>
  invoice_id       TEXT NOT NULL REFERENCES invoices(id),
  attempt_id       TEXT NOT NULL REFERENCES attempts(id),
  amount           TEXT NOT NULL,             -- base units of settlement asset
  reason           TEXT,                      -- merchant_request | overpayment_auto
  deposit_address  TEXT,                      -- from refund quote (links the status)
  quote_json       TEXT,
  intent_hash      TEXT,
  status           TEXT NOT NULL,             -- pending | submitted | succeeded | failed
  status_json      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,             -- evt_<ulid>
  event_type    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_try_at   TEXT,
  delivered_at  TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE refund_ledger_daily (            -- enforces REFUND_MAX_PER_DAY
  day    TEXT PRIMARY KEY,                    -- YYYY-MM-DD UTC
  total  TEXT NOT NULL
);
```

All amounts are integer strings handled with `BigInt`. Never use floats for money.

---

## 8. Invoice and attempt lifecycle

### Create invoice (merchant)
`POST /v1/invoices { amount: "5.00", description?, metadata?, expiresInMinutes? }`
→ Convert `amount` to base units of the settlement asset using its decimals. Status `open`. Invoices default to expiring after 60 minutes.

### Create attempt (payer, via widget)
`POST /pay/invoices/:id/attempts { originAsset, refundTo }`
1. The invoice must be `open` and not expired.
2. Validate `originAsset` against the cached token list and `refundTo` for that chain (§12).
3. Mark any earlier `awaiting` attempts on this invoice as `superseded`. Keep polling them anyway (see overpayment below).
4. Call `POST /v0/quote`:

```json
{
  "dry": false,
  "swapType": "EXACT_OUTPUT",
  "slippageTolerance": 100,
  "originAsset": "<payer choice>",
  "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "<SETTLEMENT_ASSET_ID>",
  "amount": "<invoice.amount base units>",
  "refundTo": "<payer refund address>",
  "refundType": "ORIGIN_CHAIN",
  "recipient": "<SETTLEMENT_ACCOUNT_ID>",
  "recipientType": "INTENTS",
  "deadline": "<now + ATTEMPT_DEADLINE_MINUTES (120 for btc, ltc, doge, bch, zec, dash)>",
  "depositMode": "SIMPLE",
  "referral": "tilll"
}
```

If the token list or a 400 error indicates the chain needs a memo, retry with `depositMode: "MEMO"`. VERIFY this behaviour.

5. Store the attempt with `status: awaiting`. Return to the widget: `depositAddress`, `depositMemo`, `amountIn` (formatted), symbol, chain, `deadline`, and `timeEstimate`.

**The widget always shows `amountIn`, not `minAmountIn`.** Excess input is refunded by 1Click automatically.

### Status mapping (watcher)
The watcher polls every attempt that is not in a terminal state every 10 s, backing off to 30 s after 10 minutes. It stops on terminal states.

| 1Click status | attempt.status | Effect |
|---|---|---|
| PENDING_DEPOSIT | awaiting | — |
| KNOWN_DEPOSIT_TX, PROCESSING | confirming | — |
| INCOMPLETE_DEPOSIT | underpaid | webhook `payment.underpaid` (1Click refunds at the deadline) |
| SUCCESS | paid | see below |
| REFUNDED | refunded | webhook `payment.refunded_by_network` |
| FAILED | failed | webhook `payment.failed` |

On `SUCCESS`:
- If the invoice is `open`: set the invoice to `paid`, set `paid_attempt_id`, and send webhook `invoice.paid`.
- If the invoice is already `paid` (a second attempt was paid): create an automatic refund with reason `overpayment_auto` for the full amount of this attempt, and send webhook `payment.duplicate_refunded`. Automatic overpayment refunds bypass the daily cap but are logged.

When an invoice passes `expires_at` with no paid attempt, set it to `expired` and send webhook `invoice.expired`. Attempts that are still pending keep being polled, because a late payment can still succeed before its own deadline. If one does succeed on an expired invoice, auto-refund it in the same way.

### Public status
`GET /pay/attempts/:id` returns the attempt status, formatted amounts, explorer links from `originChainTxHashes`, and the invoice status. The widget polls this endpoint every 3 s. The widget never talks to 1Click directly, so the API key never reaches the browser.

Optional: `POST /pay/attempts/:id/tx { txHash }` forwards to `/v0/deposit/submit` to speed up detection when the wallet-connect path knows the tx hash.

---

## 9. Refunds

### Preview
`POST /v1/invoices/:id/refunds/preview { amount? }` (the amount defaults to the remaining refundable amount)

Make a **dry** quote:

```json
{
  "dry": true,
  "swapType": "EXACT_INPUT",
  "slippageTolerance": 100,
  "originAsset": "<SETTLEMENT_ASSET_ID>",
  "depositType": "INTENTS",
  "destinationAsset": "<attempt.origin_asset>",
  "amount": "<refund amount base units>",
  "refundTo": "<SETTLEMENT_ACCOUNT_ID>",
  "refundType": "INTENTS",
  "recipient": "<attempt.refund_to>",
  "recipientType": "DESTINATION_CHAIN",
  "deadline": "<now + 30 min>"
}
```

Return `amountOutFormatted`, the symbol, the chain, `withdrawFee`, and the refund address. The dashboard dialog shows: "Customer will receive ≈ X SOL to <address> on Solana. Refunds return the value at today's price."

### Execute
`POST /v1/invoices/:id/refunds { amount?, idempotencyKey }`
1. Checks:
   - The invoice is `paid`.
   - `amount` ≤ invoice amount − `refunded_amount`.
   - `amount` ≤ `REFUND_MAX_PER_TX`, and the daily total stays within `REFUND_MAX_PER_DAY` (except automatic refunds).
   - The settlement account's Intents balance is ≥ `amount` (§11).
   - `idempotencyKey` is unique per invoice.
2. Run the same quote with `dry: false` and store `depositAddress`.
3. `POST /v0/generate-intent { type: "swap_transfer", standard: "nep413", signerId: SETTLEMENT_ACCOUNT_ID, depositAddress }` → returns `intent`.
4. Sign `intent.payload` with `SETTLEMENT_PRIVATE_KEY` using NEP-413 (§11). Do not modify the payload.
5. `POST /v0/submit-intent { type: "swap_transfer", signedData: { ...intent, public_key, signature } }` → store `intentHash`. Set the refund status to `submitted`.
6. The watcher polls `/v0/status?depositAddress=<refund deposit address>`. On `SUCCESS`: set the refund to `succeeded`, add to the invoice's `refunded_amount`, and send webhook `refund.succeeded` with the destination tx explorer links. On `FAILED` or `REFUNDED`: set the refund to `failed` and send webhook `refund.failed`. Funds return to the settlement account's Intents balance, because `refundType` is `INTENTS`.

Partial refunds are simply smaller amounts. Multiple partial refunds are allowed up to the invoice amount.

---

## 10. Merchant API (`/v1/*`)

Auth: `Authorization: Bearer <MERCHANT_SECRET>`. JSON in and out. Errors are `{ error: { code, message } }`.

| Method | Path | Purpose |
|---|---|---|
| POST | /v1/invoices | Create an invoice. Returns `{ id, status, amount, payUrl, expiresAt }` |
| GET | /v1/invoices/:id | Invoice, attempts, refunds |
| GET | /v1/invoices?status=&limit=&cursor= | List |
| POST | /v1/invoices/:id/cancel | Only while open with no confirming attempt |
| POST | /v1/invoices/:id/refunds/preview | Dry refund quote |
| POST | /v1/invoices/:id/refunds | Execute refund (requires `idempotencyKey`) |
| GET | /v1/balance | Settlement account Intents balance of the settlement asset |
| GET | /v1/tokens | Supported origin tokens (cached), grouped by chain |
| POST | /v1/webhooks/test | Send a `ping` event |

`payUrl` is `${PUBLIC_BASE_URL}/pay/<invoiceId>`, a hosted checkout page that uses the same widget, for merchants who don't embed it.

## Public pay API (`/pay/*`, no auth, rate-limited per IP)

| Method | Path | Purpose |
|---|---|---|
| GET | /pay/:invoiceId | Hosted checkout page |
| GET | /pay/invoices/:id | Public invoice info (amount, description, status, expiry) |
| GET | /pay/tokens | Token list for the widget |
| POST | /pay/invoices/:id/attempts | Create attempt (§8) |
| GET | /pay/attempts/:id | Attempt status |
| POST | /pay/attempts/:id/tx | Optional early tx hash |

CORS: allow the origins listed in `ALLOWED_ORIGINS` (add this to config; default `*` for the demo).

---

## 11. NEAR specifics

### NEP-413 signing (`src/near/nep413.ts`)
The `generate-intent` response gives a `payload` of `{ recipient, nonce (base64, 32 bytes), message }`. To sign:
1. Borsh-serialize `{ message: string, nonce: [u8;32], recipient: string, callbackUrl: Option<string> }`.
2. Prefix it with the u32 little-endian tag `2^31 + 413`.
3. Hash the result with sha256 and sign the hash with ed25519.
4. Return `public_key: "ed25519:<base58>"` and `signature: "ed25519:<base58>"`.

VERIFY the exact `signedData` shape against https://docs.near-intents.org/integration/verifier-contract/signing-intents.md and https://docs.near-intents.org/api-reference/oneclick/submit-a-signed-intent.md. Write a unit test using the docs' example vectors if they are provided. If `raw_ed25519` turns out simpler and is accepted for a NEAR account, it's acceptable to use it instead.

### Key authorization (VERIFY first, in Phase 1)
Check https://docs.near-intents.org/integration/verifier-contract/account-abstraction.md to find out whether the settlement account's ed25519 public key must be registered on `intents.near` (for example via `add_public_key`) before it can sign intents. If it must, add a documented one-time CLI step to the README and to `tilll check`. The human runs that step; the agent prints the command.

### Balance (`src/near/intentsBalance.ts`)
Make a view call on `intents.near` with `mt_balance_of({ account_id: SETTLEMENT_ACCOUNT_ID, token_id: SETTLEMENT_ASSET_ID })` through `NEAR_RPC_URL`. VERIFY the method name and token id format in https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances.md.

---

## 12. Widget (`widget/src/checkout.ts` → `public/checkout.js`)

### Embed
```html
<script src="https://pay.example.com/checkout.js" defer></script>
<button data-tilll-invoice="inv_01H...">Pay with crypto</button>
```
Or programmatically: `Tilll.open({ invoiceId, onPaid(attempt){}, onClose(){} })`.
The widget derives its server origin from its own script `src`.

### Flow (modal, Shadow DOM, mobile-friendly)
1. **Summary:** amount, description, and an expiry countdown.
2. **Choose chain → token.** Data comes from `/pay/tokens`. Popular routes come first: USDC and USDT on Base, Arbitrum, Ethereum, Solana and NEAR, plus native ETH, SOL, BTC and NEAR. Add a search box.
3. **Refund address.** Copy: "If anything goes wrong, or the merchant refunds you, funds return here." Validate it per chain (below). Show a warning: "Don't use an exchange deposit address."
4. **Pay.** Show the deposit address, a QR code, a copy button, and the exact `amountIn` with its symbol. Show the memo prominently when present. Add a countdown to the deadline and a link to change the token (which creates a new attempt).
5. **Status:** awaiting → confirming → paid ✓, with explorer links. Also show underpaid, refunded and failed states, each with a clear explanation.

Optional fast path (stretch goal): "Connect wallet" for EVM (EIP-1193) and NEAR (wallet selector) fills `refundTo` and sends the transfer, then posts the tx hash.

### Refund address validation (`src/validate/addresses.ts`, shared by server and widget)
These are basic format checks, keyed by the `blockchain` value from `/v0/tokens`:
- EVM chains: `^0x[a-fA-F0-9]{40}$`
- `sol`: base58, 32–44 characters
- `near`: NEAR account regex (named or 64-hex implicit)
- `btc`: bech32 `^bc1[a-z0-9]{25,62}$` or base58 `^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$`
- `tron`: `^T[1-9A-HJ-NP-Za-km-z]{33}$`
- Any other chain: non-empty, no whitespace, and show "double-check this address" in the UI.

Only enable the chains we validate in the widget for the demo. Other chains can be added through config.

---

## 13. Webhooks

Events:
- `invoice.paid`, `invoice.expired`, `invoice.canceled`
- `payment.underpaid`, `payment.refunded_by_network`, `payment.failed`, `payment.duplicate_refunded`
- `refund.succeeded`, `refund.failed`
- `ping`

Payload:
```json
{
  "id": "evt_...",
  "type": "invoice.paid",
  "createdAt": "2026-11-10T10:00:00Z",
  "data": { "invoice": { ... }, "attempt": { ... } },
  "proof": { "oneclickQuoteSignature": "...", "oneclickCorrelationId": "..." }
}
```

Headers:
- `Tilll-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>" with WEBHOOK_SECRET>`
- `Tilll-Event-Id: evt_...`

Delivery: POST with a 10 s timeout. Any 2xx counts as delivered. Retry with exponential backoff at 1 m, 5 m, 30 m, 2 h and 6 h, then give up and mark the event in the dashboard. Deliveries are at-least-once, so receivers dedupe by `Tilll-Event-Id`.

Ship `demo-store/webhook-receiver.ts`, which verifies the signature (about 20 lines) and shows how a merchant would integrate.

Stretch goal: verify the 1Click quote and status signatures (https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature.md) and include `"proofVerified": true` in the payload.

---

## 14. Dashboard (`/dashboard`)

Stack: React + Vite + Tailwind + shadcn/ui (§4). Follow the dashboard design in §21. Use these shadcn components: `Card`, `Table`, `Badge`, `Button`, `Input`, `Dialog` (refund), `Tabs` or a segmented `ToggleGroup` (status filter), `Sheet` (invoice detail on narrow screens), `Toast`/`Sonner` (refund result), `Skeleton` (loading). The dashboard calls `/v1/*` with the session cookie; the server accepts either the cookie or the bearer secret.

- Login with `MERCHANT_SECRET`, stored in an HTTP-only session cookie.
- **Home:** settlement balance, today's refunded total against the cap, and recent invoices.
- **Invoices list:** status filter and search by id or metadata.
- **Invoice detail:**
  - amount, status, timeline;
  - attempts, each with chain, token, refund address, deposit address, status and explorer links;
  - refunds;
  - raw quote JSON in a collapsible section.
- **Refund button.** Enter an amount, which defaults to the remaining refundable amount → preview (dry quote) → confirm → live status.
- **Create test invoice button**, for the demo.
- **Webhook log:** deliveries, failures, and a resend button.

---

## 15. Security checklist

- The 1Click API key and settlement key are server-only and never sent to the browser or written to logs.
- Refund caps per transaction and per day are enforced server-side. Refunds require an idempotency key.
- The settlement account should be dedicated and swept regularly; the README says this.
- Public endpoints are rate-limited (`@fastify/rate-limit`). Validate every input with zod.
- Attempt creation is limited to 5 attempts per invoice per 10 minutes.
- The dashboard uses an HTTP-only, SameSite=Strict session cookie and has CSRF protection on its POST requests.
- Use parameterized SQL only.
- No secrets in git. Make sure `.gitignore` excludes `.env` and `data/`.

---

## 16. Testing

- **Unit:** amount conversion (BigInt), status mapping, the state machine (including duplicate payment, then automatic refund), webhook signing, address validation, NEP-413 serialization.
- **Integration with a mocked 1Click:** a fixture-driven fake server covering quote, then a status sequence (`PENDING_DEPOSIT` → `KNOWN_DEPOSIT_TX` → `PROCESSING` → `SUCCESS`), with webhooks asserted. Include a refund path, an underpaid path, and an expired-but-late-paid path.
- **Live safe check:** `pnpm dry-quote --from base:USDC --amount 5` makes a real `dry: true` quote and prints amounts and fees.
- **Mainnet smoke test** (`scripts/mainnet-smoke.md`): steps **the human** runs with about $3–5. The agent never runs these.
  1. `tilll check`: verifies the API key, the settlement asset, RPC access and key registration.
  2. Create an invoice, pay with USDC on Base, and watch it reach paid.
  3. Refund it, and confirm the USDC arrives back on Base.
  4. Optionally, pay a second time on the same invoice to see the automatic duplicate refund.

---

## 17. Build phases (deadline 2026-11-14 23:59 UTC)

Work through the phases in order. **Do not start a phase until every exit check of the previous phase passes.** At the end of each phase, stop, report to the human what was built and which checks passed, and wait for a go-ahead before continuing. Steps marked **HUMAN** move real money or need the human's keys; the agent prepares them and waits.

### Phase 1 — Foundation and verification
- Scaffold the repo (§5), config validation (§6), DB and migrations (§7).
- 1Click client for all endpoints in §2, token list cache, `scripts/dry-quote.ts`.
- **Resolve every VERIFY item in §11** (NEP-413 `signedData` shape, key registration on `intents.near`, `mt_balance_of`) and the memo behaviour in §8. Write the findings into a `NOTES.md`; if any finding contradicts this plan, stop and tell the human before continuing.

**Exit checks:** `pnpm test` passes; `pnpm dry-quote --from base:USDC --amount 5` prints a real dry quote; `NOTES.md` answers each VERIFY item with a doc link.

### Phase 2 — Payments core
- Invoices, attempts and the state machine (§8), including superseded attempts.
- Watcher and status mapping.
- Merchant API (§10) and public pay API, with rate limits and zod validation.

**Exit checks:** the mock-1Click integration test goes from invoice creation to `invoice.paid`; underpaid and expired paths are covered by tests.

### Phase 3 — Checkout widget
- Widget flow (§12): chain and token choice, refund address with validation, deposit address and QR, live status.
- Hosted pay page and the demo store page.

**Exit checks:** the hosted page completes a mocked payment end to end in a browser; address validation tests pass.

### Phase 4 — Webhooks and first real payment
- Webhook dispatcher with HMAC signing and retries (§13), and `demo-store/webhook-receiver.ts`.
- `tilll check` command and `scripts/mainnet-smoke.md` (payment part).
- **HUMAN:** run one real ~$3–5 payment (USDC on Base).

**Exit checks:** the real payment reaches `paid` in the DB and the receiver verifies its `invoice.paid` webhook.

### Phase 5 — Refunds
- NEP-413 signing (§11) with unit tests, settlement balance view.
- Refund preview and execution (§9), caps and idempotency.
- **HUMAN:** if Phase 1 found key registration is needed, register the key; then refund the Phase 4 payment.

**Exit checks:** refund mock tests pass; the real refund shows `SUCCESS` and the USDC arrives back on Base.

### Phase 6 — Edge cases and dashboard
- Automatic refunds for duplicate and late payments (§8).
- Dashboard (§14): balance, invoices, invoice detail, refund dialog with preview, webhook log.

**Exit checks:** all state machine tests pass, including duplicate and expired-but-late-paid; the refund dialog works against the mock.

### Phase 7 — Packaging and docs (feature freeze after this phase)
- Dockerfile and `docker-compose.yml`, `tilll init`.
- README following §18, LICENSE, library list.

**Exit checks:** from a clean clone, every Quick start step in the README works exactly as written; no secrets in git.

### Phase 8 — Stretch (only if time remains before Nov 13)
In this order, each optional: wallet-connect fast path, 1Click signature verification in webhooks, settlement sweep, WooCommerce plugin.

### Phase 9 — Demo and submission
- **HUMAN:** record the demo (§1 demo moment), post on X.
- Make the repo public (human confirms), print the submission payload and submit only after the human confirms (HACKATHON.md).

**Exit checks:** the submission API returns 201.

If time runs short, cut Phase 8 entirely and trim Phase 6 to the duplicate-payment auto-refund only. Never cut the README or the refund flow, since those are what the demo and the screening depend on.

---

## 18. README skeleton (write for a machine reviewer)

```
# Tilll
Self-hosted crypto checkout on NEAR Intents with route-aware refunds.

## What it does
- Accept payment from any chain/token supported by NEAR Intents; merchant receives USDC in their NEAR Intents balance.
- Refund any payment (full/partial) back to the payer's original chain and token.
- No hosted middleman: run one Docker container; your keys, your server.

## How NEAR is used
- 1Click API (EXACT_OUTPUT quotes, unique deposit addresses, status) for cross-chain settlement.
- Settlement into the merchant's NEAR Intents account (recipientType INTENTS).
- Refunds via signed intents (NEP-413) from that balance: no on-chain deposit needed.

## Quick start (5 minutes, no funds needed)
1. git clone … && cp .env.example .env
2. pnpm run init  → generates MERCHANT_SECRET and WEBHOOK_SECRET
3. docker compose up
4. Open http://localhost:8080/dashboard → "Create test invoice" → see invoice page
5. pnpm dry-quote --from base:USDC --amount 5 → see a live quote with fees
6. pnpm test → mocked end-to-end: pay → paid → refund → refunded

## Real payment (mainnet, ~$5)
see scripts/mainnet-smoke.md

## Embed
<script src=…/checkout.js> + data-tilll-invoice

## API reference / Webhooks / Refund policy / Security / Limitations
## Libraries used
## Hackathon
Built for NEAR HACKATHON (Nov 2026). Tracks: Real-World Money, Unstoppable DeFi.
Demo video: <link>
## License
MIT
```

Limitations to state honestly:
- Refunds return the value at the current price, not the original token amount.
- Refunds depend on 1Click route availability and minimum amounts.
- The settlement key on the server can spend the settlement balance, which is why the account should be dedicated, capped and swept.

---

## 19. Out of scope (do not build)

- Fiat on-ramps, cards, or KYC.
- Multi-merchant or multi-tenant support (one deployment serves one merchant).
- Our own smart contract (not needed; NEAR Intents and 1Click cover settlement).
- The WooCommerce plugin (stretch goal only).
- Subscriptions (Ping already does them).

---

## 20. Reference links

- 1Click overview: https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api.md
- Quote: https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md
- Status: https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status.md
- Signed intent execution: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution.md
- Signing intents: https://docs.near-intents.org/integration/verifier-contract/signing-intents.md
- Account abstraction (key registration): https://docs.near-intents.org/integration/verifier-contract/account-abstraction.md
- Balances: https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances.md
- API keys and fees: https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md
- Quote signature verification: https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature.md
- Full docs index: https://docs.near-intents.org/llms.txt
- Hackathon rules for agents: https://nearhackathon.com/HACKATHON.md

---

## 21. Brand and UI design

Design canvas (logo directions, landing page, dashboard): https://claude.ai/artifact/6YNmiPXAB8wdXZQ2Y7U16j. The human may share an exported copy; if the link isn't readable, follow the spec below.

### Logo
Mark A, "Drawer": a rounded register drawer with a slot, and a coin dropping into it. Files are in `brand/`:
- `brand/tilll-mark.svg`: mark only, navy with emerald coin (light backgrounds).
- `brand/tilll-mark-white.svg`: mark for dark backgrounds.
- `brand/tilll-logo.svg`: mark + "tilll" wordmark.
- `brand/favicon.svg`: mark on a navy rounded square.

Wordmark: lowercase "tilll", Manrope ExtraBold (800), letter-spacing −0.04em. Leave clear space of half the mark's height around the logo.

### Colour tokens
| Token | Hex | Use |
|---|---|---|
| navy | `#0B1F3A` | primary text, dark sections, primary buttons, logo |
| emerald | `#059669` | accent, primary CTA on the landing page, success, logo coin |
| emerald-dark | `#047857` | links and accent text on white (passes AA) |
| emerald-light | `#ECFDF5` / `#6EE7B7` | success badge background / accent text on navy |
| slate-600 | `#475569` | body text |
| slate-200 | `#E2E8F0` | borders on the landing page |
| zinc palette | shadcn defaults | dashboard neutrals (`#E4E4E7` borders, `#71717A` muted text) |
| amber | `#B45309` on `#FFFBEB` | underpaid / warning badges |
| blue | `#1D4ED8` on `#EFF6FF` | refunded badges |

Map these into `tailwind.config` (`colors.navy`, `colors.brand`) and the shadcn CSS variables: `--primary` = navy, `--ring` = emerald, `--radius` = 0.75rem. Support dark mode in the dashboard using the shadcn `dark` class.

### Type
- Display and wordmark: Manrope 700/800.
- UI and body: Inter 400/500/600.
- Code, addresses, IDs: JetBrains Mono.

### Landing page sections (in order)
1. Header: logo, links (How it works, Refunds, Developers, Self-host), GitHub button.
2. Hero: eyebrow "Open-source checkout · Built on NEAR Intents"; headline "Take payment from any chain. Refund it the same way."; one-paragraph subline; CTAs "Self-host in 5 minutes" and "View on GitHub"; chain chips; a static mock of the checkout widget on the right.
3. How it works: three numbered cards (create invoice → customer pays from any chain → settle in USDC on NEAR).
4. Refunds (navy band): copy on the left; a PAID → SETTLED → REFUNDED route on the right; the "refunds return the value at today's price" note.
5. Why self-hosted: comparison table, Tilll vs a typical hosted checkout (where it runs, who receives funds, account needed, refunds to original chain, source code). Keep claims about other products generic.
6. Developers: script-tag embed and `curl` invoice examples.
7. Self-host CTA (navy card) with the four setup commands.
8. Footer: logo, "Built at NEAR HACKATHON 2026 · MIT licensed", links.

No invented metrics, testimonials or partner logos. Links to the repo and demo video are filled in at Phase 9.

### Dashboard layout
- Left sidebar: logo; nav (Overview, Invoices, Refunds, Webhooks, Settings); a settlement-account card at the bottom showing the account ID and 1Click connection status. It collapses to a top bar on phones.
- Top bar: search, Export CSV, "Create invoice".
- Overview:
  - four stat cards: settlement balance, paid today, refunded today with a progress bar against the daily cap, open invoices;
  - a recent invoices table with status filter;
  - beside it, the selected invoice's detail card (amounts, refund address, timeline, Refund button);
  - a webhook deliveries table.
- Refund dialog: amount input; a live preview box (customer receives, destination address, route fee); the value-at-today's-price note; Cancel / Confirm refund.
- Status badges: Paid (emerald), Open/Confirming (zinc), Underpaid (amber), Refunded and Partially refunded (blue), Expired (muted).
- The demo build shows no fake numbers. All data comes from the API; empty states say what to do next ("Create a test invoice").
