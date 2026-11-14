import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoStore } from "../demo-store/server.js";
import { signPayload } from "../src/webhooks/signature.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    closers.push(() => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))));
  });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });

/** A stand-in for Tilll's merchant API that records what the store sent it. */
async function fakeTilll(
  respond: () => { status: number; body: unknown } = () => ({ status: 201, body: { id: "inv_TEST" } }),
) {
  const seen: { method?: string; url?: string; authorization?: string; body?: unknown }[] = [];
  const url = await listen(
    createServer(async (req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse((await readBody(req)) || "null"),
      });
      const { status, body } = respond();
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    }),
  );
  return { url, seen };
}

async function startStore(tilll: string, publicTilll = tilll, webhookSecret?: string) {
  return listen(
    createDemoStore({
      tilllUrl: tilll,
      tilllPublicUrl: publicTilll,
      merchantSecret: "sk_demo_secret",
      ...(webhookSecret ? { webhookSecret } : {}),
    }),
  );
}

describe("demo store pages", () => {
  it("serves a shop page that loads the Tilll widget from the Tilll server, with no inline script", async () => {
    const store = await startStore("http://127.0.0.1:1", "https://pay.example.com");
    const res = await fetch(`${store}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(html).toContain('<script src="https://pay.example.com/checkout.js" defer></script>');
    expect(html).toContain('<script src="/shop.js" defer></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).toMatch(/no real funds/i);
  });

  it("sends a content security policy that allows only itself and the Tilll server", async () => {
    const store = await startStore("http://127.0.0.1:1", "https://pay.example.com");
    const csp = (await fetch(`${store}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' https://pay.example.com");
    expect(csp).toContain("connect-src 'self' https://pay.example.com");
    // The checkout's token and network images come from the Tilll server too, so a strict page must allow them.
    expect(csp).toContain("img-src 'self' data: https://pay.example.com");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("serves the shop script", async () => {
    const store = await startStore("http://127.0.0.1:1");
    const res = await fetch(`${store}/shop.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toContain("/api/checkout");
  });

  it("escapes the Tilll URL it puts in the page", async () => {
    const store = await startStore("http://127.0.0.1:1", 'https://x.example/"><img src=x onerror=alert(1)>');
    const html = await (await fetch(`${store}/`)).text();
    expect(html).not.toContain("<img src=x");
  });

  it("answers anything else with 404", async () => {
    const store = await startStore("http://127.0.0.1:1");
    expect((await fetch(`${store}/nope`)).status).toBe(404);
  });
});

describe("POST /api/checkout", () => {
  it("creates the invoice on the server with the merchant secret and returns only its id", async () => {
    const tilll = await fakeTilll();
    const store = await startStore(tilll.url);

    const res = await fetch(`${store}/api/checkout`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invoiceId: "inv_TEST" });
    expect(tilll.seen).toHaveLength(1);
    expect(tilll.seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/invoices",
      authorization: "Bearer sk_demo_secret",
    });
    expect(tilll.seen[0]!.body).toMatchObject({ amount: "5.00", description: expect.stringContaining("coffee") });
  });

  it("fixes the price on the server: whatever the browser sends is ignored", async () => {
    const tilll = await fakeTilll();
    const store = await startStore(tilll.url);

    await fetch(`${store}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "0.01", description: "free" }),
    });

    expect(tilll.seen[0]!.body).toMatchObject({ amount: "5.00" });
  });

  it("never lets the merchant secret reach the browser", async () => {
    const tilll = await fakeTilll();
    const store = await startStore(tilll.url);
    const res = await fetch(`${store}/api/checkout`, { method: "POST" });
    expect(JSON.stringify([...res.headers]) + (await res.text())).not.toContain("sk_demo_secret");
  });

  it.each([
    ["Tilll refuses the request", () => ({ status: 401, body: { error: { code: "unauthorized", message: "no" } } })],
    ["Tilll answers without an invoice id", () => ({ status: 201, body: {} })],
  ])("reports a 502 in the standard error shape when %s", async (_name, respond) => {
    const tilll = await fakeTilll(respond);
    const store = await startStore(tilll.url);
    const res = await fetch(`${store}/api/checkout`, { method: "POST" });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("tilll_unavailable");
  });

  it("reports a 502 when Tilll cannot be reached at all", async () => {
    const store = await startStore("http://127.0.0.1:1");
    expect((await fetch(`${store}/api/checkout`, { method: "POST" })).status).toBe(502);
  });

  it("only accepts POST", async () => {
    const store = await startStore("http://127.0.0.1:1");
    expect((await fetch(`${store}/api/checkout`)).status).toBe(405);
  });
});

describe("webhook receiving", () => {
  const event = JSON.stringify({
    id: "evt_9",
    type: "invoice.paid",
    createdAt: "2026-11-05T10:00:00Z",
    data: { invoice: { id: "inv_1", secretish: "x" } },
  });
  const signedHeaders = (secret = "whsec_demo") => ({
    "content-type": "application/json",
    "tilll-event-id": "evt_9",
    "tilll-signature": signPayload(secret, Math.floor(Date.now() / 1000), event),
  });

  it("verifies Tilll webhooks and lists what it received, without the event data", async () => {
    const store = await startStore("http://127.0.0.1:1", "http://127.0.0.1:1", "whsec_demo");

    const res = await fetch(`${store}/hooks/tilll`, { method: "POST", headers: signedHeaders(), body: event });
    expect(res.status).toBe(200);

    const list = await (await fetch(`${store}/api/webhooks`)).json();
    expect(list.events).toEqual([{ id: "evt_9", type: "invoice.paid", receivedAt: expect.any(String) }]);
    expect(JSON.stringify(list)).not.toContain("secretish");
  });

  it("rejects a webhook signed with the wrong secret", async () => {
    const store = await startStore("http://127.0.0.1:1", "http://127.0.0.1:1", "whsec_demo");
    const res = await fetch(`${store}/hooks/tilll`, {
      method: "POST",
      headers: signedHeaders("whsec_other"),
      body: event,
    });
    expect(res.status).toBe(401);
    expect((await (await fetch(`${store}/api/webhooks`)).json()).events).toEqual([]);
  });

  it("has no webhook endpoint unless it was given a secret", async () => {
    const store = await startStore("http://127.0.0.1:1");
    expect((await fetch(`${store}/hooks/tilll`, { method: "POST", body: event })).status).toBe(404);
    expect((await fetch(`${store}/api/webhooks`)).status).toBe(404);
  });
});
