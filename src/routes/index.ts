import type { Express } from "express";
import type { AppContext } from "../context.js";
import { registerApiRoutes } from "./api.js";
import { registerEntityRoutes } from "./entities.js";
import { registerAuthRoutes } from "./auth.js";
import { registerCatalogRoutes } from "./catalog.js";
import { registerLibraryRoutes } from "./library.js";
import { registerCurationRoutes } from "./curation.js";
import { registerImportRoutes } from "./imports.js";
import { registerContributeRoutes } from "./contribute.js";
import { registerMediaRoutes } from "./media.js";
import { registerOrderRoutes } from "./orders.js";
import { registerSellingRoutes } from "./selling.js";

export function registerRoutes(app: Express, ctx: AppContext) {
  registerAuthRoutes(app, ctx);
  registerCatalogRoutes(app, ctx);
  registerEntityRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
  registerCurationRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerSellingRoutes(app, ctx);
  registerOrderRoutes(app, ctx);
  registerContributeRoutes(app, ctx);
  registerApiRoutes(app, ctx);
}
