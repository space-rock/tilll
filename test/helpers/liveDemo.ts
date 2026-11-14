import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mountDemo, type DemoOptions } from "../../demo/mount.js";
import { makeApp } from "./app.js";

export const publicDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "public");
export const DEMO_WEBHOOK_SECRET = "whsec_shop_test";

/** A normal test server with the live demo mounted on it, the way `demo/main.ts` mounts it. */
export async function makeDemoApp(options: DemoOptions = {}) {
  const t = await makeApp({ publicDir, ...(options.now ? { now: options.now } : {}) });
  await mountDemo(t.app, { service: t.service, settings: t.settings, webhookSecret: DEMO_WEBHOOK_SECRET }, options);
  return t;
}
