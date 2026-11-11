import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";

const MIGRATIONS = new URL("../src/db/migrations/", import.meta.url).pathname;

const NOW = "2026-11-05T10:00:00Z";

function insertInvoice(db: ReturnType<typeof openDb>, id = "inv_1") {
  db.prepare(
    `INSERT INTO invoices (id, amount, asset_id, status, expires_at, created_at, updated_at)
     VALUES (?, '5000000', 'nep141:usdc.near', 'open', ?, ?, ?)`,
  ).run(id, NOW, NOW, NOW);
}

function insertAttempt(db: ReturnType<typeof openDb>, id: string, invoiceId: string, depositAddress: string) {
  db.prepare(
    `INSERT INTO attempts (id, invoice_id, origin_asset, origin_chain, refund_to, deposit_address, amount_in,
       min_amount_in, deadline, quote_json, oneclick_status, status, created_at, updated_at)
     VALUES (?, ?, 'nep141:base-usdc', 'base', '0xabc', ?, '5010000', '5000000', ?, '{}', 'PENDING_DEPOSIT', 'awaiting', ?, ?)`,
  ).run(id, invoiceId, depositAddress, NOW, NOW, NOW);
}

describe("openDb", () => {
  it("creates every table from the plan's data model", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "attempts",
      "invoices",
      "refund_ledger_daily",
      "refunds",
      "schema_migrations",
      "webhook_deliveries",
    ]);
  });

  it("enforces foreign keys", () => {
    const db = openDb(":memory:");
    expect(() => insertAttempt(db, "att_1", "inv_missing", "addr_1")).toThrow(/FOREIGN KEY/);
  });

  it("refuses two attempts that share a deposit address", () => {
    const db = openDb(":memory:");
    insertInvoice(db);
    insertAttempt(db, "att_1", "inv_1", "addr_1");
    expect(() => insertAttempt(db, "att_2", "inv_1", "addr_1")).toThrow(/UNIQUE/);
  });
});

const applied = (db: ReturnType<typeof openDb>) =>
  db
    .prepare("SELECT name FROM schema_migrations ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);

function insertRefundRow(db: ReturnType<typeof openDb>, id: string, key: string | null, invoiceId = "inv_1") {
  db.prepare(
    `INSERT INTO refunds (id, invoice_id, attempt_id, amount, status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 'att_1', '1000000', 'pending', ?, ?, ?)`,
  ).run(id, invoiceId, key, NOW, NOW);
}

describe("003 refund execution", () => {
  it("refuses two refunds of one invoice with the same idempotency key", () => {
    const db = openDb(":memory:");
    insertInvoice(db);
    insertAttempt(db, "att_1", "inv_1", "addr_1");
    insertRefundRow(db, "ref_1", "k");
    expect(() => insertRefundRow(db, "ref_2", "k")).toThrow(/UNIQUE/);
  });

  it("allows the same key on another invoice, and any number of refunds without a key", () => {
    const db = openDb(":memory:");
    insertInvoice(db, "inv_1");
    insertInvoice(db, "inv_2");
    insertAttempt(db, "att_1", "inv_1", "addr_1");
    insertRefundRow(db, "ref_1", "k");
    expect(() => insertRefundRow(db, "ref_2", "k", "inv_2")).not.toThrow();
    insertRefundRow(db, "ref_3", null);
    expect(() => insertRefundRow(db, "ref_4", null)).not.toThrow();
  });
});

describe("004 automatic refund retries", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "tilll-db-"));
    dirs.push(d);
    return d;
  };

  it("makes an automatic refund recorded before it due at once, and leaves signed and merchant refunds alone", () => {
    const dir = tmp();
    for (const name of ["001_init.sql", "002_attempt_token.sql", "003_refund_execution.sql"]) {
      copyFileSync(join(MIGRATIONS, name), join(dir, name));
    }
    const file = join(dir, "tilll.db");
    const before = openDb(file, { migrationsDir: dir });
    insertInvoice(before);
    insertAttempt(before, "att_1", "inv_1", "addr_1");
    const insert = before.prepare(
      `INSERT INTO refunds (id, invoice_id, attempt_id, amount, reason, status, intent_deadline, created_at, updated_at)
       VALUES (?, 'inv_1', 'att_1', '1', ?, ?, ?, ?, ?)`,
    );
    insert.run("ref_auto", "overpayment_auto", "pending", null, NOW, NOW);
    insert.run("ref_signed", "overpayment_auto", "pending", NOW, NOW, NOW);
    insert.run("ref_manual", "merchant_request", "pending", null, NOW, NOW);
    before.close();

    copyFileSync(join(MIGRATIONS, "004_auto_refund_retries.sql"), join(dir, "004_auto_refund_retries.sql"));
    const after = openDb(file, { migrationsDir: dir });

    const rows = after.prepare("SELECT id, tries, next_try_at AS nextTryAt FROM refunds ORDER BY id").all();
    expect(rows).toEqual([
      { id: "ref_auto", tries: 0, nextTryAt: NOW },
      { id: "ref_manual", tries: 0, nextTryAt: null },
      { id: "ref_signed", tries: 0, nextTryAt: null },
    ]);
  });
});

describe("002 attempt token snapshot", () => {
  it("records the payer's token symbol and decimals on each attempt, so displays never depend on the live token list", () => {
    const db = openDb(":memory:");
    insertInvoice(db);
    insertAttempt(db, "att_1", "inv_1", "addr_1");
    db.prepare("UPDATE attempts SET origin_symbol = 'USDC', origin_decimals = 6 WHERE id = 'att_1'").run();
    expect(db.prepare("SELECT origin_symbol AS s, origin_decimals AS d FROM attempts").get()).toEqual({
      s: "USDC",
      d: 6,
    });
  });
});

describe("migrations", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "tilll-db-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("re-opening an existing database keeps its data and does not re-apply migrations", () => {
    const file = join(tmp(), "tilll.db");
    const first = openDb(file);
    insertInvoice(first);
    first.close();

    const second = openDb(file);
    expect(applied(second)).toEqual([
      "001_init.sql",
      "002_attempt_token.sql",
      "003_refund_execution.sql",
      "004_auto_refund_retries.sql",
    ]);
    expect(second.prepare("SELECT count(*) AS n FROM invoices").get()).toEqual({ n: 1 });
  });

  it("applies only migrations it has not recorded yet", () => {
    const migrations = tmp();
    const file = join(tmp(), "tilll.db");
    writeFileSync(join(migrations, "001_a.sql"), "CREATE TABLE a (x INTEGER);");
    openDb(file, { migrationsDir: migrations }).close();

    writeFileSync(join(migrations, "002_b.sql"), "CREATE TABLE b (y INTEGER);");
    const db = openDb(file, { migrationsDir: migrations });
    expect(applied(db)).toEqual(["001_a.sql", "002_b.sql"]);
  });

  it("rolls a failing migration back completely and does not record it", () => {
    const migrations = tmp();
    const file = join(tmp(), "tilll.db");
    writeFileSync(join(migrations, "001_ok.sql"), "CREATE TABLE ok (x INTEGER);");
    openDb(file, { migrationsDir: migrations }).close();

    writeFileSync(join(migrations, "002_bad.sql"), "CREATE TABLE half (x INTEGER); CREATE TABLE half (x INTEGER);");
    expect(() => openDb(file, { migrationsDir: migrations })).toThrow(/already exists/);

    writeFileSync(join(migrations, "002_bad.sql"), "CREATE TABLE half (x INTEGER);");
    const db = openDb(file, { migrationsDir: migrations });
    expect(applied(db)).toEqual(["001_ok.sql", "002_bad.sql"]);
  });
});
