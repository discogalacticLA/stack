import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterUp, guards } from "./hooks.js";

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Opens a SQLite database (file path or ":memory:") and applies pending migrations. */
export function openDatabase(file: string, opts: { migrate?: boolean } = {}): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (opts.migrate !== false) migrate(db);
  return db;
}

/** Applies numbered .sql files in order, each inside its own transaction. */
export function migrate(db: DB, opts: { until?: string } = {}): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r: any) => r.name as string),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (opts.until && file > opts.until) break;
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    // Table rebuilds (SQLite's documented ALTER procedure) need foreign keys off *outside*
    // the transaction; integrity is re-checked before committing.
    const rebuild = sql.startsWith("-- foreign_keys: off");
    if (rebuild) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        afterUp[file]?.(db);
        if (rebuild) {
          const problems = db.pragma("foreign_key_check") as unknown[];
          if (problems.length) throw new Error(`Migration ${file} broke foreign keys: ${JSON.stringify(problems.slice(0, 5))}`);
        }
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      })();
    } finally {
      if (rebuild) db.pragma("foreign_keys = ON");
    }
    ran.push(file);
  }
  return ran;
}

/**
 * Reverts the most recently applied migration using its `.down.sql` file. Refuses when there is
 * no down file, or when the migration's guard reports that reverting would lose data.
 */
export function migrateDown(db: DB): string {
  const last = db.prepare("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1").get() as { name: string } | undefined;
  if (!last) throw new Error("No migrations have been applied.");
  const downFile = path.join(MIGRATIONS_DIR, last.name.replace(/\.sql$/, ".down.sql"));
  if (!fs.existsSync(downFile)) throw new Error(`${last.name} has no down migration (it is forward-only; see docs/ARCHITECTURE.md).`);
  const problem = guards[last.name]?.(db);
  if (problem) throw new Error(`Refusing to revert ${last.name}: ${problem}`);
  const sql = fs.readFileSync(downFile, "utf8");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(sql);
      const problems = db.pragma("foreign_key_check") as unknown[];
      if (problems.length) throw new Error(`Down migration broke foreign keys: ${JSON.stringify(problems.slice(0, 5))}`);
      db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(last.name);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return last.name;
}
