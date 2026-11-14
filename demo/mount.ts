import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { ExtendContext } from "../src/start.js";
import { invoicesRoutes } from "./invoices/routes.js";
import { shopRoutes } from "./shop/routes.js";
import { registerSite } from "./site/routes.js";

export interface DemoOptions {
  /** The built project site. Defaults to site/dist at the repository root. */
  siteDir?: string;
  /** The shop's page, script and style. Defaults to demo/public/shop. */
  shopDir?: string;
  /** The invoices page's stylesheet. Defaults to demo/public/invoices. */
  invoicesDir?: string;
  /** The shop's order limits: a visitor's orders a minute, and the whole shop's orders an hour. */
  perMinute?: number;
  perHour?: number;
  now?: () => Date;
}

/**
 * Everything the live demo adds to a running Tilll: the cart shop at `/shop`, a public read-only list of its orders at `/invoices`, and the project site at `/` and `/docs`.
 * It lives here, outside `src/`, so the Tilll you install has none of it. Run it with `demo/main.ts` (`pnpm demo:live`
 * or `Dockerfile.demo`).
 */
export async function mountDemo(
  app: FastifyInstance,
  context: ExtendContext,
  options: DemoOptions = {},
): Promise<void> {
  await app.register(shopRoutes, {
    prefix: "/shop",
    service: context.service,
    settings: context.settings,
    dir: options.shopDir ?? fileURLToPath(new URL("./public/shop", import.meta.url)),
    webhookSecret: context.webhookSecret,
    ...(options.now ? { now: options.now } : {}),
    ...(options.perMinute !== undefined ? { perMinute: options.perMinute } : {}),
    ...(options.perHour !== undefined ? { perHour: options.perHour } : {}),
  });
  await app.register(invoicesRoutes, {
    service: context.service,
    settings: context.settings,
    dir: options.invoicesDir ?? fileURLToPath(new URL("./public/invoices", import.meta.url)),
    ...(options.now ? { now: options.now } : {}),
  });
  await registerSite(app, { dir: options.siteDir ?? fileURLToPath(new URL("../site/dist", import.meta.url)) });
}
