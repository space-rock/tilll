import { vi } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createInvoiceService } from "../../src/invoices/service.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import type { QuoteRequest, QuoteResponse } from "../../src/oneclick/types.js";
import type { SettingDefaults } from "../../src/settings/store.js";
import { START, TOKENS, quoteResponseFor } from "./oneclickData.js";
import { makeSettingsStore } from "./settingsData.js";

export * from "./oneclickData.js";

export function makeWorld(defaults: Partial<SettingDefaults> = {}) {
  const db: Db = openDb(":memory:");
  const settings = makeSettingsStore(db, defaults);
  let time = START.getTime();
  const clock = {
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
  };
  let quoteCount = 0;
  const client = {
    quote: vi.fn<(req: QuoteRequest) => Promise<QuoteResponse>>(async (req) => quoteResponseFor(req, ++quoteCount)),
  };
  const service = createInvoiceService({
    db,
    client,
    tokens: createTokenCache({ client: { tokens: async () => TOKENS } }),
    settings,
    config: { memoChains: ["stellar"] },
    now: clock.now,
  });
  const events = () =>
    (db.prepare("SELECT payload_json FROM webhook_deliveries ORDER BY rowid").all() as { payload_json: string }[]).map(
      (r) =>
        JSON.parse(r.payload_json) as {
          id: string;
          type: string;
          data: Record<string, any>;
          proof?: Record<string, string>;
          proofVerified?: boolean;
        },
    );
  return { db, clock, client, service, events, settings };
}
