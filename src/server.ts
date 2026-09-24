import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { systemClock } from "./lib/clock.js";
import { expireReservations } from "./domain/orders.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const ctx = { db, clock: systemClock, config };
const app = createApp(ctx);

// Reservations are also expired lazily on every request; this catches idle periods.
setInterval(() => expireReservations(db, systemClock), 60_000).unref();

app.listen(config.port, () => {
  console.log(`Record Archive prototype on http://localhost:${config.port}`);
  console.log(`Database: ${config.databasePath} · demo switcher: ${config.demoSwitcher ? "on (development)" : "off"}`);
});
