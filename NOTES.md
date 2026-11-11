# Phase 1 findings

Every VERIFY item from PLAN.md §11 and §8, answered from the docs or from a live read-only / `dry: true` call on 2026-11-05. Nothing here moved funds, signed a transaction, or created a deposit address.

## Summary

| Item | Result | Contradicts the plan? |
|---|---|---|
| NEP-413 signing bytes (§11) | Matches the plan. Confirmed against the NEP-413 spec. | No |
| `signedData` shape (§11) | Matches the plan. | No |
| Key registration on `intents.near` (§11) | **Required** for named accounts. One `add_public_key` call by a human. Implicit accounts skip it. Both paths now tried end to end on a testnet verifier (section 12). | No (the plan allowed for it) |
| `mt_balance_of` and token id (§11) | Works as planned. Verified live. | No |
| Memo behaviour (§8) | The API rejects a wrong `depositMode` with a matchable 400 message. | No (plan's retry-on-400 is workable) |
| Unauthenticated fee (§2) | Docs say +0.25%. Live dry quotes show different `appFees` (1 bps on USDC routes, 20 bps on ETH). README and `.env.example` now point at `pnpm dry-quote` instead of a figure (see section 15). | Yes, PLAN §2 states 0.25% |

Nothing found requires changing the design. Details below.

---

## 1. NEP-413 signing (§11)

**Source:** https://github.com/near/NEPs/blob/master/neps/nep-0413.md (raw: https://raw.githubusercontent.com/near/NEPs/master/neps/nep-0413.md), "Signature" section.

The plan's recipe is correct:

1. Build `Payload { message: string, nonce: [u8; 32], recipient: string, callbackUrl?: string }`. Field order is as written.
2. Borsh-serialize it. A string is a `u32` little-endian length followed by UTF-8 bytes. `nonce` is 32 raw bytes. `callbackUrl` is an `Option`: one byte `0`, or `1` followed by the string.
3. Prepend the 4-byte Borsh `u32` of 2^31 + 413 (little-endian).
4. SHA-256 the result.
5. Ed25519-sign the hash.

The Intents docs do not restate the byte layout (https://docs.near-intents.org/integration/verifier-contract/signing-intents.md); they link to NEP-413.

**No test vector with a private key exists.** The Intents page has one full signed example (payload, `public_key`, `signature`) but no secret key, so it cannot be re-signed. It can be **verified**: rebuild the bytes from the example payload, hash them, and check the example signature against the example public key. That is the Phase 5 unit test.

The example, from signing-intents.md:

```json
{
  "standard": "nep413",
  "payload": {
    "recipient": "intents.near",
    "nonce": "Vij2xgAlKBKzgNPJFViEQRgYyS7p2NEiYTTY4XmT8go=",
    "message": "{\"deadline\":\"2025-05-21T10:34:04.254392Z\",\"intents\":[{\"intent\":\"transfer\",\"receiver_id\":\"bob.near\",\"tokens\":{\"nep141:usdc.near\":\"10\"}}],\"signer_id\":\"alice.near\"}"
  },
  "public_key": "ed25519:C3jXhkGhEx88Gj7XKtUziJKXEBMRaJ67bWFkxJikVxZ2",
  "signature": "ed25519:2ns3eCikZFxFA6e9ApunuDG4XwJUPrB8q82fYViBKjheqiDYcCmLN9RnB9NhoEvCdNoS3L3qYD9FAnKd7UkTnuij"
}
```

Caveat: nothing guarantees this example's signature is valid for the layout above (it is documentation, not a conformance vector). If the Phase 5 test fails against it, fall back to `raw_ed25519` (see below) rather than guessing at the layout.

## 2. `signedData` and the generate/submit flow (§11)

**Sources:**
- https://docs.near-intents.org/api-reference/oneclick/generate-an-intent-for-signing.md
- https://docs.near-intents.org/api-reference/oneclick/submit-a-signed-intent.md
- https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution.md

`POST /v0/generate-intent` takes `{ type: "swap_transfer", standard, signerId, depositAddress }` (all required) and returns `{ intent: { standard, payload }, correlationId }`. For `standard: "nep413"` the payload is `{ message, nonce (base64), recipient, callbackUrl? }`.

`POST /v0/submit-intent` takes:

```json
{
  "type": "swap_transfer",
  "signedData": {
    "standard": "nep413",
    "payload": { "recipient": "intents.near", "nonce": "...", "message": "..." },
    "public_key": "ed25519:<base58>",
    "signature": "ed25519:<base58>"
  }
}
```

and returns `{ intentHash, correlationId }`. The quickstart builds `signedData` as `{ ...intent, public_key, signature }` and says "Do not modify the payload between generation and signing." This matches PLAN §9 step 5. The TypeScript types in `src/oneclick/types.ts` follow it.

**`raw_ed25519` is a fallback.** The `standard` enum is `nep413 | erc191 | raw_ed25519 | webauthn | ton_connect | sep53 | tip191`. The signing page says a named NEAR account may sign with `raw_ed25519` (its payload is a JSON string, not an object). Not used unless the NEP-413 test in Phase 5 forces it.

## 3. Key registration on `intents.near` (§11)

**Source:** https://docs.near-intents.org/integration/verifier-contract/account-abstraction.md

**Registration is required for a named account.** Quote: "To start using a named account with the Verifier, you must register a public key by calling `add_public_key` on `intents.near` from that named NEAR account." Until then "you just won't be able to sign intents". The Verifier keeps its own map of account to public keys; the docs never say on-chain access keys are recognized automatically.

**HUMAN step, prepared and NOT run.** Verbatim from the docs, with the placeholders filled in later (the key will come from the future `tilll key` command, §5 `cli.ts`):

```bash
near contract call-function as-transaction \
  intents.near add_public_key json-args '{
    "public_key": "ed25519:<base58 public key of SETTLEMENT_PRIVATE_KEY>"
  }' prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as <SETTLEMENT_ACCOUNT_ID> network-config mainnet sign-with-keychain send
```

This is a mainnet transaction (1 yoctoNEAR plus gas), so it needs the human. Removal is `remove_public_key(public_key)`.

**Checking registration (for `tilll check`):** the docs say to check but name no method. Verified live over read-only RPC against `intents.near`:

| Call | Result |
|---|---|
| `has_public_key({ account_id, public_key })` | `false` for an unregistered key |
| `public_keys_of({ account_id })` | `[]` for an account with none |
| `no_such_method_xyz` (control) | `MethodResolveError(MethodNotFound)` |

So both methods exist, and `tilll check` can call `has_public_key`.

**Two design options this opens up. Not in the plan, so not built. Both have since been tried on a real (testnet) verifier; see section 12.**

1. *Server key that is not an on-chain access key.* The registration transaction is signed by one of the account's existing full-access keys and registers a **different** key (the server's). The docs imply this but do not state it outright, so it needs confirming before relying on it. If true, a stolen server key could move the Intents balance but not the account's NEAR or its other access keys.
2. *Use an implicit account as the settlement account.* The docs: "Implicit accounts skip this step — their account ID is derived directly from their public key." A 64-hex account ID derived from the server key needs no registration transaction at all, which removes the HUMAN step. The cost: the merchant gets a hex account ID instead of `shopname-pay.near`, and the plan's examples use a named account. The config regex already accepts 64-hex IDs.

## 4. Balance (§11)

**Source:** https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances.md

`mt_balance_of({ account_id, token_id })` on `intents.near`; `mt_batch_balance_of({ account_id, token_ids })` for several. The `token_id` is the same string as the 1Click `assetId` from `/v0/tokens`.

Verified live over read-only RPC (`https://rpc.mainnet.near.org`), using the USDC-on-NEAR asset id from `/v0/tokens`:

```
mt_balance_of({ account_id: "example.near", token_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" })  =>  "0"
```

The result is a JSON string of base units. The plan is correct.

## 5. Memo behaviour (§8)

**Sources:** https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md and live dry quotes.

From the docs: `depositMode` is `SIMPLE` (default) or `MEMO`; "most chain supports only `SIMPLE` and some(for example `stellar`) only `MEMO`". The quote response carries `depositMemo`, and `/v0/status` must be called with `depositMemo` when the quote returned one. `/v0/tokens` has **no** memo flag.

From live dry quotes (the only way to test without making a real quote):

| Request | Result |
|---|---|
| `stellar:XLM`, `depositMode: SIMPLE` | `400` "Incorrect depositMode for originAsset from stellar chain" |
| `stellar:XLM`, `depositMode: MEMO` | `400` "Quoting for this pair is not available" (passed the depositMode check; the pair itself is not quotable) |
| `xrp:XRP`, `depositMode: MEMO` | `400` "Incorrect depositMode" |
| `xrp:XRP`, `depositMode: SIMPLE` | `400` "Internal server error" (cause unknown; probably the pair, not the mode) |

So 1Click validates `depositMode` per chain and the error text is matchable (`/Incorrect depositMode/`). That is a usable signal for the plan's "retry with MEMO on 400" idea, which I earlier reported as having nothing to key on. That was wrong.

**What Phase 1 implements:** a static `MEMO_CHAINS` setting (default `stellar`) that picks `MEMO` up front. **Suggested for Phase 2:** also retry once with the other mode when a 400 matches `/Incorrect depositMode/`. Not built yet.

**Not verified:** the actual `depositMemo` value and whether `/v0/status` accepts it. Dry quotes omit the deposit address and memo, and a real quote would create a deposit address, which the ground rules forbid without the human. Stellar and XRP are not in the demo path (EVM, Solana, NEAR, Bitcoin, Tron).

## 6. Fees (§2): docs and live observation disagree

**Docs:** https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md and https://docs.near-intents.org/resources/fees.md say unauthenticated requests pay "an additional 0.25% (25 basis points) platform fee on every non-`ANY_INPUT` quote", while authenticated partners pay about 20 bps, or 1 bp on stablecoin and same-asset multichain routes. PLAN §2 says 0.25%. HACKATHON.md Q-006 says 0.2%.

**Observed**, with no API key, `dry: true`, 2026-11-05 (see `test/fixtures/quote-dry-exact-output.json` for the first):

| Route | `appFees` echoed in `quoteRequest` | Notes |
|---|---|---|
| Base USDC to NEAR USDC, $5 | `[{ recipient: 5880ad2b…47dd, fee: 1 }]` | `minAmountIn` 5.001013 against `amountOut` 5.0, about 0.02% above |
| Ethereum ETH to NEAR USDC, $5 | `[{ recipient: 5880ad2b…47dd, fee: 20 }]` | |

I sent no `appFees`; 1Click added them. The values equal the *authenticated* schedule (1 bp stablecoin, 20 bps otherwise), and no 25 bps entry appears. Whether an additional 25 bps is folded into the price is not visible from a dry quote.

**Consequence:** the README must not state a fee percentage as fact. It should say "run `pnpm dry-quote` to see the current fee" and quote the docs figure only as the docs' claim. Needs your call on wording before Phase 7.

## 7. Other things the live API showed

- `POST /v0/quote` returns **HTTP 201**, not 200. The client accepts any 2xx.
- A dry quote has no `depositAddress`, `deadline` or `timeWhenInactive`, as documented.
- **1Click validates `refundTo` against the origin chain.** An EVM address for a Solana origin and a garbage string both get `400 "refundTo is not valid"`. A dry quote does *not* accept arbitrary strings, only well-formed addresses for that chain. The widget's validation (§12) is therefore a UX layer; 1Click is the final check.
- `referral: "tilll"` and `depositMode: "SIMPLE"` are accepted.
- Not every pair is quotable (`stellar:USDC`, `stellar:XLM` to NEAR USDC: "Quoting for this pair is not available"). The widget should list only what the API will quote, or handle this error.
- `assetId` prefixes are not only `nep141:`. The 215-token fixture (38 chains) also has `nep245:` and `1cs_v1:` ids. Nothing in Tilll assumes `nep141:`.
- A chain can have two tokens with one symbol (`hypercore` has two USDC). `dry-quote` refuses an ambiguous `chain:SYMBOL` and lists the ids.
- **Correction to PLAN §2:** in `swapDetails`, only `originChainTxHashes` and `destinationChainTxHashes` are `{ hash, explorerUrl }` objects. `nearTxHashes` and `intentHashes` are plain string arrays (OpenAPI v0.1.10, https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status.md).
- **`quote.deadline` is not the payment deadline.** On a real (non-dry) quote, `quote.deadline` and `quote.timeWhenInactive` came back 3 days after the `deadline` we requested (asked 09:24:46Z, got Nov 8 09:24:46Z); the echoed `quoteRequest.deadline` matched what we asked. They look like the time the deposit address goes inactive. Tilll shows the payer the deadline it requested. Docs (https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md): the *request* `deadline` is "when the user refund begins if the swap isn't completed by then"; the *response* `deadline` is "when the deposit address becomes inactive and funds may be lost". The quote request has no field for address lifetime, so it cannot be shortened. Whether a deposit that arrives after our deadline is refunded by 1Click or swapped is not stated and cannot be tested without a real deposit. Open item for Phase 6: the watcher stops polling an unfunded attempt 2 hours after our deadline, while the address stays live for 3 days.
- `POST /v0/deposit/submit` takes `{ txHash, depositAddress, nearSenderAccount?, memo? }` and returns the same shape as `/v0/status`.
- `amountOutFormatted` comes back as `"5.0"`, while our `fromBaseUnits` gives `"5"`. Do not compare the two as strings.
- `refundFee` and `withdrawFee` are raw base-unit strings and the response does not say which asset they are in, so `dry-quote` prints them as returned and does not interpret them.

## 8. Settlement asset

USDC on NEAR is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals), looked up in `/v0/tokens` rather than assumed. It is the default in `.env.example` and is validated against the live list at startup (`resolveSettlementAsset`).

## 9. Phase 3 findings (checkout widget)

- **The token list has look-alikes the picker must disambiguate.** `near` lists two `USDT` and two `ETH` (the canonical `usdt.tether-token.near` and bridged `miden-…omft.near` ones), and `hypercore` lists two `USDC`. The widget flags any symbol that appears twice on a chain and shows a short contract hint next to it, with the shorter (canonical) contract first.
- **Symbols are not uniform across chains.** Base has no USDT, Arbitrum's dollar token is `USDT0`, native NEAR is listed as `wNEAR` (`nep141:wrap.near`). The widget leads each chain with USDC, USDT, USDT0, then the chain's native coin, then everything else alphabetically, and shows symbols as 1Click lists them.
- **Chains offered by default** are those with a strict address check: EVM (`eth base arb op pol bsc avax gnosis bera monad xlayer plasma scroll abs`), `sol`, `near`, `btc`, `tron`. `EXTRA_CHAINS` adds others, which only get the generic check (non-empty, no whitespace) and an on-screen "double-check this address" note. The EVM chain list is my reading of which chain ids in `/v0/tokens` take `0x` addresses; a wrong entry only means a valid address is checked too strictly or an invalid one too loosely, and 1Click still validates.
- **Bundle size:** `public/checkout.js` is about 48 kB minified including the `qrcode` library.
- **Verified in a real browser** (Chrome, against the mock payment network from `pnpm demo`, never the live API): shop button to modal, token search keeping focus, local address refusal, QR and copy buttons, waiting to confirming to paid with explorer links, the shop's `onPaid` callback, the hosted pay page, a Solana attempt with a wrong-chain address refused, switching token, and a duplicate payment recorded as a pending automatic refund.

## 10. Phase 4 decisions (webhooks and `tilll check`)

- **Delivery** follows PLAN section 13: POST with a 10 s timeout, any 2xx is delivered, retries after 1 min, 5 min, 30 min, 2 h and 6 h, then it gives up (6 attempts). A given-up event stays in `webhook_deliveries` with `next_try_at` NULL and `delivered_at` NULL, so the dashboard can list it.
- **Redirects are never followed** (`redirect: "manual"`, so a 3xx is a failure). Following one would send a signed body to a host the merchant never named.
- **Each attempt is signed with a fresh timestamp**, so a retry hours later is not rejected as a replay by a receiver that checks the 5 minute window.
- **Order is only guaranteed for events that succeed first time.** Events go out oldest first by insertion order, but an event that is being retried can arrive after a later one. Receivers should use `createdAt` or the invoice state, not arrival order, and must dedupe on `Tilll-Event-Id` (delivery is at least once).
- **A test ping is not retried.** `POST /v1/webhooks/test` sends it immediately and returns how the endpoint answered; a person is watching, so a failed ping is not put on the retry schedule.
- **The receiver's replay window is a setting** (`toleranceSeconds`, default 300). Clock drift between the two servers is the usual reason a correctly signed request is refused.
- **`tilll check` is read-only by construction.** Outside this machine it makes: one token-list `GET`, one *dry* quote and only when an API key is set (to prove the key), NEAR view calls (`mt_balance_of`, `has_public_key`), and, only with `--webhook`, one signed ping to your own `WEBHOOK_URL`. A test asserts it never calls `generate-intent`, `submit-intent` or `deposit/submit`, that every quote has `dry: true`, and that no secret is printed. Run live with a throwaway key and `example.near` it reported 215 tokens, the settlement asset, an Intents balance of 0 USDC and the key as not registered.
- **Key registration is a warning, not a failure**, because payments work without it and only refunds (Phase 5) need it. The warning carries the exact `add_public_key` command with the derived public key; running it is a human step.
- The real-payment runbook is `scripts/mainnet-smoke.md`.

## 11. Tidepool testnet (development harness only)

[Tidepool](https://www.usetidepool.tech) is a community-run, anonymous testnet copy of the 1Click API ("not affiliated with NEAR, Defuse or 1Click"; no terms, no SLA; deposit addresses are custodial). Tilll can run against it for development: `pnpm testnet:fund`, `pnpm testnet:check`, `pnpm testnet:smoke` (see `scripts/testnet/`). It is deliberately **not** mentioned in the README, and nothing about it is needed to use Tilll. A fail-closed guard (`scripts/testnet/guard.ts`, mutation-checked) refuses to run unless the base URL, NEAR RPC, verifier contract and every account are the testnet's, and it only ever sends a dummy API key.

**Verified against the live service (2026-11-07):**

- Its OpenAPI (`0.1.10-tidepool.1`, 129 schemas) has the same quote request and response, status, `swapDetails`, deposit-submit and generate/submit-intent shapes as 1Click v0.1.10 and as `src/oneclick/types.ts`. Extras: `simulate`, `chainDepositAddresses`, a `tidepool` object on status.
- `/v0/health` reported testnet, the verifier `verifier.tidepool-sandbox.testnet` and a matching code hash. Its token list has 26 tokens on 9 chains (fixture: `test/fixtures/tidepool-tokens.json`).
- **A full payment works end to end in about 33 seconds** through the real Tilll server: quote, on-chain `storage_deposit` and `ft_transfer` from a throwaway NEAR testnet account, our `/pay/attempts/:id/tx` forwarding the hash, status `confirming` then `paid`, the signed `invoice.paid` webhook verified, and the settlement balance in the verifier rising by exactly the invoice amount (100 to 103 to 106 USDC over two runs). A real quote and SUCCESS status are kept as fixtures with a contract test (`test/tidepool-contract.test.ts`).
- `INTENTS_CONTRACT` works against a real testnet verifier, `tilll check` passes fully there, and an **implicit account** (64-hex id equal to its key) needs no `add_public_key`.
- The faucet's intents mode credits an implicit account's verifier balance with no gas and no signing; `wallet` mode puts NEP-141 balances on an existing account. Its 429 (`retryAfterSeconds`) parses correctly, so reruns are safe. Native NEAR is never dripped; NEAR's own helper (`POST https://helper.nearprotocol.com/account` with `newAccountId` and `newAccountPublicKey`, the call behind `near create-account --useFaucet`) created a funded 10 NEAR testnet account with no captcha or login.

**Differences from 1Click that matter:**

- `quote.deadline` and `timeWhenInactive` equal the deadline we ask for (mainnet returns them 3 days later).
- Stable to stable fees are about 26 bps without a key; sending any key value is the cheaper tier. A dry quote returns no `refundFee` or `withdrawFee`.
- Paying with the settlement asset itself (USDC on NEAR for a USDC-on-NEAR invoice) is rejected with `originAsset and destinationAsset must differ`. **Mainnet 1Click accepts it** (checked with a dry quote: minimum exactly 5 USDC, zero fee), so this is Tidepool-only and needs no change in Tilll. The testnet payer pays with NEAR USDT instead.
- `swapDetails.slippage` is a fraction (`-0.01`). The payer's slippage buffer comes back as `refundedAmount` (deposited 3.031729, used 3.001712, refunded 0.030017), while the merchant gets exactly the invoice amount.
- Tidepool ignores `confidentiality`; it has a single maker; `CONFIDENTIAL_INTENTS` returns 400.

**What testnet cannot prove for mainnet:** NEAR's changelog says 1Click swaps settle confidentially from 2026-10-27 with an unchanged API; whether a mainnet `recipientType: INTENTS` payment is credited to a *public* `mt_balance_of` is not shown anywhere I could read, and Tidepool cannot answer it. The real mainnet payment (`scripts/mainnet-smoke.md`) remains the only check of that, of mainnet fees, and of the +3 day address window.

## 12. Phase 5 findings (refunds)

**What was built:** `src/near/nep413.ts` (signing; checked against the signed example in the Intents docs), `src/refunds/intentPolicy.ts` (what the key may sign), `src/refunds/service.ts` (preview, execute, follow, report), `GET /v1/balance`, the watcher following refunds, migration `003`. Exit checks: the refund tests (`test/refunds.service.test.ts`, `test/merchant-refunds-api.test.ts`, `test/integration-refunds.test.ts`, `test/poller.refunds.test.ts`, `test/intent-policy.test.ts`, `test/nep413.test.ts`) pass with mocks; a real refund succeeded on the Tidepool testnet (below). The same on mainnet is a HUMAN step: `scripts/mainnet-refund.md`.

**Design decisions, all inside the plan's §9:**

- **The server never signs what 1Click hands it without a check.** `assertSafeToSign` accepts only a `transfer` of exactly the refund amount of the settlement asset to the refund quote's own deposit address, or a `token_diff` that spends only the settlement asset up to the refund amount; total over all intents never above the refund; the verifier, the signer and a deadline within 24 hours must match; every other intent kind (withdrawals, `add_public_key`, `storage_deposit`, anything unknown) and every unexpected field is refused. Mutation-checked. Why: a compromised or buggy 1Click would otherwise be able to drain the whole Intents balance with one signature. **Open item for mainnet:** the policy is written to the Tidepool/documented `transfer` form and to a `token_diff` form I could not observe; if mainnet's `generate-intent` returns something else, the refund fails closed with `intent_refused` and the message names what it saw. That would be a one-line policy change plus a test, not a redesign.
- **Reserve first, then act.** One SQLite transaction checks the invoice's remaining amount (counting refunds in flight), the per-transaction and per-day caps, the settlement balance (minus refunds in flight) and the idempotency key, and inserts a `pending` row plus the day's ledger entry. Only then is 1Click called. A repeated or parallel request with the same key finds the row and returns it; a different amount under the same key is a 409.
- **A failed refund keeps its key.** Replaying the key returns the failed refund (so a retry is a deliberate act with a new key), and the day's allowance is given back when a refund fails.
- **Unknown outcome is not failure.** If `submit-intent` gets no answer or a 5xx, the intent may or may not have been accepted, so the refund stays `pending` and the watcher asks 1Click about the refund's deposit address. A refund with a signed intent is written off as unfunded only after that intent's own deadline plus five minutes; a refund that never reached signing is failed after ten minutes (nothing could have moved).
- **Automatic refunds (duplicate and late payments) are not executed yet**; they are still recorded as `pending` rows with reason `overpayment_auto` (Phase 6 executes them). They are not counted against the invoice's own refundable amount or against the balance reservation, and a success on one does not change `refunded_amount`.
- `mapQuoteError` moved from the invoice service into `src/oneclick/apiErrors.ts` so refunds map 1Click errors the same way.

**Verified live on the Tidepool testnet (2026-11-08, `pnpm testnet:smoke`: 16 of 16 checks twice, once with an implicit and once with a named settlement account):** pay 3 USDC with NEAR USDT, `paid` after about 33 s, then refund 1 USDC: preview (about 1.0005 USDT to the payer's own account, `withdrawFee: null`), `POST .../refunds` (a repeated `idempotencyKey` returned the same refund), `submitted` in about 4 s, `succeeded` about 10 s later with a NEAR explorer link, `refund.succeeded` delivered and verified, the settlement verifier balance down by exactly 1 USDC and the customer's USDT up by exactly what the preview said.

- **NEP-413 works for an implicit settlement account** on the official verifier code (`defuse v0.4.5`): no `raw_ed25519` fallback needed.
- **A named settlement account whose server key is a different key works too** (`pnpm testnet:shop`, then `pnpm testnet:smoke --shop`): the account's own access key called `add_public_key` on the verifier with 1 yoctoNEAR to register a key that is not an access key of the account, `has_public_key` then returned true, and refunds signed by that key succeeded. This confirms design option 1 in section 3, so a merchant with `shopname-pay.near` can keep the account and add a separate server key; the registered key can be removed with `remove_public_key`.
- **An unregistered key fails cleanly:** `submit-intent` answers 400 `Verifier rejected the signed intent: ... public key 'ed25519:...' doesn't exist for account '...'`, and the quote's deposit address stays `PENDING_DEPOSIT` with nothing moved. In Tilll that becomes `refund_failed` (502) with that message, a `failed` refund row, and the allowance released.
- **Tidepool's `generate-intent` answer** (nothing signed): a `transfer` intent `{ receiver_id: <refund deposit address>, tokens: { <settlement asset>: <amount> } }`, `deadline` 15 minutes ahead, addressed to `verifier.tidepool-sandbox.testnet`; the message JSON also carries `signer_id`, `verifying_contract` and `nonce`, which the policy ignores.
- **The faucet's API mode now answers 403** ("not available via the API; claim on the site"). Reruns of `pnpm testnet:fund` therefore fail today; the accounts it funded earlier still hold their balances, and the shop account needs no tokens because the smoke run pays an invoice into it.

**Not provable on testnet, left for the mainnet refund:** the real `generate-intent` message form (`transfer` or `token_diff`), mainnet withdraw fees, and that the confidential-settlement balance can be spent by this key.

**Suggestion, not built (not in the plan):** check `has_public_key` before creating a refund quote and answer with the `add_public_key` command, instead of letting the verifier's rejection reach the merchant. The current message is already clear; this would only save a wasted quote.

## 13. Phase 6 findings (edge cases and dashboard)

**Exit checks:** all state machine tests pass, including a duplicate payment and an expired-but-late-paid one now run through to the refund arriving (`test/state-machine.test.ts`, `test/integration.test.ts`, `test/refunds.auto.test.ts`, `test/poller*.test.ts`); the refund dialog works against the mock: `pnpm demo`, open http://127.0.0.1:8080/dashboard, log in with the secret the banner prints, pay the sample invoice (or the demo shop), open it and press Refund. Checked in a real browser on 2026-11-08: login, overview, invoice detail, the refund dialog (quote, confirm, progress, success), the Refunds, Webhooks (with a resend) and Settings pages, search, light and dark mode, and an automatic refund of a second payment on the same invoice.

**Automatic refunds (PLAN section 8):**
- The poller starts every due `overpayment_auto` refund: the whole amount of the duplicate or late payment goes back to *that payment's* refund address and chain, outside the per-refund and daily limits (the daily total counts only refunds the merchant asked for), and each start is logged.
- A failure before any money moved (1Click down, quote rejected, balance short, an intent refused by the policy, or a signed intent that 1Click turned down) is retried after 1 min, 5 min, 30 min, 2 h and 6 h; the sixth failure ends the refund and sends `refund.failed`. Why retry: the usual cause is temporary, and the merchant should not have to ask. A try whose outcome is unknown (`submit-intent` timed out, or something broke after 1Click accepted the intent) is never repeated, because that intent may still land; the watcher finds out. A claim on a try expires after 5 minutes, so a crash mid-try only delays it.
- A refund with a signed intent reserves balance, so a merchant refund cannot spend the same money.

**Late payers (the open item from Phase 4):** an attempt nobody has paid used to be watched for 2 hours after its deadline, but the live run showed 1Click keeps the deposit address active for 3 days. It is now watched until `timeWhenInactive` (2 hours if the quote does not say, never more than 7 days), polled every 5 minutes once its deadline has passed. **Not proven live:** that a deposit made after our own deadline but before the address goes inactive is still swapped by 1Click. The quote's own `timeWhenInactive` says it should be; Tidepool sets it equal to the deadline, so only a mainnet test can show it.

**Dashboard (PLAN sections 14 and 21):**
- Login with `MERCHANT_SECRET` sets an HttpOnly, SameSite=Strict cookie (Secure on https) holding a signed token that expires by itself (12 hours) and is keyed from the secret, so changing the secret ends every session. No session table. Login is limited to 10 tries a minute per IP.
- `/v1/*` accepts the cookie or the bearer secret. A write made with the cookie must carry the session's CSRF token (read by the page from `/dashboard/api/session`) and, if the browser sends an Origin, come from the same host. A wrong bearer secret is never rescued by a valid cookie.
- `/dashboard` serves the built app from `public/dashboard` with `default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`, refuses any path outside that folder, and answers unknown paths without a file extension with the app (its routes). `style-src` allows inline styles because the progress bar sets its width that way.
- New API, all behind the same auth, needed by the dashboard: `GET /v1/overview`, `GET /v1/refunds`, `GET /v1/webhooks`, `POST /v1/webhooks/:id/resend` (sends the same event again, whatever its state), `GET /v1/settings` (never a secret; URLs have any user:password removed), and `?q=` on `GET /v1/invoices` (id, description or metadata, case-insensitive, `%` and `_` are plain characters).
- **Stack, and where it differs from the plan:** React, Vite and Tailwind as planned, all in `devDependencies` (they only build static files; the server's runtime dependencies did not change). The shadcn components are written by hand in the same style, **without Radix, cva, tailwind-merge, lucide or sonner**: modals use the browser's own `<dialog>` (focus trap, Escape, inert background), toasts are 40 lines. That keeps the added packages to seven build and test tools. Fonts are the system stack, not Inter, Manrope and JetBrains Mono, so nothing third party is loaded.
- Pages: Overview, Invoices (search, filter, paging), Invoice (timeline, attempts, refunds, raw quote), Refunds, Webhooks (log, payload, resend), Settings (read-only), Create invoice, Export CSV (spreadsheet-safe), dark mode.
- The refund dialog asks for a quote when it opens (filling the amount with everything refundable) and again, a moment after typing stops; Confirm is only possible for the amount that was quoted. One idempotency key is made per opening, so a double click or a retry after a lost answer cannot refund twice. After confirming it follows the refund and reports the end.
- **Bugs the tests and the browser found, now fixed:** reloading the page behind the dialog restarted the dialog (the data hook cleared its data on every reload; `test/dashboard-hooks.test.tsx`), and the search box was cleared while typing (found by the app test). The mock now reports the amount out for the refund amount, and gives the refund transfer a link.
- **Not checked:** the layout at phone width (the browser tool could not resize the viewport; the sidebar becomes a top bar through Tailwind's responsive classes), and the dashboard against a real 1Click.

## 14. Landing page (PLAN sections 4, 5 and 21)

**Gap in the plan:** the landing page is described in sections 4, 5 and 21 but no phase in section 17 builds it. It was built after Phase 7 on the user's say-so (option 1 of three offered).

- **What it is:** `site/` holds one static HTML page (Tailwind, no framework) and a tiny script for the copy buttons. `pnpm build:site` (part of `pnpm build`) writes `public/site/`. With `SERVE_LANDING=true`, Tilll serves it at `/` with a Content-Security-Policy that allows only its own stylesheet and script (`connect-src 'none'`); by default `/` stays a 404, because Tilll is an API and a dashboard. Every URL in the built page is relative, so the same files also work on GitHub Pages.
- **Sections:** the eight of section 21, in order, with the headline and eyebrow it gives. No metric, testimonial or partner logo; the two illustrations (the checkout window, the SOL refund route) are labelled as examples.
- **Links that do not exist yet:** `site/links.json` holds `github` and `demoVideo`, both null. At build time an element marked `data-needs` is removed when its link is null, so the page never shows a dead button; the clone command shows `<repository-url>` until the repository link is set. Fill the two values in at Phase 9 and run `pnpm build:site`. A link must be https or null (`test/site.test.ts`).
- **Claims are checked** (`test/site.test.ts`): the chains shown are in the checkout's own list; the embed snippet is the README's; the four setup commands are the README Quick start's, in order; the page says "refunds return the value at today's price" like the README; no `style=`, inline script, event handler or third-party URL (the CSP would block them).
- **Contrast:** brand emerald `#059669` with white text is 3.8:1, below the 4.5:1 small text needs. On the landing page the emerald buttons use navy text (4.6:1); in the dashboard the brand button now uses `#047857` with white text (5.5:1).
- **Fonts:** the system stack again, as in the dashboard: the logo SVG's wordmark loads Manrope from Google Fonts, which an `<img>` cannot, and nothing third party is loaded.
- **Checked in a real Chrome (headless, DevTools device emulation, 2026-11-08)** at 1280 px and 390 px wide: no horizontal overflow at either, code samples wrap. The same check at 390 px on the dashboard (overview, invoices, refunds, webhooks, settings) found no overflow either; the sidebar becomes a top bar and its nav scrolls sideways. On a phone the invoices table's Status column sits behind a sideways scroll.

## 15. Final audit (2026-11-09)

Every PLAN requirement was traced to code and a test; the risky paths were reviewed twice (a read-through and `/code-review high` over refunds, invoices, routes, auth, NEAR, watcher, webhooks); the real flows were run on the mock network in a real browser, on the Tidepool testnet (both account types, 16 of 16 checks each), against live 1Click (read-only), and in Docker. The suite passes in nine consecutive runs, three of them under CPU contention, with no flaky test; `pnpm audit` reports no known vulnerabilities.

**Bugs found and fixed (each with a failing test first):**
- Node 20 was documented as supported; the installed dependencies need 22.12 (`engines`, README and runbook corrected; a test now ties them to the dependencies' own `engines`).
- Automatic refunds: an unexpected failure skipped the six-try cap (retried every 5 minutes forever, never reported); a signed intent that 1Click turned down was never retried; a refund whose deposit 1Click already had was counted against the balance a second time.
- Poller: a failure in one stage (sweeping interrupted refunds) skipped the rest of the pass; `stop()` waited for a hung 1Click request.
- Webhooks: a test ping or a resend and the background pass could both send an event and overwrite each other's schedule; `stop()` waited for a hung endpoint, and an aborted send is now put back rather than counted as a failed delivery.
- Auth: an `Authorization` header of another scheme (a proxy's Basic login) blocked the dashboard cookie; Bearer is now case-insensitive.
- An unknown `/dashboard/api/...` path returned the app page with 200 instead of a JSON 404.
- `PUBLIC_BASE_URL` with a trailing slash produced pay links with a double slash; `ALLOWED_ORIGINS` entries with a trailing slash or capitals could never match an `Origin`; a webhook, 1Click, RPC or public URL with a wrong scheme failed only later, quietly. All are now normalised or refused at startup.
- Tests added where there was none: the server log never holds a secret, session, CSRF token or request body; Tilll resumes a refund and a queued webhook after a restart without sending anything twice; random round trips of money conversion.

**Waiting for a decision (not changed, because they are new behaviour or contradict the plan):**
- PLAN section 4 says "Node 20+"; the real minimum is 22.12 because Node 20 is end-of-life and the SQLite driver needs 22. PLAN.md itself was left unedited.

**Decided with the user, then done:**
- **`TRUST_PROXY`** (new setting, off by default). Behind a reverse proxy every visitor shared the proxy's address, so the per-IP rate limits (120 a minute on `/pay`, 10 a minute on login) were one bucket for everyone (proved: a second visitor was limited after the first used the budget). It takes `false`, `true`, a number of proxies (1 to 10) or a list of addresses, CIDR ranges and `loopback` style keywords, refuses anything else at startup, and also makes the dashboard's same-site check use the public host a trusted proxy reports in `X-Forwarded-Host`. Fastify's own handling of a bare number is to trust nothing, so a count is translated into a trust function (believe the last N addresses), as Express does; a visitor cannot pick their own address by adding to `X-Forwarded-For` (the proxy's entry is the one used), and a list believes the header only from those proxies. A count is only safe when Tilll is reachable through the proxy and nothing else (the compose file's `127.0.0.1` port gives that); the README says so.
- **Fee wording.** PLAN section 2 and `.env.example` said an unauthenticated quote costs 0.25% extra. Live quotes without a key on 2026-11-09 showed `appFees` of 1 bps (USDC on Base to NEAR) and 20 bps (ETH to NEAR), so no single figure is true. `.env.example` and the README now say 1Click may add a platform fee and that `pnpm dry-quote` prints it as `appFees`; a test keeps an unmeasured figure out of both. PLAN.md itself was left unedited.

**Known limits (not bugs):** status polls run one at a time, so a very large number of live payment attempts at once (hundreds) would delay polling; loading them is cheap (22 ms for 5000). Databases from before migration 002 (never released) cannot be read. There is no backup or restore procedure in the README.

**Only a person can verify:** the mainnet payment and refund (the two runbooks), whether mainnet settlement credits a public balance, and the exact intent form 1Click returns on mainnet.

## 16. 1Click signature verification (Phase 8, item 2: webhooks)

**Source of the scheme:** https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature.md says the signed message is "a Base58-encoded SHA-256 hash of a deterministic JSON object" of `{ ...quoteRequest, ...quoteResponse, timestamp }`, sorted with `json-stable-stringify`, but names neither the public key nor the exact fields. Both come from the source of 1Click's own SDK (`@defuse-protocol/one-click-sdk-typescript` 0.1.26, `verifyQuoteSignature`, read as text from unpkg, never installed or run): the key is the SDK's `ONE_CLICK_MANAGER_PUB_KEY`, the signature is over the UTF-8 text of the base58 hash (not the raw hash bytes), the request contributes a fixed list of fields (not `appFees`, `depositMode`, `sessionId`, `correlationId`, `connectedWallets`), and a dry quote signs only its eight amount fields while a real one also signs `depositAddress`, `depositMemo`, `deadline`, `timeWhenInactive`, `timeEstimate`, `refundFee` and `withdrawFee`.

**Checked against real data:** the live `dry: true` quote recorded in Phase 1 (`test/fixtures/quote-dry-exact-output.json`) verifies against that key with this scheme, and fails with the raw-hash variant, so the key, the field list and the encoding are confirmed by a response 1Click really produced. The Tidepool testnet's quote does not verify (it signs with its own key), as expected.

**Not yet checked against real data:** the form for a quote of a real payment (`dry: false`). No such response was ever recorded (every automated test and live check is `dry: true`), so that branch follows the SDK's source and is tested only against quotes signed here with a throwaway key. The first mainnet payment settles it: its `invoice.paid` event should say `"proofVerified": true` (the runbook asks for it). A `false` there is not a payment failure; it would mean the branch needs adjusting.

**What shipped:** `src/oneclick/signature.ts` (`verifyQuoteSignature`, `quoteHash`, `stableStringify`, `proofOf`), `verifyEd25519` in `src/near/keys.ts` (Node `crypto` only, no new dependency, never throws), a top-level `proofVerified` next to `proof` on every event that has a quote behind it (payment events and refund events; `false` unless Tilll verified it), the same verdict on each attempt in the dashboard, and the receiver prints `1Click proof: verified` or `NOT verified`.

**Design choices (to change if you disagree):**
- It is **reported, not enforced**. A quote whose signature fails is still shown to the payer. Enforcing would block every payment on a key rotation or a scheme change, and would break the mock, the demo and any 1Click-compatible server (they sign with other keys). The cost: tampering before payment is not prevented, only reported afterwards. A switch to refuse an unverified quote at checkout would be a new setting.
- **The signing key is a constant**, not a setting. If 1Click rotates it, `proofVerified` turns `false` until Tilll is updated.
- The status payload carries no signature of its own; its `quoteResponse` is the same signed quote. The signature does not cover the status value, so `proofVerified` says the quote is genuine, not that the swap succeeded (the README says so).

## 17. Product repositioning (2026-11-09)

**Decided by the human:** lead with cross-chain payments, self-hosting, open source, privacy and security; refunds become one feature. Treat Tilll as a product. The landing page is the repository's site; the container needs only the dashboard. Buttons use a non-green primary (navy, the logo colour). "Censorship-resistant" is not claimed. Widget: redesign, no new options.

**What changed:** `/` redirects to `/dashboard`, `SERVE_LANDING` and `src/routes/landing.ts` are gone (an old `.env` line is ignored, tested). `site/` builds to `site/dist/`; `.github/workflows/pages.yml` publishes it (actions pinned to commits, no secrets, no install scripts, deploy job has the only write permissions). The site was rewritten (values, payments band, features, "what Tilll depends on"); the widget has a step header, progress bar, token rows and footer; the dashboard `brand` button is gone. PLAN.md carries a dated amendment.

**Why each claim is allowed on the page:** "sets no cookies, keeps nothing in the browser, loads nothing elsewhere" is `test/privacy.test.ts`; "Tilll takes no fee" is that Tilll never sets `appFees` (`pnpm dry-quote` shows any as added by 1Click); "private" is stated with its limit (1Click sees quote requests; chains are public); the dependency on 1Click is a section of its own.

**Deviations from the approved plan:** `actions/configure-pages` was left out (the site uses relative paths); action SHAs came from `git ls-remote` because `gh` is not installed; the focus ring is `#6366F1` on light (the requested `#818CF8` is 2.9:1 on white) and `#818CF8` on dark.

**Landing page v2 (same day):** the human found the first rewrite unprofessional and too technical. Rewritten from a read of Stripe, MoonPay Commerce, Plausible and Cal.com: one outcome headline, two buttons, short tiles, no tech talk. "Why self-hosted", "What Tilll depends on" and the payments band are gone; the cookies footer line is gone. `test/site.test.ts` enforces a banned-word list, tile and page word limits, and that NEAR Intents is named only in the hero and footer. **Confidential payments are not claimed:** the real recorded dry quote echoes `confidentiality: "public"` and Tilll does not use NEAR Intents' confidential mode (a new feature, not verifiable without a mainnet payment).

**Not verifiable here:** the Pages workflow itself (it only runs on GitHub). The owner sets Settings > Pages > Source to GitHub Actions once, after pushing.

## 18. Widget v2: network then token, images, alignment (2026-11-10)

**Where tokens come from:** 1Click's `/v0/tokens` (216 tokens on 2026-11-10), cached 10 minutes by `src/oneclick/tokens.ts`, served by `/pay/tokens`. Not hard-coded. Hard-coded: 11 network display names, the popular-first order, and the address checks (`STRICT_CHAINS`).

**Decisions (human):** the refund address stays required (1Click needs one on every quote and there is no safe fallback, PLAN section 3); images come through a server-side proxy.

**What changed:** the picker is two steps, network then token (PLAN section 12 step 2 already said "Choose chain -> token"); the progress bar has four steps; "Pay with a different token" returns to the same network's list. Copy no longer names the settlement asset. Pay-screen notes are centered and the transaction link has room above the Close button.

**Images:** 1Click's token list has no image field (checked: assetId, blockchain, contractAddress, decimals, price, priceUpdatedAt, symbol, and a coin-listing id Tilll does not use). NEAR Intents' explorer (explorer.near-intents.org) and near.com both ship their icons as static files in their own sites, found by name: `/icons/token/<lowercase symbol>.png` (128x128 PNG) and `/icons/network/<name>.svg` (`btc.svg` for Bitcoin). NEAR Intents publishes no icon API and the explorer has no published terms or robots.txt; it answers images with `access-control-allow-origin: *`. So this is an unofficial, best-effort source, and the README says so.

**How it works (`src/icons.ts`):** a snapshot of the current images ships in `public/icons` (`pnpm icons:update` adds what is missing). At run time the order is memory, the snapshot, `DATA_DIR/icons`, then the explorer; the image is kept, and served at `/pay/icons/*` from Tilll's own address, so a payer's browser never contacts the explorer. A check a minute after start and then daily (only when `main.ts` asks: `syncIcons`) downloads images for tokens the snapshot lacks. Tokens are found by lowercase symbol (plain letters and digits only; the same logo for a symbol on every network); networks by a fixed map from 1Click's ids (`near` uses `near_dark.svg`, because the plain file is a white mark that vanishes on the light badge). An explorer miss is remembered for a day. Without a picture the widget shows a letter badge. Only https://explorer.near-intents.org is ever asked, with redirects refused, a 5 s limit and 100 kB; png, jpeg and webp are accepted, and an SVG only through `isSafeSvg` (no script, handler, foreign object, entity, animation or outside link) and served with a sandboxing policy.

**The explorer's table (same day, the human's idea):** the explorer's source is not public (GitHub has only third-party explorers), but the browser script every visitor downloads carries a table from asset id to picture file, 493 entries. It covers all 216 of 1Click's tokens: 208 map to one of 99 files (86 png, 5 webp, 5 svg, 3 jpg) and 8 map to nothing (FRAX, sUSDC on Base and Solana, FMS, TESTNEBULA, SSC1_PIT, STJACK, tMU). Its choices are more generous than guessing by symbol: wNEAR shows NEAR, USDT0 shows USDT, USDCx and TLO and the Morpho vault shares (laUSDC, mwUSDC, sparkUSDC, steakUSDC, gtUSDCp) show USDC, hemiBTC shows BTC, nrUsdt shows USDT, NearKat shows kat.png, wNEARKAT shows nearkat.jpg. Tilll follows the table, so its checkout matches what NEAR Intents shows. `pnpm icons:update` reads the table from the script as text (never runs it; `scripts/explorer-table.ts`) and writes `public/icons/token-map.json`; at run time Tilll reads that file and never the explorer's script. A token the table does not know yet falls back to `<lowercase symbol>.png`; a token the table maps to nothing is not asked for.

**Snapshot:** 99 token images (86 png, 5 webp, 5 svg, 3 jpeg) and 11 network SVGs, 930 kB, built 2026-11-10; 208 of 216 tokens have a picture and the other 8 show letters, as in the explorer. An earlier guess (a short alias list for wNEAR and USDT0, checked by price and issuer) was replaced by the table.

**An earlier image source was removed** at the human's request on the same day (snapshot rebuilt; no file from it remains). The logos belong to their projects; the README says so. No setting was added.

**Unreproduced:** one full-suite run failed once (1 test of 1275) during this work and passed in 15 later runs; the output was not kept. If it recurs, capture the run.

## Reproduce

```bash
pnpm test                                            # no network
pnpm dry-quote --from base:USDC --amount 5     # live dry quote
pnpm dry-quote --from eth:ETH --amount 5       # compare appFees
pnpm dry-quote --from sol:SOL --amount 5       # expect: 400 "refundTo is not valid" plus the --refund-to hint
pnpm dry-quote --from stellar:XLM --amount 5 --refund-to GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7
                                                     # expect: 400 "Quoting for this pair is not available" (MEMO mode accepted)
```

The `intents.near` view calls use plain JSON-RPC `query` / `call_function` with `finality: final`; the probe was a throwaway script and is not in the repo.
