import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import type { FastifyReply } from "fastify";

/** Content types for the files a built page can hold. Anything else is sent as opaque bytes. */
export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** The file inside `root` that a URL path names, or undefined if it names anything outside it. */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const target = normalize(join(root, decoded));
  return target === root || target.startsWith(root + sep) ? target : undefined;
}

/** The file's bytes, or undefined if there is no such file. Any other failure is a real error. */
export async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** The headers every page Tilll serves carries: a policy for what it may load, and no sniffing or referrers. */
export function withSecurityHeaders(reply: FastifyReply, csp: string): FastifyReply {
  return reply
    .header("content-security-policy", csp)
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer");
}
