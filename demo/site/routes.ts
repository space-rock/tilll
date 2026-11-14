import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ApiError } from "../../src/errors.js";
import { CONTENT_TYPES, readIfExists, resolveInside } from "../../src/routes/static.js";

export interface SiteRouteOptions {
  /** The built project site (`pnpm build:site` writes it to site/dist). */
  dir: string;
}

/**
 * The pages carry the same policy in a meta tag. It is repeated here as a header because a header can also say
 * `frame-ancestors`, which a meta tag cannot. Nothing is loaded from another host and nothing runs inline.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const notFound = () => new ApiError(404, "not_found", "No such page.");

const send = async (reply: FastifyReply, file: string, immutable: boolean) => {
  const bytes = await readIfExists(file);
  if (!bytes) throw notFound();
  return reply
    .header("content-type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream")
    .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-cache")
    .header("content-security-policy", CSP)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .send(bytes);
};

/**
 * The project's own site, for the live demo: the landing page at `/`, the docs at `/docs`, and the files they load.
 * Every URL in the built pages is relative, so they work from here. Tilll answers `/` with a redirect to the dashboard,
 * so the landing page is served by a hook that runs before that route; everything else is a plain route.
 */
export async function registerSite(app: FastifyInstance, opts: SiteRouteOptions): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    // The path alone: a link that arrives with a query string (`/?ref=...`) is still the landing page.
    if (request.method === "GET" && request.url.split("?")[0] === "/")
      return send(reply, join(opts.dir, "index.html"), false);
  });
  app.get("/docs", (_request, reply) => send(reply, join(opts.dir, "docs.html"), false));
  app.get("/docs.html", (_request, reply) => send(reply, join(opts.dir, "docs.html"), false));

  // Built assets have a hash in their name, so a browser may keep them for good.
  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const file = resolveInside(join(opts.dir, "assets"), request.params["*"]);
    if (!file) throw notFound();
    return send(reply, file, true);
  });

  // The few loose files next to the pages (the favicon, the logo marks). Only files that exist there, never a page.
  const loose = new Set(
    (await readdir(opts.dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".html"))
      .map((entry) => entry.name),
  );
  app.get<{ Params: { file: string } }>("/:file", async (request, reply) => {
    if (!loose.has(request.params.file)) throw notFound();
    return send(reply, join(opts.dir, request.params.file), false);
  });
}
