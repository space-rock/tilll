import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { enqueueEvent } from "../src/events.js";

const NOW = new Date("2026-11-05T10:00:00.000Z");

const rows = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT * FROM webhook_deliveries ORDER BY id").all() as Record<string, unknown>[];

describe("enqueueEvent", () => {
  it("writes a pending delivery with the PLAN section 13 payload", () => {
    const db = openDb(":memory:");

    const id = enqueueEvent(
      db,
      {
        type: "invoice.paid",
        data: { invoice: { id: "inv_1" }, attempt: { id: "att_1" } },
        proof: { oneclickQuoteSignature: "ed25519:SIG", oneclickCorrelationId: "corr-1" },
        proofVerified: true,
      },
      NOW,
    );

    const [row] = rows(db);
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row).toMatchObject({
      id,
      event_type: "invoice.paid",
      attempts: 0,
      next_try_at: "2026-11-05T10:00:00.000Z",
      delivered_at: null,
      last_error: null,
      created_at: "2026-11-05T10:00:00.000Z",
    });
    expect(JSON.parse(row!.payload_json as string)).toEqual({
      id,
      type: "invoice.paid",
      createdAt: "2026-11-05T10:00:00.000Z",
      data: { invoice: { id: "inv_1" }, attempt: { id: "att_1" } },
      proof: { oneclickQuoteSignature: "ed25519:SIG", oneclickCorrelationId: "corr-1" },
      proofVerified: true,
    });
  });

  it("says plainly when a proof did not verify, rather than leaving the field out", () => {
    const db = openDb(":memory:");
    enqueueEvent(
      db,
      {
        type: "invoice.paid",
        data: {},
        proof: { oneclickQuoteSignature: "ed25519:SIG", oneclickCorrelationId: "c" },
        proofVerified: false,
      },
      NOW,
    );
    expect(JSON.parse(rows(db)[0]!.payload_json as string)).toMatchObject({ proofVerified: false });
  });

  it("never says a proof verified unless the caller said so", () => {
    const db = openDb(":memory:");
    enqueueEvent(
      db,
      { type: "invoice.paid", data: {}, proof: { oneclickQuoteSignature: "ed25519:SIG", oneclickCorrelationId: "c" } },
      NOW,
    );
    expect(JSON.parse(rows(db)[0]!.payload_json as string)).toMatchObject({ proofVerified: false });
  });

  it("leaves proof and proofVerified out when the event has no quote behind it", () => {
    const db = openDb(":memory:");
    enqueueEvent(db, { type: "invoice.expired", data: { invoice: { id: "inv_1" } } }, NOW);
    const payload = JSON.parse(rows(db)[0]!.payload_json as string);
    expect(payload).not.toHaveProperty("proof");
    expect(payload).not.toHaveProperty("proofVerified");
  });

  it("gives every event its own id", () => {
    const db = openDb(":memory:");
    const a = enqueueEvent(db, { type: "ping", data: {} }, NOW);
    const b = enqueueEvent(db, { type: "ping", data: {} }, NOW);
    expect(a).not.toBe(b);
    expect(rows(db)).toHaveLength(2);
  });
});
