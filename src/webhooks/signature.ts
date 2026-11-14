import { createHmac, timingSafeEqual } from "node:crypto";

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<rawBody>">` (PLAN section 13). Sign the exact bytes you send. */
export function signPayload(secret: string, timestamp: number, rawBody: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export type Verification = { ok: true; timestamp: number } | { ok: false; reason: string };

export interface VerifyOptions {
  secret: string;
  /** The Tilll-Signature header value. */
  header: string | undefined;
  /** The request body exactly as received, before any JSON parsing. */
  rawBody: string;
  /** Injectable clock. Defaults to the current time. */
  now?: () => Date;
  /** How far the timestamp may be from now, either way. Default 300 seconds. Stops replays of old requests. */
  toleranceSeconds?: number;
}

/** Check a Tilll-Signature header. Never throws; every failure says why. */
export function verifySignature(options: VerifyOptions): Verification {
  const { secret, header, rawBody } = options;
  if (!header) return { ok: false, reason: "Tilll-Signature header is missing." };

  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(",")) {
    const [key, value = ""] = part.trim().split("=");
    if (key === "t" && /^\d{1,15}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signature = value;
  }
  if (timestamp === undefined || signature === undefined) {
    return { ok: false, reason: "Tilll-Signature header is malformed." };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
    return { ok: false, reason: "Signature does not match: wrong secret, or the body was changed." };
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return {
      ok: false,
      reason: `Timestamp is outside the allowed ${tolerance} second window: a replay, or the clocks disagree.`,
    };
  }
  return { ok: true, timestamp };
}
