import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "tilll_session";
const DEFAULT_TTL_MS = 12 * 60 * 60_000;

export interface SessionManagerOptions {
  now?: () => Date;
  /** How long a login lasts. */
  ttlMs?: number;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest("hex");

/** Constant time, whatever the lengths. */
const same = (a: string, b: string) => {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right);
};

/**
 * Dashboard sessions without a session table: a token that carries its own expiry and is signed with a key derived from
 * MERCHANT_SECRET, so changing the secret ends every session. The CSRF token for a session is a second value derived
 * from it, which only a page that has called the session endpoint (same origin, cookie attached) can learn.
 */
export function createSessionManager(merchantSecret: string, options: SessionManagerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const key = createHmac("sha256", merchantSecret).update("tilll-dashboard-session-v1").digest();

  return {
    create(): { token: string; maxAgeSeconds: number } {
      const expires = String(now().getTime() + ttlMs);
      const nonce = randomBytes(16).toString("hex");
      const mac = hmac(key, `${expires}.${nonce}`);
      return { token: `v1.${expires}.${nonce}.${mac}`, maxAgeSeconds: Math.floor(ttlMs / 1000) };
    },

    /** The session's CSRF token, if the token is genuine and has not expired. */
    verify(token: string | undefined): { csrf: string } | undefined {
      const parts = token?.split(".");
      if (!parts || parts.length !== 4 || parts[0] !== "v1") return undefined;
      const [, expires, nonce, mac] = parts as [string, string, string, string];
      if (!/^\d+$/.test(expires) || !same(mac, hmac(key, `${expires}.${nonce}`))) return undefined;
      if (now().getTime() >= Number(expires)) return undefined;
      return { csrf: hmac(key, `csrf.${expires}.${nonce}`) };
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;

export const sessionCookie = (token: string, maxAgeSeconds: number, options: { secure: boolean }) =>
  `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict${options.secure ? "; Secure" : ""}`;

export const clearSessionCookie = (options: { secure: boolean }) =>
  `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${options.secure ? "; Secure" : ""}`;

/** The cookies of a `Cookie` request header. Ignores anything malformed. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return cookies;
}
