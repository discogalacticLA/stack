import { loadConfig } from "../config.js";
import { migrate, migrateDown, openDatabase } from "./index.js";

// npm run migrate            → apply pending migrations
// npm run migrate -- --down  → revert the latest migration (refused if it would lose data)
const config = loadConfig();
const db = openDatabase(config.databasePath, { migrate: false });
if (process.argv.includes("--down")) {
  console.log(`Reverted ${migrateDown(db)}`);
} else {
  const ran = migrate(db);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
}
const applied = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r: any) => r.name);
console.log(`Applied migrations: ${applied.join(", ")} · ${config.databasePath}`);
db.close();
