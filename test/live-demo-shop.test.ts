import { describe, expect, it } from "vitest";
import { MAX_TOTAL_CENTS, PRODUCTS, centsToAmount, priceCart } from "../demo/shop/catalogue.js";
import { signPayload } from "../src/webhooks/signature.js";
import { makeApp } from "./helpers/app.js";
import { DEMO_WEBHOOK_SECRET as SECRET, makeDemoApp, publicDir } from "./helpers/liveDemo.js";

const shopApp = (extra: { perMinute?: number; perHour?: number; now?: () => Date } = {}) => makeDemoApp(extra);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const order = (t: Awaited<ReturnType<typeof shopApp>>, items: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "POST", url: "/shop/api/invoices", payload: { items } as object, headers });

describe("the catalogue", () => {
  it("has six products at two prices, three at each", () => {
    expect(PRODUCTS).toHaveLength(6);
    const prices = PRODUCTS.map((p) => p.cents);
    expect([...new Set(prices)].toSorted()).toEqual([25, 50]);
    expect(prices.filter((c) => c === 25)).toHaveLength(3);
    expect(new Set(PRODUCTS.map((p) => p.id)).size).toBe(6);
  });

  it("writes cents as the decimal string an invoice takes", () => {
    expect([5, 25, 75, 100, 300].map(centsToAmount)).toEqual(["0.05", "0.25", "0.75", "1.00", "3.00"]);
  });
});

describe("pricing a cart", () => {
  it("adds up the server's prices and describes the order", () => {
    const cart = priceCart({
      items: [
        { id: "espresso", qty: 2 },
        { id: "croissant", qty: 1 },
      ],
    });
    expect(cart.totalCents).toBe(100);
    expect(cart.amount).toBe("1.00");
    expect(cart.description).toBe("2 x Espresso, 1 x Croissant");
  });

  it("accepts an order of exactly the largest size", () => {
    const cart = priceCart({
      items: [
        { id: "croissant", qty: 5 },
        { id: "espresso", qty: 2 },
      ],
    });
    expect(cart.totalCents).toBe(MAX_TOTAL_CENTS);
    expect(cart.amount).toBe("3.00");
  });

  it.each([
    ["no items", { items: [] }],
    ["not a cart", "espresso"],
    ["an unknown product", { items: [{ id: "tea", qty: 1 }] }],
    ["a quantity of zero", { items: [{ id: "espresso", qty: 0 }] }],
    ["too many of one product", { items: [{ id: "espresso", qty: 6 }] }],
    ["a fractional quantity", { items: [{ id: "espresso", qty: 1.5 }] }],
    ["a quantity as text", { items: [{ id: "espresso", qty: "2" }] }],
    [
      "the same product twice",
      {
        items: [
          { id: "espresso", qty: 1 },
          { id: "espresso", qty: 1 },
        ],
      },
    ],
    ["a price from the browser", { items: [{ id: "espresso", qty: 1, price: "0.01" }] }],
    ["a total from the browser", { items: [{ id: "espresso", qty: 1 }], total: "0.01" }],
    [
      "an order over the limit",
      {
        items: [
          { id: "croissant", qty: 5 },
          { id: "cappuccino", qty: 5 },
        ],
      },
    ],
  ])("refuses %s", (_name, body) => {
    expect(() => priceCart(body)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_cart" }));
  });
});

describe("the shop page", () => {
  it("is served with a policy that lets it load only from its own origin", async () => {
    const t = await shopApp();
    const res = await t.app.inject({ method: "GET", url: "/shop" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:/);
    expect(res.body).toContain('src="/checkout.js"');
  });

  it("serves its script and style, and nothing else from its folder", async () => {
    const t = await shopApp();
    expect((await t.app.inject({ method: "GET", url: "/shop/shop.js" })).headers["content-type"]).toMatch(/javascript/);
    expect((await t.app.inject({ method: "GET", url: "/shop/shop.css" })).headers["content-type"]).toMatch(/css/);
    expect((await t.app.inject({ method: "GET", url: "/shop/../package.json" })).statusCode).toBe(404);
  });

  it("does not exist on a Tilll the demo was not mounted on", async () => {
    const t = await makeApp({ publicDir });
    expect((await t.app.inject({ method: "GET", url: "/shop" })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "POST", url: "/shop/api/invoices", payload: {} })).statusCode).toBe(404);
  });

  it("has no inline script and calls only its own origin", async () => {
    const t = await shopApp();
    const html = (await t.app.inject({ method: "GET", url: "/shop" })).body;
    const js = (await t.app.inject({ method: "GET", url: "/shop/shop.js" })).body;
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html + js).not.toMatch(/https?:\/\//);
    expect(js).toContain("/shop/api/invoices");
  });
});

describe("POST /shop/api/invoices", () => {
  it("creates an invoice for the server's total, in the settlement asset, for the settlement account", async () => {
    const t = await shopApp();
    const res = await order(t, [
      { id: "espresso", qty: 2 },
      { id: "beans", qty: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["invoiceId"]);

    const inv = t.service.getInvoice(res.json().invoiceId);
    expect(inv.amount).toBe("1000000"); // 1.00 USDC in base units
    expect(inv.description).toBe("2 x Espresso, 1 x Bean sample");
    expect(inv.metadata).toMatchObject({ source: "shop" });
    expect(inv.settlementAccount).toBe(t.settings.current().accountId);
    expect(Date.parse(inv.expiresAt) - Date.parse(inv.createdAt)).toBe(30 * 60_000);
  });

  it("never creates an invoice from a price the browser sent", async () => {
    const t = await shopApp();
    const res = await order(t, [{ id: "espresso", qty: 1, price: "0.01" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_cart");
    expect(t.service.listInvoices({}).invoices).toHaveLength(0);
  });

  it("limits how many orders one visitor can start a minute", async () => {
    const t = await shopApp({ perMinute: 2 });
    const cart = [{ id: "espresso", qty: 1 }];
    expect((await order(t, cart)).statusCode).toBe(200);
    expect((await order(t, cart)).statusCode).toBe(200);
    expect((await order(t, cart)).statusCode).toBe(429);
  });

  it("limits how many orders the whole shop takes an hour, and lets more through when the hour has passed", async () => {
    let clock = Date.parse("2026-11-14T10:00:00Z");
    const t = await shopApp({ perHour: 2, perMinute: 100, now: () => new Date(clock) });
    const cart = [{ id: "espresso", qty: 1 }];
    expect((await order(t, cart)).statusCode).toBe(200);
    expect((await order(t, cart)).statusCode).toBe(200);
    const busy = await order(t, cart);
    expect(busy.statusCode).toBe(429);
    expect(busy.json().error.code).toBe("shop_busy");
    clock += 61 * 60_000;
    expect((await order(t, cart)).statusCode).toBe(200);
  });
});

describe("GET /shop/api/orders/:id", () => {
  it("reports the status the server holds, and the items", async () => {
    const t = await shopApp();
    const { invoiceId } = (await order(t, [{ id: "cortado", qty: 2 }])).json();
    const open = (await t.app.inject({ method: "GET", url: `/shop/api/orders/${invoiceId}` })).json();
    expect(open).toEqual({ id: invoiceId, status: "open", amount: "0.5", items: [{ name: "Cortado", qty: 2 }] });

    t.service.cancelInvoice(invoiceId);
    const canceled = (await t.app.inject({ method: "GET", url: `/shop/api/orders/${invoiceId}` })).json();
    expect(canceled.status).toBe("canceled");
  });

  it("does not reveal an invoice the shop didn't make, or answer for a malformed id", async () => {
    const t = await shopApp();
    const other = t.service.createInvoice({ amount: "5", description: "Someone else's", metadata: { orderId: "A-1" } });
    for (const id of [other.id, "inv_nope", "inv_01M7ABRDF4GZ0PSKEW9R4TS8JC"]) {
      const res = await t.app.inject({ method: "GET", url: `/shop/api/orders/${id}` });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("Someone else's");
    }
  });
});

describe("POST /shop/hooks", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: {} });
  const send = (t: Awaited<ReturnType<typeof shopApp>>, header: string | undefined, payload = body) =>
    t.app.inject({
      method: "POST",
      url: "/shop/hooks",
      payload,
      headers: { "content-type": "application/json", ...(header ? { "tilll-signature": header } : {}) },
    });

  it("accepts a webhook signed with the shared secret", async () => {
    const t = await shopApp();
    expect((await send(t, signPayload(SECRET, nowSeconds(), body))).statusCode).toBe(204);
  });

  it.each([
    ["no signature", undefined],
    ["the wrong secret", signPayload("whsec_other", nowSeconds(), body)],
    ["an old timestamp", signPayload(SECRET, nowSeconds() - 3600, body)],
    ["a malformed header", "v1=abc"],
  ])("refuses a webhook with %s", async (_name, header) => {
    const t = await shopApp();
    const res = await send(t, header);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_signature");
  });

  it("refuses a body that was changed after it was signed", async () => {
    const t = await shopApp();
    const signed = signPayload(SECRET, nowSeconds(), body);
    expect((await send(t, signed, body.replace("invoice.paid", "invoice.canceled"))).statusCode).toBe(401);
  });
});
