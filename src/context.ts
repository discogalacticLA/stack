import type { DB } from "./db/index.js";
import type { Clock } from "./lib/clock.js";
import type { Config } from "./config.js";
import type { CurrentUser, SessionRow } from "./lib/auth.js";

export interface AppContext {
  db: DB;
  clock: Clock;
  config: Config;
}

export interface Flash {
  kind: "success" | "error" | "info";
  message: string;
}

export interface RequestState {
  app: AppContext;
  session: SessionRow;
  user: CurrentUser | null;
  flash: Flash[];
}

declare global {
  namespace Express {
    interface Request {
      state: RequestState;
    }
  }
}
