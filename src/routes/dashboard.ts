import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, sep } from "node:path";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  parseCookies,
  sessionCookie,
  type SessionManager,
} from "../auth/session.js";
import { ApiError } from "../errors.js";
import { parse } from "./http.js";
import { CONTENT_TYPES, readIfExists, resolveInside, withSecurityHeaders } from "./static.js";

export interface DashboardRouteOptions {
  merchantSecret: string;
  sessions: SessionManager;
  /** Serve the session cookie with `Secure` (the site is on https). Asked on every login, since the public URL can change. */
  secureCookie: () => boolean;
  /** Where the built dashboard lives (index.html and assets/). */
  dashboardDir: string;
  loginRateLimit: { max: number; timeWindow: string };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * What the dashboard may load. The page itself loads only from this origin. The wallet connector (near-connect) is the
 * exception, and it needs four things that no other Tilll page gets:
 * - `script-src` with a nonce: each wallet's code is fetched when needed and run as an inline script inside a sandboxed
 *   frame, and that frame inherits this policy. The nonce is new for every response, so a script an attacker injects
 *   still does not run.
 * - `connect-src https:`: the wallet list, the wallet code and each wallet's own services are on hosts this page cannot
 *   know in advance.
 * - `img-src https:`: wallet logos.
 * - `frame-src https:`: a wallet's code can open its own page in a frame (Intear Wallet does, at `wallet.intear.tech`). That
 *   frame is created inside the sandboxed frame above, which has an opaque origin and so can't reach this page, and the
 *   hosts differ per wallet.
 * The pay page and the checkout keep their own, stricter policies (`routes/pages.ts`).
 */
export function dashboardCsp(nonce?: string): string {
  return [
    "default-src 'none'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https:",
    "frame-src https:",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh value for one response's CSP nonce: 128 bits, base64. */
const newNonce = () => randomBytes(16).toString("base64");

/** `index.html` with the response's nonce in a meta tag, which is where the wallet connector reads it from. */
const withNonce = (html: Buffer, nonce: string): Buffer =>
  Buffer.from(
    html.toString("utf8").replace("</head>", `<meta name="csp-nonce" content="${nonce}" />\n  </head>`),
    "utf8",
  );

const loginBody = z.object({ secret: z.string({ error: "secret must be a string" }) });

/** `/dashboard`: login, logout and the session endpoint, then the built single-page app for everything else. */
export const dashboardRoutes: FastifyPluginAsync<DashboardRouteOptions> = async (app: FastifyInstance, opts) => {
  const expected = sha256(opts.merchantSecret);
  await app.register(rateLimit, { global: false });

  // Fastify normalizes the prefix, so these are /dashboard/api/*.
  app.post("/api/login", { config: { rateLimit: opts.loginRateLimit } }, async (request, reply) => {
    const body = parse(loginBody, request.body);
    if (!timingSafeEqual(sha256(body.secret), expected)) {
      throw new ApiError(401, "unauthorized", "That secret isn't right. Check MERCHANT_SECRET in your .env file.");
    }
    const { token, maxAgeSeconds } = opts.sessions.create();
    const session = opts.sessions.verify(token)!;
    return reply
      .header("set-cookie", sessionCookie(token, maxAgeSeconds, { secure: opts.secureCookie() }))
      .header("cache-control", "no-store")
      .send({ csrfToken: session.csrf });
  });

  app.post("/api/logout", async (_request, reply) =>
    reply
      .header("set-cookie", clearSessionCookie({ secure: opts.secureCookie() }))
      .header("cache-control", "no-store")
      .code(204)
      .send(),
  );

  app.get("/api/session", async (request, reply) => {
    const session = opts.sessions.verify(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new ApiError(401, "unauthorized", "You're signed out. Sign in again.");
    return reply.header("cache-control", "no-store").send({ csrfToken: session.csrf });
  });

  const serve = async (urlPath: string, reply: FastifyReply) => {
    // /api is the dashboard's own JSON API; a path under it that does not exist is an error, never the app's page.
    if (urlPath === "/api" || urlPath.startsWith("/api/")) throw new ApiError(404, "not_found", "No such route.");
    const wanted = resolveInside(opts.dashboardDir, urlPath === "/" ? "/index.html" : urlPath);
    if (!wanted) throw new ApiError(404, "not_found", "We couldn't find that file.");

    let file = await readIfExists(wanted);
    let path = wanted;
    // A route of the single-page app (no file extension) is answered with the app itself.
    if (!file && extname(urlPath) === "") {
      path = join(opts.dashboardDir, "index.html");
      file = await readIfExists(path);
      if (!file) {
        throw new ApiError(404, "dashboard_not_built", "The dashboard has not been built. Run: pnpm build:dashboard");
      }
    }
    if (!file) throw new ApiError(404, "not_found", "We couldn't find that file.");

    const isIndex = path.endsWith(`${sep}index.html`);
    // Only the page needs a nonce (it is the document the policy governs); the files it loads are cached as they are.
    const nonce = isIndex ? newNonce() : undefined;
    return withSecurityHeaders(reply, dashboardCsp(nonce))
      .header("content-type", CONTENT_TYPES[extname(path)] ?? "application/octet-stream")
      .header("cache-control", isIndex ? "no-store" : "public, max-age=31536000, immutable")
      .send(nonce ? withNonce(file, nonce) : file);
  };

  app.get("/", async (_request, reply) => serve("/", reply));
  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => serve(`/${request.params["*"]}`, reply));
};
