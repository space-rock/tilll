import { describe, expect, it } from "vitest";
import { renderPage, type PublicInvoice } from "../demo/invoices/routes.js";
import { makeDemoApp } from "./helpers/liveDemo.js";
import { REFUND_ADDRESS, USDC_BASE, statusResponseFor } from "./helpers/world.js";

type Demo = Awaited<ReturnType<typeof makeDemoApp>>;
const TX = "0xcc1b58a67691fa3abe1a5849d62810c8478e604a4b7c57f9882e4fd3a6a72e15";

const order = async (t: Demo, items: { id: string; qty: number }[]) =>
  (await t.app.inject({ method: "POST", url: "/shop/api/invoices", payload: { items } })).json().invoiceId as string;

/** An order that was paid from Base, the way 1Click reports it. */
async function paidOrder(t: Demo) {
  const id = await order(t, [
    { id: "cortado", qty: 2 },
    { id: "croissant", qty: 1 },
  ]);
  const attempt = await t.service.createAttempt(id, { originAsset: USDC_BASE, refundTo: REFUND_ADDRESS });
  t.service.applyStatus(
    attempt.id,
    statusResponseFor(attempt.quote, "SUCCESS", { originChainTxHashes: [{ hash: TX, explorerUrl: "" }] }),
  );
  return { id, attempt };
}

describe("GET /invoices.json and /invoices", () => {
  it("lists the orders the shop made, newest first, and nothing else", async () => {
    const t = await makeDemoApp();
    t.service.createInvoice({ amount: "5", description: "A merchant's own invoice", metadata: { orderId: "A-1" } });
    const first = await order(t, [{ id: "espresso", qty: 1 }]);
    const second = await order(t, [{ id: "cappuccino", qty: 2 }]);

    const res = await t.app.inject({ method: "GET", url: "/invoices.json" });

    expect(res.statusCode).toBe(200);
    const { invoices } = res.json();
    expect(invoices.map((i: PublicInvoice) => i.id).toSorted()).toEqual([first, second].toSorted());
    expect(invoices.find((i: PublicInvoice) => i.id === second)).toMatchObject({
      items: [{ name: "Cappuccino", qty: 2 }],
      amount: "1",
      asset: "USDC",
      status: "open",
      paidWith: null,
      transactions: [],
      refunds: [],
    });
    expect(res.body).not.toContain("A merchant's own invoice");
  });

  it("shows how a paid order was paid, with a link to the transaction on the right explorer", async () => {
    const t = await makeDemoApp();
    const { id } = await paidOrder(t);

    const { invoices } = (await t.app.inject({ method: "GET", url: "/invoices.json" })).json();
    const invoice = invoices.find((i: PublicInvoice) => i.id === id);

    expect(invoice).toMatchObject({ status: "paid", amount: "1" });
    expect(invoice.paidWith).toMatchObject({ symbol: "USDC", chain: "Base" });
    expect(invoice.transactions).toEqual([{ hash: TX, url: `https://basescan.org/tx/${TX}` }]);
    const html = (await t.app.inject({ method: "GET", url: "/invoices" })).body;
    expect(html).toContain("Paid");
    expect(html).toContain(`href="https://basescan.org/tx/${TX}"`);
    expect(html).toContain("2 × Cortado, 1 × Croissant");
  });

  it("keeps a paid order on the page however many unpaid orders come after it", async () => {
    const t = await makeDemoApp();
    const { id } = await paidOrder(t);
    for (let n = 0; n < 120; n++) {
      t.service.createInvoice({ amount: "0.25", metadata: { source: "shop", items: [{ name: "Espresso", qty: 1 }] } });
    }

    const { invoices } = (await t.app.inject({ method: "GET", url: "/invoices.json" })).json();

    expect(invoices.find((i: PublicInvoice) => i.id === id)).toMatchObject({ status: "paid" });
    const ids = invoices.map((i: PublicInvoice) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.toSorted().toReversed());
  });

  it("never shows a refund address, a deposit address or a quote", async () => {
    const t = await makeDemoApp();
    const { attempt } = await paidOrder(t);

    for (const url of ["/invoices.json", "/invoices"]) {
      const body = (await t.app.inject({ method: "GET", url })).body;
      expect(body).not.toContain(REFUND_ADDRESS);
      expect(body).not.toContain(attempt.depositAddress);
      expect(body).not.toMatch(/refundTo|depositAddress|quote|signature|merchant/i);
    }
  });

  it("is a page with no script, no framing and no caching, that refreshes itself", async () => {
    const t = await makeDemoApp();
    const res = await t.app.inject({ method: "GET", url: "/invoices" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).toContain('http-equiv="refresh"');
    expect(res.body).toContain("No orders yet");
    expect((await t.app.inject({ method: "GET", url: "/invoices.css" })).headers["content-type"]).toMatch(/css/);
  });

  it("escapes what it prints", () => {
    const invoice: PublicInvoice = {
      id: "inv_1",
      createdAt: "2026-11-14T10:00:00.000Z",
      items: [{ name: "<script>alert(1)</script>", qty: 1 }],
      amount: "0.25",
      asset: "USDC",
      status: "paid",
      paidWith: { amount: "0.25", symbol: "<b>X</b>", chain: "Base" },
      transactions: [{ hash: "0xabc", url: 'https://x.example/"onmouseover="alert(1)' }],
      refunds: [],
    };
    const html = renderPage([invoice], "2026-11-14T10:00:00.000Z");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>X</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('"onmouseover="');
  });

  it("is not on a Tilll the demo was not mounted on", async () => {
    const { makeApp } = await import("./helpers/app.js");
    const plain = await makeApp();
    for (const url of ["/invoices", "/invoices.json", "/invoices.css"]) {
      expect((await plain.app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});
