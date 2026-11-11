import { vi } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { createInvoiceService } from "../../src/invoices/service.js";
import { createTokenCache } from "../../src/oneclick/tokens.js";
import type { QuoteRequest, QuoteResponse } from "../../src/oneclick/types.js";
import { START, TOKENS, USDC_NEAR, quoteResponseFor, tokenById } from "./oneclickData.js";

export * from "./oneclickData.js";

export function makeWorld() {
  const db: Db = openDb(":memory:");
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
    settlement: tokenById(USDC_NEAR),
    config: {
      settlementAccountId: "shop-pay.near",
      slippageBps: 100,
      attemptDeadlineMinutes: 30,
      memoChains: ["stellar"],
    },
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
  return { db, clock, client, service, events };
}
