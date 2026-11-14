import type { Db } from "../db/index.js";

export type DeliveryState = "delivered" | "pending" | "failed";

export interface DeliveryLogEntry {
  id: string;
  type: string;
  createdAt: string;
  attempts: number;
  /** When the next try is due. Null once delivered, or once Tilll has given up. */
  nextTryAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  /** `failed` means every try failed and Tilll gave up; it can still be resent by hand. */
  state: DeliveryState;
  /** The event exactly as it is sent. */
  payload: unknown;
}

interface Row {
  id: string;
  event_type: string;
  payload_json: string;
  attempts: number;
  next_try_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

const toEntry = (r: Row): DeliveryLogEntry => ({
  id: r.id,
  type: r.event_type,
  createdAt: r.created_at,
  attempts: r.attempts,
  nextTryAt: r.next_try_at,
  deliveredAt: r.delivered_at,
  lastError: r.last_error,
  state: r.delivered_at ? "delivered" : r.next_try_at ? "pending" : "failed",
  payload: JSON.parse(r.payload_json) as unknown,
});

/** A read-only view of the webhook outbox, for the dashboard's log. */
export function createWebhookLog(db: Db) {
  return {
    /** Newest first. `cursor` is the last id of the previous page. */
    page(q: { cursor?: string | undefined; limit: number }): DeliveryLogEntry[] {
      const rows = db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE @cursor IS NULL OR rowid < (SELECT rowid FROM webhook_deliveries WHERE id = @cursor)
           ORDER BY rowid DESC LIMIT @limit`,
        )
        .all({ cursor: q.cursor ?? null, limit: q.limit }) as Row[];
      return rows.map(toEntry);
    },

    find(id: string): DeliveryLogEntry | undefined {
      const row = db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as Row | undefined;
      return row && toEntry(row);
    },
  };
}

export type WebhookLog = ReturnType<typeof createWebhookLog>;
