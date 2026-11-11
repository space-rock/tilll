import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReceiverServer,
  describeEvent,
  receiverPort,
  verifyTilllSignature,
  type ReceivedEvent,
} from "../demo-store/webhook-receiver.js";
import { signPayload, verifySignature } from "../src/webhooks/signature.js";

const SECRET = "whsec_receiver_test";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const listen = (server: Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    closers.push(() => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))));
  });

async function start(onEvent: (e: ReceivedEvent) => void | Promise<void> = () => undefined, toleranceSeconds?: number) {
  const url = await listen(
    createReceiverServer({ secret: SECRET, onEvent, ...(toleranceSeconds ? { toleranceSeconds } : {}) }),
  );
  return `${url}/hooks/tilll`;
}

const EVENT = {
  id: "evt_1",
  type: "invoice.paid",
  createdAt: "2026-11-05T10:00:00Z",
  data: { invoice: { id: "inv_1" } },
};
const BODY = JSON.stringify(EVENT);
const now = () => Math.floor(Date.now() / 1000);

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}
const signed = (body = BODY, id = "evt_1", t = now(), secret = SECRET) => ({
  "tilll-event-id": id,
  "tilll-signature": signPayload(secret, t, body),
});

describe("receiver", () => {
  it("accepts a correctly signed event and hands it to the application once", async () => {
    const onEvent = vi.fn<(e: ReceivedEvent) => void>();
    const url = await start(onEvent);

    const res = await post(url, BODY, signed());

    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({
      id: "evt_1",
      type: "invoice.paid",
      data: { invoice: { id: "inv_1" } },
    });
  });

  it("verifies the bytes as received, so any JSON formatting works", async () => {
    const onEvent = vi.fn<(e: ReceivedEvent) => void>();
    const url = await start(onEvent);
    const pretty = JSON.stringify(EVENT, null, 4);
    expect((await post(url, pretty, signed(pretty))).status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("answers a repeated Tilll-Event-Id with 200 without processing it again (delivery is at least once)", async () => {
    const onEvent = vi.fn<(e: ReceivedEvent) => void>();
    const url = await start(onEvent);

    await post(url, BODY, signed());
    const again = await post(url, BODY, signed());

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a tampered body", () => ({ body: `${BODY} `, headers: signed() })],
    ["no signature", () => ({ body: BODY, headers: {} })],
    ["the wrong secret", () => ({ body: BODY, headers: signed(BODY, "evt_1", now(), "whsec_other") })],
    ["a replayed old request", () => ({ body: BODY, headers: signed(BODY, "evt_1", now() - 3600) })],
  ])("rejects %s with 401 and never calls the application", async (_name, build) => {
    const onEvent = vi.fn<(e: ReceivedEvent) => void>();
    const url = await start(onEvent);
    const { body, headers } = build();

    const res = await post(url, body, headers);

    expect(res.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("lets the merchant choose how old a request may be", async () => {
    const old = signed(BODY, "evt_1", now() - 400);
    expect((await post(await start(), BODY, old)).status).toBe(401); // default window is 300 s
    expect((await post(await start(undefined, 600), BODY, old)).status).toBe(200);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const url = await start();
    const bad = "not json";
    expect((await post(url, bad, signed(bad))).status).toBe(400);
  });

  it("answers 500, and does not remember the event, when the application fails, so Tilll retries it", async () => {
    let fail = true;
    const onEvent = vi.fn<(e: ReceivedEvent) => void>(() => {
      if (fail) throw new Error("database down");
    });
    const url = await start(onEvent);

    expect((await post(url, BODY, signed())).status).toBe(500);
    fail = false;
    expect((await post(url, BODY, signed())).status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("refuses oversized bodies and other methods or paths", async () => {
    const url = await start();
    const huge = JSON.stringify({ blob: "x".repeat(2_000_000) });
    expect((await post(url, huge, signed(huge))).status).toBe(413);
    expect((await fetch(url)).status).toBe(405);
    expect((await post(url.replace("/hooks/tilll", "/elsewhere"), BODY, signed())).status).toBe(404);
  });
});

describe("receiverPort", () => {
  it("uses RECEIVER_PORT and defaults to 9000", () => {
    expect(receiverPort({})).toBe(9000);
    expect(receiverPort({ RECEIVER_PORT: "9100" })).toBe(9100);
  });

  it("ignores PORT, which belongs to Tilll and is exported when someone runs `source .env`", () => {
    expect(receiverPort({ PORT: "8080" })).toBe(9000);
    expect(receiverPort({ PORT: "8080", RECEIVER_PORT: "9100" })).toBe(9100);
  });

  it("rejects a value that is not a valid port", () => {
    expect(() => receiverPort({ RECEIVER_PORT: "abc" })).toThrow(/RECEIVER_PORT/);
    expect(() => receiverPort({ RECEIVER_PORT: "70000" })).toThrow(/RECEIVER_PORT/);
  });
});

describe("verifyTilllSignature (the self-contained copy a merchant pastes in)", () => {
  const cases: [string, string | undefined, string, number][] = [
    ["valid", signPayload(SECRET, 1000, BODY), BODY, 1000],
    ["tampered", signPayload(SECRET, 1000, BODY), `${BODY}x`, 1000],
    ["stale", signPayload(SECRET, 1000, BODY), BODY, 1000 + 301],
    ["future", signPayload(SECRET, 1000, BODY), BODY, 1000 - 301],
    ["missing", undefined, BODY, 1000],
    ["malformed", "garbage", BODY, 1000],
    ["wrong length", "t=1000,v1=abcd", BODY, 1000],
    ["unicode", signPayload(SECRET, 1000, '{"d":"café ☕"}'), '{"d":"café ☕"}', 1000],
  ];

  it.each(cases)("agrees with Tilll's own verifier on a %s request", (_name, header, rawBody, nowSeconds) => {
    const theirs = verifyTilllSignature({ secret: SECRET, header, rawBody, nowSeconds });
    const ours = verifySignature({ secret: SECRET, header, rawBody, now: () => new Date(nowSeconds * 1000) });
    expect(theirs.ok).toBe(ours.ok);
  });
});

describe("describeEvent (the line the receiver prints)", () => {
  const base = { id: "evt_1", type: "invoice.paid", createdAt: "2026-11-09T10:00:00.000Z", data: {} };
  const proof = { oneclickQuoteSignature: "ed25519:SIG", oneclickCorrelationId: "c" };

  it("says the HMAC signature verified, and for an event with a 1Click proof, whether the proof did too", () => {
    expect(describeEvent(base)).toBe("2026-11-09T10:00:00.000Z  invoice.paid  evt_1  (signature verified)");
    expect(describeEvent({ ...base, proof, proofVerified: true })).toBe(
      "2026-11-09T10:00:00.000Z  invoice.paid  evt_1  (signature verified)  1Click proof: verified",
    );
    expect(describeEvent({ ...base, proof, proofVerified: false })).toMatch(/1Click proof: NOT verified$/);
  });

  it("does not call a proof verified when the field is missing", () => {
    expect(describeEvent({ ...base, proof })).toMatch(/1Click proof: NOT verified$/);
  });
});
