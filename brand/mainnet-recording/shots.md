# Mainnet recording, 2026-11-13

Real payments through Tilll on mainnet: USDC into the Intents balance of `sarinr.near`. No secret appears in any file here.
Refunds were not recorded here; they are tested and recorded separately.

| File | What it shows |
|---|---|
| `03-near-pay-usdc-mainnet.gif` | Flow A: pay page, NEAR, USDC, refund address, quote, Waiting, Payment received (0.10 USDC) |
| `05-base-pay-usdc-mainnet.gif` | Flow B: Base, USDC, MetaMask refund address, quote, Waiting, Payment received (0.20 USDC) |
| `a1-near-quote-deposit-address.jpg` | Quote: send exactly 0.101011 USDC on NEAR, deposit address, QR |
| `a2` to `a5` | Intear wallet (`tilll.near`): USDC, send form, confirm dialog, "Sent!" |
| `a6-near-payment-received.jpg` | Pay page after payment A |
| `a7-nearblocks-intents-withdraw.jpg` | NearBlocks: `execute_intents` on `intents.near`, the 0.001011 USDC buffer back to `tilll.near` |
| `b1-base-quote-deposit-address.jpg` | Quote: send exactly 0.202064 USDC on Base |
| `b2-base-payment-received.jpg` | Pay page after payment B |
| `b3-basescan-tx.jpg` | BaseScan: 0.202064 USDC from the payer to the deposit address, Success |

## Transactions

- Payment A, invoice `inv_01M7A7T345EX8B04JABTEAMF12` (0.10 USDC, NEAR): https://nearblocks.io/txns/3fENn5eQajkZvzq6dd6xhstRrSMBz3smM3QA42ccaDmx and https://nearblocks.io/txns/GLjw1TDRqLqYyoLFhnC6HwEnKf9J1e6pXjbHPxj2zj5L
- Payment B, invoice `inv_01M7A80E91CM5Z7QS8JP7NREQB` (0.20 USDC, Base): https://basescan.org/tx/0xcc1b58a67691fa3abe1a5849d62810c8478e604a4b7c57f9882e4fd3a6a72e15

## The video

`tilll-demo.mp4`: 90 seconds (played at 1.25x; `SPEED` in the script), 1920 x 1080, 30 fps, **no audio**. Built from the stills in `video-src/` by `scripts/video/build.py` (needs ffmpeg, Pillow, fonttools and brotli; the header of the script says how to run it). Change the order, the captions or the timing in `SCENES` at the top of the script, then run it again. The captions follow the narration in `scripts/demo-video.md`.

The logo and type are the website's (the mark from `brand/tilll-mark.svg`, Manrope ExtraBold and Inter). The pay-page scenes were re-recorded after the copy pass, so they show the current wording. They are a real payment through the real server and wallet:

- Payment C, invoice `inv_01M7ABRDF4GZ0PSKEW9R4TS8JC` (0.10 USDC, NEAR, paid from `tilll.near` in Intear): [6EbbmeyG…](https://nearblocks.io/txns/6EbbmeyGCW2Dub1xruMuhrt5BJiKP3tCK3Tw9e2MnkWX) and [6uDHw2dF…](https://nearblocks.io/txns/6uDHw2dFUVczvsfyVFfqx94tj4rqXGnt7Zot8QjbJRyr)
- The earlier GIFs (`03-…gif`, `05-…gif`) predate the copy pass and show the old wording. They are not used in the video.
- The Base payment and the refund appear as dashboard and explorer scenes (real, unedited), not as a screen recording of the wallet.

The first three scenes after the title are the integration: the README's embed snippet (drawn by the script), then the demo shop (`pnpm demo`) and its checkout dialog. **Those two stills are the mock demo**, and both the caption and the shop's own text say so; every scene after them is real mainnet.

The scene after the title is the highlights screen: twelve tiles (self-hosted, open source, any chain and token, your choice of settlement asset, your own account, no fee of its own, refunds on the customer's chain, wallet-approved refunds, signed webhooks, easy integration, a private checkout, proven on mainnet). Each line is a claim the README makes or the mainnet run showed. **It says nothing about confidential payments**, because they are not confidential: the merchant's balance and each deposit are public on NEAR (NOTES.md, "Confidentiality check"). Edit `HIGHLIGHTS` in the script to change a tile.
