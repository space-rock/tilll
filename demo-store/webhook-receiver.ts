/**
 * How a merchant receives Tilll webhooks. This file is self-contained on purpose: copy `verifyTilllSignature`
 * and the handler into your own server. Run it on its own with:
 *
 *   WEBHOOK_SECRET=whsec_... pnpm exec tsx demo-store/webhook-receiver.ts
 *
 * and set Tilll's WEBHOOK_URL to http://localhost:9000/hooks/tilll (change the port with RECEIVER_PORT).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export type Verification = { ok: true } | { ok: false; reason: string };

/**
 * Check the `Tilll-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>">`.
 * `rawBody` must be the request body exactly as received, before JSON parsing.
 */
export function verifyTilllSignature(args: {
  secret: string;
  header: string | undefined;
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Verification {
  const parts = Object.fromEntries((args.header ?? "").split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = /^\d{1,15}$/.test(parts.t ?? "") ? Number(parts.t) : undefined;
  if (t === undefined || !/^[0-9a-f]{64}$/i.test(parts.v1 ?? ""))
    return { ok: false, reason: "missing or malformed signature" };
  const expected = createHmac("sha256", args.secret).update(`${t}.${args.rawBody}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts.v1!, "hex"))) return { ok: false, reason: "signature mismatch" };
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (args.toleranceSeconds ?? 300))
    return { ok: false, reason: "timestamp outside the allowed window" };
  return { ok: true };
}

export interface ReceivedEvent {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
  proof?: { oneclickQuoteSignature: string; oneclickCorrelationId: string };
  /** Whether Tilll verified the proof against 1Click's public key. Present whenever `proof` is. */
  proofVerified?: boolean;
}

export interface ReceiverOptions {
  secret: string;
  /** Do your work here. Throwing makes the handler answer 500, so Tilll retries the event later. */
  onEvent: (event: ReceivedEvent) => void | Promise<void>;
  /** Path to accept. Default /hooks/tilll. */
  path?: string;
  /** How old (or new) a request's timestamp may be, in seconds. Default 300. */
  toleranceSeconds?: number;
}

const MAX_BODY_BYTES = 1_000_000;

/** The body as a string, or null once it exceeds the limit. Keeps discarding the rest so the client can finish. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        resolve(null); // answer 413 now; the rest of the upload is read and thrown away
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

/**
 * A request listener for POST <path>. Tilll delivers at least once, so repeated events are answered 200
 * without being processed again. This keeps seen ids in memory; a real receiver should store them durably.
 */
export function createWebhookHandler(options: ReceiverOptions) {
  const seen = new Set<string>();
  const path = options.path ?? "/hooks/tilll";

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://receiver").pathname !== path) return reply(res, 404, { error: "not found" });
    if (req.method !== "POST") return reply(res, 405, { error: "use POST" });

    const rawBody = await readBody(req);
    if (rawBody === null) return reply(res, 413, { error: "body too large" });

    const check = verifyTilllSignature({
      secret: options.secret,
      header: req.headers["tilll-signature"] as string | undefined,
      rawBody,
      ...(options.toleranceSeconds ? { toleranceSeconds: options.toleranceSeconds } : {}),
    });
    if (!check.ok) return reply(res, 401, { error: check.reason });

    let event: ReceivedEvent;
    try {
      event = JSON.parse(rawBody) as ReceivedEvent;
    } catch {
      return reply(res, 400, { error: "body is not JSON" });
    }

    const eventId = (req.headers["tilll-event-id"] as string | undefined) ?? event.id;
    if (seen.has(eventId)) return reply(res, 200, { duplicate: true });
    try {
      await options.onEvent(event);
    } catch {
      return reply(res, 500, { error: "could not process the event" }); // not remembered: Tilll will retry
    }
    seen.add(eventId);
    return reply(res, 200, { received: true });
  };
}

/**
 * The port to listen on: RECEIVER_PORT, default 9000. Deliberately not PORT, which is Tilll's own setting and
 * is exported into your shell by `source .env`.
 */
export function receiverPort(env: Record<string, string | undefined>): number {
  const raw = env.RECEIVER_PORT ?? "9000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`RECEIVER_PORT must be a port number, got "${raw}".`);
  return port;
}

export function createReceiverServer(options: ReceiverOptions): Server {
  const handler = createWebhookHandler(options);
  return createServer((req, res) => void handler(req, res).catch(() => res.writeHead(500).end()));
}

/**
 * The line printed for an event that passed the HMAC check. An event that carries a 1Click quote proof also says whether Tilll
 * could verify that proof against 1Click's public key; anything but an explicit `true` counts as not verified.
 */
export function describeEvent(event: ReceivedEvent): string {
  const proof = event.proof ? `  1Click proof: ${event.proofVerified === true ? "verified" : "NOT verified"}` : "";
  return `${event.createdAt}  ${event.type}  ${event.id}  (signature verified)${proof}`;
}

// Run standalone: print every verified event.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("Set WEBHOOK_SECRET to the same value as Tilll's WEBHOOK_SECRET.");
    process.exit(1);
  }
  const port = receiverPort(process.env);
  createReceiverServer({
    secret,
    onEvent: (event) => console.log(describeEvent(event)),
  }).listen(port, () => console.log(`Webhook receiver listening on http://localhost:${port}/hooks/tilll`));
}
