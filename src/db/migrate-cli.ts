import { loadConfig } from "../config.js";
import { openDatabase } from "./index.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
console.log(`Database ready at ${config.databasePath}`);
db.close();
