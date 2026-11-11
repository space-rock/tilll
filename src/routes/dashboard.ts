import { createHash, timingSafeEqual } from "node:crypto";
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
  /** Serve the session cookie with `Secure` (the site is on https). */
  secureCookie: boolean;
  /** Where the built dashboard lives (index.html and assets/). */
  dashboardDir: string;
  loginRateLimit: { max: number; timeWindow: string };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** The dashboard loads from this origin and talks only to it: no inline script, nothing third party. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const loginBody = z.object({ secret: z.string({ error: "secret must be a string" }) });

/** `/dashboard`: login, logout and the session endpoint, then the built single-page app for everything else. */
export const dashboardRoutes: FastifyPluginAsync<DashboardRouteOptions> = async (app: FastifyInstance, opts) => {
  const expected = sha256(opts.merchantSecret);
  await app.register(rateLimit, { global: false });

  // Fastify normalizes the prefix, so these are /dashboard/api/*.
  app.post("/api/login", { config: { rateLimit: opts.loginRateLimit } }, async (request, reply) => {
    const body = parse(loginBody, request.body);
    if (!timingSafeEqual(sha256(body.secret), expected)) {
      throw new ApiError(401, "unauthorized", "That is not the merchant secret.");
    }
    const { token, maxAgeSeconds } = opts.sessions.create();
    const session = opts.sessions.verify(token)!;
    return reply
      .header("set-cookie", sessionCookie(token, maxAgeSeconds, { secure: opts.secureCookie }))
      .header("cache-control", "no-store")
      .send({ csrfToken: session.csrf });
  });

  app.post("/api/logout", async (_request, reply) =>
    reply
      .header("set-cookie", clearSessionCookie({ secure: opts.secureCookie }))
      .header("cache-control", "no-store")
      .code(204)
      .send(),
  );

  app.get("/api/session", async (request, reply) => {
    const session = opts.sessions.verify(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new ApiError(401, "unauthorized", "Not logged in.");
    return reply.header("cache-control", "no-store").send({ csrfToken: session.csrf });
  });

  const serve = async (urlPath: string, reply: FastifyReply) => {
    // /api is the dashboard's own JSON API; a path under it that does not exist is an error, never the app's page.
    if (urlPath === "/api" || urlPath.startsWith("/api/")) throw new ApiError(404, "not_found", "No such route.");
    const wanted = resolveInside(opts.dashboardDir, urlPath === "/" ? "/index.html" : urlPath);
    if (!wanted) throw new ApiError(404, "not_found", "No such file.");

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
    if (!file) throw new ApiError(404, "not_found", "No such file.");

    const isIndex = path.endsWith(`${sep}index.html`);
    return withSecurityHeaders(reply, CSP)
      .header("content-type", CONTENT_TYPES[extname(path)] ?? "application/octet-stream")
      .header("cache-control", isIndex ? "no-store" : "public, max-age=31536000, immutable")
      .send(file);
  };

  app.get("/", async (_request, reply) => serve("/", reply));
  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => serve(`/${request.params["*"]}`, reply));
};
