# Demo: one complete moment, in about 80 seconds

The story: **a customer pays from another chain, and the merchant is paid in USDC into their own account, on their own server.** The refund is one short beat at the end, not the headline. Show it end to end, with real transactions in the explorers. This page is a script and a checklist; the recording and the post are yours to make.

There are two versions. **Use the real one for the video.** Use the mock one only for screenshots, and never present it as real money.

| | Real (mainnet) | Mock |
|---|---|---|
| Needs | about 5 dollars of USDC on Base, your own wallet, a few cents of ETH for gas | nothing |
| Run | the two runbooks, then this script | `pnpm demo` |
| Proves | the whole claim, on real chains | the interface and the flow only |
| Say in the video | nothing special | "this is a mock payment network, no real funds" (say it out loud and show it on screen) |

## Before you record (real version)

Do these once, off camera. Do not record until every line is ticked: a refund that fails on camera is a worse demo than a short one that works.

1. Run [`scripts/mainnet-smoke.md`](mainnet-smoke.md) all the way to the end. **Expect** the invoice `paid`, and an `invoice.paid` line ending `1Click proof: verified` (if it says `NOT verified`, tell your coding agent before going on).
2. Run [`scripts/mainnet-refund.md`](mainnet-refund.md) on that payment. **Expect** the refund `succeeded` and the USDC back in your wallet.
3. Have about 5 USDC on Base in the wallet you will pay from, and use **that wallet's own address** as the refund address.
4. Start Tilll (`pnpm build && pnpm start:prod`, or `docker compose up --build`) and the webhook receiver (`set -a; source .env; set +a; pnpm webhook-receiver`) in two terminals.
5. Put the demo shop or a plain invoice page where the customer will pay: `pnpm demo` serves the shop only against the mock, so for the real version create an invoice with the dashboard's **Create invoice** and open its pay link.
6. Log in to the dashboard once, so the recording starts on the overview.
7. Hide anything secret: never show `.env`, an exported variable, the wallet's seed phrase or the merchant secret on screen. Zoom the browser to about 125 percent and close other tabs. Open a Base explorer tab for each transaction you will show.

## The shots

Write the first line of the post before you record; the video only has to make it true.

| Time | On screen | Say |
|---|---|---|
| 0:00 | The pay page of a 5 dollar invoice | "A customer wants to pay you from Base. You want to be paid in USDC, in your own account, without a payment company in the middle. This is Tilll, running on my own server." |
| 0:08 | Click **Pay with crypto**, choose **USDC on Base**, paste your own Base address as the refund address | "No account, no email. The only thing it asks for is an address for any refund." |
| 0:20 | The deposit address, the exact amount and the QR. Send that amount from your wallet | "One deposit address for this payment, exact amount. NEAR Intents' 1Click API swaps it and settles it." |
| 0:35 | The page goes to **Payment received**; cut to the dashboard: invoice **Paid**, the settlement balance up by the invoice amount | "The merchant's own NEAR Intents balance went up. No middleman holds the money." |
| 0:45 | The webhook log: `invoice.paid`, with `proofVerified` | "The merchant's server is told by a signed webhook." |
| 0:52 | Open the invoice, press **Refund**: the dialog shows what the customer receives, and where | "A refund is one signed NEAR Intents transfer from that same balance, to the address the customer gave. It returns today's value." |
| 1:00 | **Confirm refund**; the progress becomes **Refunded** | "No second deposit step: the money was already in the balance." |
| 1:10 | The two Base explorer pages: the payment, and the refund | "Paid on Base, refunded on Base." |
| 1:20 | The README's four setup commands, or the project site | "Open source and self-hosted: one container, your keys. Link below." |

Keep it under 90 seconds. Cut waiting: speed up or cut the 30 seconds between sending and **Payment received**, but never fake a state.

## What to say about NEAR (specific, not "powered by")

- **Cross-chain settlement.** Payments from other chains settle into the merchant's own NEAR Intents account through the 1Click API.
- **Refunds without a deposit step.** A refund is a signed intent (NEP-413) from that balance, executed by NEAR Intents on the customer's chain.
- **Self-custody.** Tilll holds no key that can spend the merchant's money. The merchant approves each refund with their own wallet; Tilll only runs on their server.

## The post

Draft it from the drafts your coding agent prepared. It must:

- lead with the user problem, so the first line makes sense to someone who has never heard of Tilll;
- **not call the payments confidential or private on-chain.** They are not: the deposit and the merchant's balance are public on NEAR (checked on 2026-11-13, see NOTES.md). The true claim is that the checkout asks for no account, name, email or cookie;
- say the project was **built at NEAR HACKATHON**, tag **@NEARProtocol** and **#NEARHackathon** (optionally @NearLegion and @NearBuilders);
- attach the video, say what NEAR does (above), link the public repository, and ask one genuine question.

Say plainly what the demo is. If any part is the mock, say so. Post it yourself, from your own account, and send the link to your coding agent only if you want it checked.

## After you post

1. Make the repository public, then set the two links in `site/links.json` (`github` and `demoVideo`). The live demo serves the site, so redeploy it to publish the new links (`scripts/live-demo.md`). Update the README's **Hackathon** section with the video link.
2. Run `pnpm check` once more.
3. Submit **once**, yourself, at https://nearhackathon.com/#apply (or through its API). A second submission of the same repository is rejected; mistakes are fixed at https://nearhackathon.com/request-changes. The deadline is 2026-11-14T23:59:00Z.
