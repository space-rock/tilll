import type { Db } from "./db/index.js";
import { newId } from "./ids.js";

/** Webhook event types (PLAN section 13). */
export type EventType =
  | "invoice.paid"
  | "invoice.expired"
  | "invoice.canceled"
  | "payment.underpaid"
  | "payment.refunded_by_network"
  | "payment.failed"
  | "payment.duplicate"
  | "refund.awaiting_approval"
  | "refund.succeeded"
  | "refund.failed"
  | "settings.updated"
  | "ping";

export interface EventProof {
  oneclickQuoteSignature: string;
  oneclickCorrelationId: string;
}

export interface NewEvent {
  type: EventType;
  data: Record<string, unknown>;
  proof?: EventProof;
  /** Whether Tilll checked `proof` against 1Click's public key (src/oneclick/signature.ts). Given whenever `proof` is. */
  proofVerified?: boolean;
}

/**
 * Record an event in the `webhook_deliveries` outbox, due immediately. The payload is final here: whoever
 * delivers it later only signs and sends it. Call inside the same transaction as the state change it reports,
 * so an event exists exactly when the change committed.
 */
export function enqueueEvent(db: Db, event: NewEvent, now: Date): string {
  const id = newId("evt", { now: now.getTime() });
  const createdAt = now.toISOString();
  const payload = {
    id,
    type: event.type,
    createdAt,
    data: event.data,
    ...(event.proof ? { proof: event.proof, proofVerified: event.proofVerified === true } : {}),
  };
  db.prepare(
    `INSERT INTO webhook_deliveries (id, event_type, payload_json, attempts, next_try_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(id, event.type, JSON.stringify(payload), createdAt, createdAt);
  return id;
}
