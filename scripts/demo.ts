// `pnpm demo`: Tilll, a mock payment network and a demo shop, all on this machine. No real funds, no real 1Click.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoStore } from "../demo-store/server.js";
import { startTilll } from "../src/start.js";
import { base58Encode, implicitAccountOf } from "../src/near/keys.js";
import { signNep413 } from "../src/near/nep413.js";
import { startFakeNear } from "../test/helpers/fakeNear.js";
import { startFakeOneClick } from "../test/helpers/fakeOneClick.js";

// Both can be moved when 8080 or 3000 is taken: DEMO_PORT=18080 DEMO_STORE_PORT=13000 pnpm demo
const TILLL_PORT = Number(process.env.DEMO_PORT ?? 8080);
const STORE_PORT = Number(process.env.DEMO_STORE_PORT ?? 3000);
const USDC_ON_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const secret = `sk_demo_${randomBytes(8).toString("hex")}`;
// The demo's stand-in for the merchant's wallet: a throwaway key, and the NEAR implicit account it controls (which needs
// no registration). In real use there is no key in Tilll at all: your own wallet signs in the dashboard.
const walletKey = `ed25519:${base58Encode(randomBytes(32))}`;
const webhookSecret = `whsec_demo_${randomBytes(8).toString("hex")}`;
const dataDir = mkdtempSync(join(tmpdir(), "tilll-demo-"));

// The mock payer sends the money a few seconds after each quote and walks it through confirmation.
const mock = await startFakeOneClick({ autoPay: { stepMs: 6000 } });

// The mock NEAR node reports a balance of 250 USDC, so refunds can be tried. Nothing is ever sent to a real node.
const near = await startFakeNear("250000000");

// Fail closed: the demo must only ever talk to the mocks, never to the real 1Click or a real NEAR node.
for (const url of [mock.url, near.url]) {
  if (new URL(url).hostname !== "127.0.0.1") throw new Error(`Refusing to run: mock URL is not loopback (${url})`);
}

const tilll = await startTilll(
  {
    ONECLICK_BASE_URL: mock.url, // explicit and loopback by construction
    DATA_DIR: dataDir,
    PORT: String(TILLL_PORT),
    SETTLEMENT_ACCOUNT_ID: implicitAccountOf(walletKey),
    NEAR_RPC_URL: near.url,
    SETTLEMENT_ASSET_ID: USDC_ON_NEAR,
    MERCHANT_SECRET: secret,
    WEBHOOK_URL: `http://127.0.0.1:${STORE_PORT}/hooks/tilll`,
    WEBHOOK_SECRET: webhookSecret,
  },
  {
    host: "127.0.0.1",
    // The demo makes no call outside this machine. Token images come from the snapshot in public/icons; a token it lacks
    // shows a letter badge.
    iconFetch: async () => new Response(null, { status: 404 }),
  },
);

if (mock.to("/v0/tokens").length === 0) {
  await tilll.stop();
  await mock.close();
  await near.close();
  throw new Error("Refusing to run: Tilll did not talk to the mock payment network at startup.");
}

const store = createDemoStore({ tilllUrl: tilll.url, merchantSecret: secret, webhookSecret });
await new Promise<void>((resolve, reject) => {
  store.once("error", reject);
  store.listen(STORE_PORT, "127.0.0.1", resolve);
});

// A ready-made invoice for trying the hosted pay page without any shop.
const sample = await fetch(`${tilll.url}/v1/invoices`, {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: JSON.stringify({ amount: "12.50", description: "Sample invoice", expiresInMinutes: 240 }),
});
const { payUrl } = (await sample.json()) as { payUrl: string };

// A refund waits for the merchant's wallet. A real wallet cannot connect to a mock network, so the demo approves each
// refund itself, after a pause long enough to see it waiting: prepare it, sign what the server prepared, send the signature.
const WAIT_MS = 4000;
const call = (path: string, body?: object) =>
  fetch(`${tilll.url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const seen = new Map<string, number>();
const approver = setInterval(() => {
  void (async () => {
    const listed = (await (await call("/v1/refunds?status=awaiting_approval&limit=20")).json()) as {
      refunds?: { id: string }[];
    };
    for (const { id } of listed.refunds ?? []) {
      const first = seen.get(id) ?? Date.now();
      seen.set(id, first);
      if (Date.now() - first < WAIT_MS) continue;
      seen.delete(id);
      const prepared = (await (await call(`/v1/refunds/${id}/prepare`, {})).json()) as {
        payload?: Parameters<typeof signNep413>[1];
      };
      if (!prepared.payload) continue;
      const signed = signNep413(walletKey, prepared.payload);
      const done = await call(`/v1/refunds/${id}/submit`, {
        publicKey: signed.public_key,
        signature: signed.signature,
      });
      console.log(`Demo wallet approved refund ${id} (HTTP ${done.status}).`);
    }
  })().catch(() => undefined);
}, 1500);

console.log(`
Tilll demo is running against a MOCK payment network. No real funds move.

  Demo shop         http://127.0.0.1:${STORE_PORT}
  Hosted pay page   ${payUrl.replace("localhost", "127.0.0.1")}
  Merchant API      ${tilll.url}/v1   (Authorization: Bearer ${secret})
  Dashboard         ${tilll.url.replace("localhost", "127.0.0.1")}/dashboard   (log in with ${secret})

Pick a token, enter any well-formed address (for example 0x1111111111111111111111111111111111111111 on an
EVM chain), and the mock payer "sends" the money a few seconds later. Then open the invoice in the dashboard and
press Refund: it waits for approval for a few seconds, and the demo approves it with a throwaway key, standing in
for your wallet. In real use you approve refunds with your own wallet. Press Ctrl+C to stop.
`);

async function shutdown() {
  clearInterval(approver);
  store.closeAllConnections();
  await new Promise<void>((resolve) => store.close(() => resolve()));
  await tilll.stop();
  await mock.close();
  await near.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
