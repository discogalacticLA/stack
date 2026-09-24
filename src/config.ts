import fs from "node:fs";

export interface Config {
  port: number;
  databasePath: string;
  uploadDir: string;
  isDevelopment: boolean;
  demoSwitcher: boolean;
  reservationMinutes: number;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && fs.existsSync(".env")) process.loadEnvFile(".env");
  const isDevelopment = (env.NODE_ENV ?? "development") === "development";
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/archive.db",
    uploadDir: env.UPLOAD_DIR ?? "./data/uploads",
    isDevelopment,
    // The switcher can only ever be on in development, whatever DEMO_SWITCHER says.
    demoSwitcher: isDevelopment && env.DEMO_SWITCHER !== "false",
    reservationMinutes: Number(env.RESERVATION_MINUTES ?? 30),
    cookieSecure: env.COOKIE_SECURE === "true",
  };
}
