# Run the live demo (Railway, on mainnet)

This puts the demo on a public address: the landing page at `/`, the docs at `/docs`, the cart shop at `/shop`, a read-only list of its orders at `/invoices`, and Tilll's own checkout and dashboard (`/dashboard`) on the same address. The shop sells six coffee items at $0.25 and $0.50, the checkout opens from a cart drawer, and the payments are real: they settle into `tilll.near` through NEAR Intents. You run every command here yourself, because the deploy needs your Railway account and your secrets.

## How it's separated from Tilll

The demo has its own image, `Dockerfile.demo`, and its own code in `demo/`. The Tilll you run yourself is the plain `Dockerfile`, and it has no shop, no site and no demo routes. `Dockerfile.demo` builds the same Tilll and starts it with `demo/main.ts`, which adds the shop and the site through one hook (`startTilll`'s `extend` option). Locally, `pnpm demo:live` does the same from source.

## Why not Netlify, or a static host

A static host can serve the project site (`site/`) and nothing else. The checkout needs the Tilll server: a process that keeps running (it polls payments and retries webhooks), a SQLite file on a disk that survives restarts, and the merchant secret that creates invoices. So the demo runs on a container host, and it serves the site itself. There is no GitHub Pages deployment.

## What it costs

On Railway's free plan, a service gets up to 1 vCPU and 0.5 GB of RAM, plus a 0.5 GB volume. A new account starts with a 30-day trial with $5 of credit, then the free plan gives $1 of credit a month. That covers the judging window (until 2026-11-25). Tilll for this shop uses a few megabytes of disk. Check your usage page after a day, and note that trial and free-plan data is deleted 30 days after the plan ends.

Render works too, but its free web services have no persistent disk, so a restart would lose the database (invoices and refund records). On Render use a paid instance with a disk mounted at `/app/data`, set `PORT=8080` yourself, and point it at `Dockerfile.demo`.

## Before you start

1. The repository is on GitHub (public or private; Railway can read both once you connect it), with `Dockerfile.demo` pushed.
2. You have the wallet for `tilll.near` (Intear). It signs refunds, and nothing else can move the money.
3. Two long random secrets. Make them with `openssl rand -hex 32` (twice). Keep them out of the repository, chats and screenshots.

## Deploy

1. In Railway, choose New Project, then Deploy from GitHub repo, and pick this repository.
2. In the service's Variables tab, add:

   | Variable | Value |
   |---|---|
   | `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.demo` (so Railway builds the demo image, not the default `Dockerfile`) |
   | `SETTLEMENT_ACCOUNT_ID` | `tilll.near` |
   | `MERCHANT_SECRET` | the first secret |
   | `WEBHOOK_SECRET` | the second secret |
   | `WEBHOOK_URL` | `http://127.0.0.1:8080/shop/hooks` (the demo checks its own signed webhooks) |
   | `PORT` | `8080` |
   | `TRUST_PROXY` | `1` |
   | `PUBLIC_BASE_URL` | `https://<your-domain>` (add it after step 4) |
   | `ALLOWED_ORIGINS` | `https://<your-domain>` (add it after step 4) |
   | `RAILWAY_RUN_UID` | `0` (so the container can write to the volume) |

   Remove `SHOP_ENABLED` and `SITE_ENABLED` if you added them earlier: they no longer exist. Everything else has a default: USDC on NEAR is the settlement asset, the payment window is 30 minutes, the refund limits are 50 and 200 USDC. `ONECLICK_API_KEY` is optional. The first build takes a few minutes.
3. Add a volume to the service (the service's right-click menu or the command palette, New Volume) and mount it at `/app/data`. The database lives there. A service can have one volume.
4. In the service settings, set the healthcheck path to `/checkout.js`, then under Networking choose Generate Domain with port 8080. Copy the `https://…` address into `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS`, and redeploy.

## Check it

1. Open `https://<your-domain>/`. You see the landing page, and `/docs` shows the docs.
2. Open `https://<your-domain>/shop`. You see six products. Add something and open the cart.
3. Press Pay with crypto, pick NEAR and USDC, enter a refund address and Continue. You see a payment address and an exact amount. You don't have to pay.
4. Open `https://<your-domain>/invoices`. You see the shop's orders, read-only, and the order from step 3 is listed as open. Judges can use this page without the merchant secret.
5. Open `https://<your-domain>/dashboard` and sign in with `MERCHANT_SECRET`. The invoice from step 3 is there, with `tilll.near` as the settlement account.
6. Press Connect wallet and sign in as `tilll.near`. A named account registers its key with NEAR Intents the first time it approves a refund, and the dashboard offers Register key then.
7. Optional, with a few cents: pay one item from NEAR and watch the order turn into Order confirmed. Then refund it from the dashboard.

## The links on the site

`site/links.json` has `liveDemo` set to `https://tilll.up.railway.app/shop`. Change it if your domain differs. It has to be https. The links are baked into the pages when the image is built, so a change needs a redeploy. When the repository is public, set `github` too (and `demoVideo` once the video is posted), and redeploy. With a link unset, every button and sentence that needs it is left out.

## What to know

- The payments are real and land in `tilll.near`. Refunds need your wallet, so decide how you'll handle a request for one.
- The shop caps an order at $3.00, five of one item, ten orders a minute per visitor, and 300 orders an hour in total, and an order expires after 30 minutes. A visitor can't change a price: the page sends product ids and counts, and the server prices them.
- The checkout asks for a refund address, and any failed swap is refunded there by 1Click.
- Keep the service running until judging ends (2026-11-25).
- `/dashboard` is public but needs `MERCHANT_SECRET`, and the login allows 10 tries a minute. Use a long secret.

## If something goes wrong

- The app starts without `/shop` or `/docs`: Railway built the plain `Dockerfile`. Check that `RAILWAY_DOCKERFILE_PATH` is exactly `Dockerfile.demo`. The plain `Dockerfile` builds the default Tilll, which has no demo.
- `Dockerfile.demo` has no `VOLUME` line, because Railway rejects it ("VOLUME at line 27 is not supported, use Railway Volumes"). The plain `Dockerfile` keeps its own `VOLUME` line, which is fine outside Railway. The demo's database only survives a restart if you mount a volume on `/app/data` (step 3).
- The log shows a permission error writing `/app/data`: check that `RAILWAY_RUN_UID` is `0` and that the volume is mounted at `/app/data`.
- The deploy never becomes healthy: check that `PORT` is `8080` and that the healthcheck path is `/checkout.js`.
- The rate limits: `TRUST_PROXY=1` tells Tilll to believe one proxy hop, which is what a single reverse proxy in front gives you. The Railway pages I read don't state the hop count. A wrong value either makes all visitors share one limit (the shop slows down) or lets a visitor fake an address (the per-visitor limit weakens). The hourly cap of 300 orders doesn't depend on addresses, so it holds either way.
- Token list slow on the first load: the first request after a cold start can take several seconds while Tilll fetches 1Click's token list. Open `/shop` and press Pay once before you share the link.
