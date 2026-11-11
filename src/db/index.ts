import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export type Db = Database.Database;

export interface OpenDbOptions {
  /** Directory of `NNN_name.sql` files, applied in filename order. Defaults to the bundled migrations. */
  migrationsDir?: string;
}

/** Open (or create) the SQLite database and apply any migrations not yet recorded in `schema_migrations`. */
export function openDb(path: string, options: OpenDbOptions = {}): Db {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(
      db
        .prepare("SELECT name FROM schema_migrations")
        .all()
        .map((r) => (r as { name: string }).name),
    );
    const record = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .toSorted()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      db.transaction(() => {
        db.exec(sql);
        record.run(file, new Date().toISOString());
      })();
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
