import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { SESSION_COOKIE, parseCookies, type SessionManager } from "../auth/session.js";
import { ApiError } from "../errors.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface MerchantAuthOptions {
  merchantSecret: string;
  sessions: SessionManager;
}

/**
 * Who may call `/v1/*`: a program with `Authorization: Bearer <MERCHANT_SECRET>`, or the dashboard with its session
 * cookie. A cookie is attached by the browser on its own, so a write made with one must also carry the session's CSRF
 * token (which only the dashboard's own page can read) and, when the browser says where it came from, come from this
 * site. The bearer secret is never attached by a browser by itself, so it needs neither.
 */
export function createMerchantAuth(options: MerchantAuthOptions) {
  const expected = sha256(options.merchantSecret);

  return (request: FastifyRequest): void => {
    // A Bearer token is checked and decides the request. Any other scheme (a proxy in front may add its own) is not ours.
    const bearer = /^Bearer\s+(\S.*)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (bearer !== undefined) {
      // Hash both sides so the comparison is constant-time whatever the lengths.
      if (timingSafeEqual(sha256(bearer), expected)) return;
      throw unauthorized();
    }

    const session = options.sessions.verify(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw unauthorized();
    if (SAFE_METHODS.has(request.method)) return;

    const sent = request.headers["x-csrf-token"];
    if (typeof sent !== "string" || !timingSafeEqual(sha256(sent), sha256(session.csrf))) {
      throw new ApiError(403, "csrf_failed", "Your session is out of date. Reload the dashboard and try again.");
    }
    const origin = request.headers.origin;
    // `request.host` is the Host header, or the public host a trusted proxy reports in X-Forwarded-Host (TRUST_PROXY).
    if (origin !== undefined && !sameHost(origin, request.host)) {
      throw new ApiError(403, "csrf_failed", "This request came from another site, so we blocked it.");
    }
  };
}

const unauthorized = () =>
  new ApiError(
    401,
    "unauthorized",
    "Send the merchant secret as 'Authorization: Bearer <secret>', or log in to the dashboard.",
  );

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}
