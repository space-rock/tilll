import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ApiError } from "../errors.js";
import { withSecurityHeaders } from "./static.js";

/** Invoice ids are `inv_` plus a 26 character ULID. Anything else is never put into a page. */
const INVOICE_ID = /^inv_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The widget loads from this origin and talks only to it. No inline script, nothing third party. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** `GET /checkout.js`: the built widget, for merchants' `<script src>` and for the hosted page. */
export function registerWidgetScript(app: FastifyInstance, publicDir: string) {
  app.get("/checkout.js", async (_request, reply: FastifyReply) => {
    let script: string;
    try {
      script = await readFile(join(publicDir, "checkout.js"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      throw new ApiError(404, "widget_not_built", "The checkout widget has not been built. Run: pnpm build:widget");
    }
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .header("x-content-type-options", "nosniff")
      .send(script);
  });
}

const hostedPage = (invoiceId: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay with crypto</title>
<style>
  html { background: #f1f5f9; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0b1f3a; }
  main { width: 100%; max-width: 440px; }
</style>
</head>
<body>
<main><div data-tilll-inline="${invoiceId}"></div></main>
<noscript>JavaScript is required to pay.</noscript>
<script src="/checkout.js"></script>
</body>
</html>
`;

/** `GET /pay/:invoiceId`: the hosted checkout page, for merchants who do not embed the widget. */
export function registerHostedPage(app: FastifyInstance) {
  app.get<{ Params: { invoiceId: string } }>("/:invoiceId", async (request, reply) => {
    const { invoiceId } = request.params;
    if (!INVOICE_ID.test(invoiceId)) throw new ApiError(404, "not_found", "No such route.");
    return withSecurityHeaders(reply, CSP)
      .header("content-type", "text/html; charset=utf-8")
      .send(hostedPage(invoiceId));
  });
}
