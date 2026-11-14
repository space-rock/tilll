import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiverServer, type ReceivedEvent } from "../demo-store/webhook-receiver.js";
import { signNep413 } from "../src/near/nep413.js";
import { startTilll } from "../src/start.js";
import { startFakeNear } from "./helpers/fakeNear.js";
import { startFakeOneClick } from "./helpers/fakeOneClick.js";
import { TEST_SECRET } from "./helpers/refundWorld.js";

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const AUTH = { authorization: "Bearer sk_test_secret", "content-type": "application/json" };

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.toReversed()) await fn();
  cleanup = [];
});

const until = async (check: () => Promise<boolean> | boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** One installation: a fake 1Click, a fake NEAR node, a merchant endpoint, and a data folder that outlives each server run. */
async function install() {
  const fake = await startFakeOneClick();
  const near = await startFakeNear("100000000");
  const received: ReceivedEvent[] = [];
  const receiver = createReceiverServer({ secret: "whsec_restart", onEvent: (e) => void received.push(e) });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const dataDir = mkdtempSync(join(tmpdir(), "tilll-restart-"));
  cleanup.push(
    () => fake.close(),
    () => near.close(),
    () => new Promise<void>((done) => (receiver.closeAllConnections(), receiver.close(() => done()))),
    () => rmSync(dataDir, { recursive: true, force: true }),
  );
  const env = {
    ONECLICK_BASE_URL: fake.url,
    NEAR_RPC_URL: near.url,
    DATA_DIR: dataDir,
    SETTLEMENT_ACCOUNT_ID: "shop-pay.near",
    SETTLEMENT_ASSET_ID: USDC_NEAR,
    MERCHANT_SECRET: "sk_test_secret",
    WEBHOOK_URL: `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hooks/tilll`,
    WEBHOOK_SECRET: "whsec_restart",
  };
  const run = async () => {
    const tilll = await startTilll(env, { port: 0, host: "127.0.0.1" });
    return {
      tilll,
      api: (path: string, init: RequestInit = {}) => fetch(`${tilll.url}${path}`, { headers: AUTH, ...init }),
    };
  };
  const db = () => new Database(join(dataDir, "tilll.db"));
  return { fake, received, run, db };
}

/** A paid invoice, written straight into the database (waiting for the watcher's timer would only slow the test). */
function seedPaidInvoice(db: Database.Database, id = "inv_paid") {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO invoices (id, amount, asset_id, settlement_account, status, paid_attempt_id, expires_at, created_at, updated_at)
     VALUES (?, '5000000', ?, 'shop-pay.near', 'paid', 'att_paid', ?, ?, ?)`,
  ).run(id, USDC_NEAR, at, at, at);
  db.prepare(
    `INSERT INTO attempts (id, invoice_id, origin_asset, origin_chain, origin_symbol, origin_decimals, refund_to,
       deposit_address, amount_in, min_amount_in, deadline, quote_json, oneclick_status, status, created_at, updated_at)
     VALUES ('att_paid', ?, ?, 'base', 'USDC', 6, '0x1111111111111111111111111111111111111111', '0xPAID', '5051500',
       '5001000', ?, '{}', 'SUCCESS', 'paid', ?, ?)`,
  ).run(id, BASE_USDC, at, at, at);
}

type Api = (path: string, init?: RequestInit) => Promise<Response>;

/** The merchant's wallet: prepare the refund, sign what the server prepared, send the signature back. */
async function approve(api: Api, refundId: string) {
  const prepared = (await (await api(`/v1/refunds/${refundId}/prepare`, { method: "POST", body: "{}" })).json()) as {
    payload: Parameters<typeof signNep413>[1];
  };
  const signed = signNep413(TEST_SECRET, prepared.payload);
  return api(`/v1/refunds/${refundId}/submit`, {
    method: "POST",
    body: JSON.stringify({ publicKey: signed.public_key, signature: signed.signature }),
  });
}

describe("restarting Tilll in the middle of things", () => {
  it("picks a refund up where it was, and the merchant still hears about it", async () => {
    const { fake, received, run, db } = await install();

    // run 1: a refund is requested and submitted, then the server goes away before 1Click finishes it
    const first = await run();
    const side = db();
    seedPaidInvoice(side);
    const requested = await first.api("/v1/invoices/inv_paid/refunds", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "k", amount: "2.00" }),
    });
    expect(requested.status).toBe(201);
    const { refund } = (await requested.json()) as { refund: { id: string } };
    expect((await approve(first.api, refund.id)).status).toBe(200);
    await first.tilll.stop();
    const { deposit_address: address } = side.prepare("SELECT deposit_address FROM refunds").get() as {
      deposit_address: string;
    };
    side.close();

    // while it was down, 1Click completed the refund
    fake.setStatus(address, "SUCCESS");

    // run 2: same data folder
    const second = await run();
    cleanup.push(() => second.tilll.stop());
    await until(async () => {
      const detail = (await (await second.api("/v1/invoices/inv_paid")).json()) as { refunds: { status: string }[] };
      return detail.refunds[0]?.status === "succeeded";
    }, "the refund to be found succeeded");

    const detail = (await (await second.api("/v1/invoices/inv_paid")).json()) as {
      invoice: { refundedAmountBase: string };
    };
    expect(detail.invoice.refundedAmountBase).toBe("2000000");
    await until(() => received.some((e) => e.type === "refund.succeeded"), "the refund.succeeded webhook");
    expect(received.filter((e) => e.type === "refund.succeeded")).toHaveLength(1);
    expect(fake.submitted).toHaveLength(1); // the restart did not send it again
  });

  it("delivers a webhook that was queued but not sent when the server stopped", async () => {
    const { received, run, db } = await install();
    const first = await run();
    await first.tilll.stop();

    // an event waiting in the outbox, as if the server had stopped before its turn came
    const side = db();
    const at = new Date().toISOString();
    side
      .prepare(
        `INSERT INTO webhook_deliveries (id, event_type, payload_json, attempts, next_try_at, created_at)
         VALUES ('evt_waiting', 'invoice.paid', ?, 0, ?, ?)`,
      )
      .run(JSON.stringify({ id: "evt_waiting", type: "invoice.paid", createdAt: at, data: {} }), at, at);
    side.close();

    const second = await run();
    cleanup.push(() => second.tilll.stop());
    await until(() => received.some((e) => e.id === "evt_waiting"), "the waiting webhook");
    expect(received.filter((e) => e.id === "evt_waiting")).toHaveLength(1);
  });

  it("does not refund a second time when the same request is repeated after a restart", async () => {
    const { fake, run, db } = await install();
    const first = await run();
    const side = db();
    seedPaidInvoice(side);
    const body = JSON.stringify({ idempotencyKey: "same-key", amount: "2.00" });
    const one = await (await first.api("/v1/invoices/inv_paid/refunds", { method: "POST", body })).json();
    expect((await approve(first.api, (one as { refund: { id: string } }).refund.id)).status).toBe(200);
    await first.tilll.stop();
    side.close();

    const second = await run();
    cleanup.push(() => second.tilll.stop());
    const again = await second.api("/v1/invoices/inv_paid/refunds", { method: "POST", body });

    expect(again.status).toBe(200);
    const two = (await again.json()) as { replayed: boolean; refund: { id: string } };
    expect(two).toMatchObject({ replayed: true, refund: { id: (one as { refund: { id: string } }).refund.id } });
    expect(fake.submitted).toHaveLength(1);
  });

  it("keeps a refund that is waiting for approval, and it can be approved after the restart", async () => {
    const { fake, run, db } = await install();
    const first = await run();
    const side = db();
    seedPaidInvoice(side);
    const asked = (await (
      await first.api("/v1/invoices/inv_paid/refunds", {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "k", amount: "2.00" }),
      })
    ).json()) as { refund: { id: string; status: string } };
    expect(asked.refund.status).toBe("awaiting_approval");
    await first.tilll.stop();
    side.close();

    const second = await run();
    cleanup.push(() => second.tilll.stop());
    const listed = (await (await second.api("/v1/refunds?status=awaiting_approval")).json()) as {
      refunds: { id: string }[];
      counts: Record<string, number>;
    };
    expect(listed.refunds.map((r) => r.id)).toEqual([asked.refund.id]);
    expect(listed.counts.awaiting_approval).toBe(1);
    expect(fake.submitted).toHaveLength(0);

    expect((await approve(second.api, asked.refund.id)).status).toBe(200);
    expect(fake.submitted).toHaveLength(1);
  });
});
