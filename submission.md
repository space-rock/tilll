# Submission kit

Everything for the NEAR HACKATHON form and the X post. The deadline is 2026-11-14, 23:59 UTC. A submission can't be edited afterwards (changes go through https://nearhackathon.com/request-changes), and each repository can be submitted once, so read the checklist first.

## Form fields

| Field | Value |
|---|---|
| `projectName` | `Tilll` |
| `tracks` | `realworld` (Real-World Money) and `defi` (Unstoppable DeFi) |
| `projectUrl` | `https://github.com/space-rock/tilll` |
| `demoUrl` | the URL of your X post (see below) |
| `idea` | the description below |
| `leadName` | your name, 2 to 80 characters |
| `email` | your email. The form takes at most two submissions per email |
| `size` | the size of the team, written exactly as the form lists it (`1`, `2 - 4`, and so on) |
| `nearAddress` | a mainnet NEAR account you created, which receives the prize |
| `consent` | `true`, only after you've read the notice: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

`requestId` is a UUID made at submit time and reused on retries. Don't add a `website` field (it's a spam trap). Don't commit the filled form, because it holds personal data.

Tilll fits `realworld` because it's merchant payments on stablecoin rails that a normal shop could run tomorrow. It fits `defi` because every payment and refund settles across chains through NEAR Intents with no custodian.

## Project description (paste into the form, 1,991 characters; the limit is 2,000)

```
Taking crypto payments usually means choosing one chain, trusting a hosted processor to hold the money, or both. Tilll is a checkout you run yourself. A customer pays with the token they already hold, on the chain they hold it. You get exactly the invoice amount in the asset you choose, USDC on NEAR by default, in your own NEAR Intents account. It's one container and a SQLite file, MIT licensed, with no fee of its own. The checkout asks for no name, email, account or cookie.

NEAR Intents is the backbone. Customers pay from 18 networks (EVM chains, Solana, Bitcoin, Tron and NEAR), and Tilll has no bridge, node or chain SDK for any of them: each payment is one 1Click quote with a deposit address and the exact amount, and the merchant receives USDC on NEAR. The money lands in the merchant's own account on intents.near. The server holds no wallet and sends no NEAR transaction, and anyone can read the balance from a public RPC. A refund is a NEP-413 intent that the merchant's wallet signs in the dashboard, and the server checks the intent before the wallet sees it, so no key on the server can spend the money. Changing the settlement account also needs a signature from that account.

It ran on mainnet on 2026-11-13: three payments (two from NEAR, one from Base) and one refund, all small amounts. 1Click's quote signature verified on every payment. The live demo shop takes real payments of a few cents at https://tilll.up.railway.app/shop and lists them, with their transactions, at /invoices. 1,617 automated tests pass, including full pay and refund runs against a mock 1Click that speaks the real HTTP API.

Payments aren't confidential: the deposit and the merchant's balance are public on NEAR. One deployment serves one merchant, and a refund to another chain hasn't run on mainnet yet. The repo has the checkout widget, the dashboard, signed webhooks, an embed script and a hosted page, a five-minute quick start that needs no funds, and a demo shop on a mock network.
```

## X post

The post opens with the problem, tells one complete moment, says what NEAR does, links the code and asks a question. Attach `brand/mainnet-recording/tilll-demo.mp4`. It's 606 characters as X counts them, so it needs a long post (X Premium). Without that, use the short version below. @NearLegion and @NearBuilders are optional extra tags.

```
Taking crypto payments shouldn't mean picking one chain or letting someone else hold the money.

Tilll is a checkout you run yourself. A customer pays with the token they already hold, on the chain they hold it. You get USDC in your own NEAR Intents account. When you refund, your wallet signs it and the money goes back on their chain.

Built at NEAR HACKATHON. NEAR Intents settles every payment across chains. It has run on mainnet (3 payments, 1 refund), and 1,617 tests pass.

Try it: https://tilll.up.railway.app/shop
Code: https://github.com/space-rock/tilll

Would you run your own checkout? @NEARProtocol #NEARHackathon
```

### Short version (for an account without long posts)

X counts every link as 23 characters, so this is under 280.

```
Tilll: a crypto checkout you run yourself. Customers pay with the token they hold, on 18 networks. You get USDC in your own NEAR Intents account.

Built at NEAR HACKATHON.

Try it: https://tilll.up.railway.app/shop
Code: https://github.com/space-rock/tilll

@NEARProtocol #NEARHackathon
```

### The video, in order

`brand/mainnet-recording/tilll-demo.mp4` is 90 seconds, with no audio and room for your own voice. The narration lines are in `scripts/demo-video.md`.

1. The Tilll logo, then a screen of twelve highlights.
2. The embed snippet, then a demo shop and its checkout dialog. Those two scenes are the mock demo, and the captions say so.
3. A real payment on mainnet: the customer picks NEAR and USDC, enters a refund address, and sends 0.101011 USDC from a wallet. The page changes to "Payment received".
4. The dashboard: the paid invoice with 1Click's signature verified, the balance, and the signed webhook.
5. A payment from Base, shown in the dashboard and on BaseScan.
6. A refund: the invoice timeline through "Refund completed", the Refunds page, and the transaction on NearBlocks.

`scripts/video/build.py` rebuilds it. The clip of the wallet signing a refund isn't in it, because that was recorded separately by the author. Add it if you want it.

## Checklist (things only you can do)

- [x] `pnpm check` passes: 84 test files, 1,617 tests (14 Nov 2026).
- [x] The live demo shop is deployed (`scripts/live-demo.md`) at https://tilll.up.railway.app/shop, and the README links it near the top.
- [ ] Commit the last changes and push, then redeploy the live demo so it runs the same code.
- [x] The repository is public, with LICENSE and README in place. It has to stay public through judging.
- [ ] Optional: tag the commit `hackathon-submission` (HACKATHON.md Q-003). There's no baseline code, so no `pre-hackathon` tag is needed.
- [ ] `github` is set in `site/links.json`. Set `demoVideo` once the post exists, and redeploy the live demo, so the landing page shows both. (There is no GitHub Pages deployment: the live demo serves the site.)
- [ ] Post the video on X with the text above, and copy the post's URL.
- [ ] Add a "Demo video" line with that URL near the top of `README.md`.
- [ ] Re-read https://nearhackathon.com/HACKATHON.md for changes to the rules or the dates.
- [ ] Submit the form once, with the values above. Both READMEs name the other project already: Tilll's names Contagion, and Contagion's names Tilll.
- [ ] Keep anything you host up until 2026-11-18, and ideally 2026-11-25. That means the live demo on Railway: the README and the form text link it.

## Known gaps to be honest about in the post

- Payments aren't confidential. The deposit and the merchant's balance are public on NEAR, and the 1Click quotes request `confidentiality: public`. The checkout is private (no account, name, email or cookie), and the money isn't.
- Mainnet ran with small amounts: three payments and one refund. A refund to another chain, such as back to Base, hasn't run on mainnet yet.
- One deployment serves one merchant, and one settlement asset at a time.
- The customer has to give a refund address, because 1Click needs one on every quote.
- The customer pays the swap fee on top of the invoice. Tilll adds no fee of its own.
