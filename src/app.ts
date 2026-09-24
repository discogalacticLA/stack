import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext, Flash } from "./context.js";
import { createSession, findSession, loadUser } from "./lib/auth.js";
import { DomainError, HttpError } from "./lib/errors.js";
import { html } from "./lib/html.js";
import { importUploadMiddleware, uploadMiddleware } from "./lib/uploads.js";
import { ValidationError } from "./lib/validation.js";
import { expireReservations } from "./domain/orders.js";
import { layout } from "./views/layout.js";
import { safeBack } from "./views/components.js";
import { registerRoutes } from "./routes/index.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
export const SESSION_COOKIE = "ra_sid";

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "extended");

  // Security headers (no external scripts; YouTube frames only after a click).
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-src https://www.youtube-nocookie.com; " +
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.use("/static", express.static(PUBLIC_DIR, { maxAge: ctx.config.isDevelopment ? 0 : "1h" }));
  app.use(express.urlencoded({ extended: true, limit: "200kb" }));
  app.use(express.json({ limit: "100kb" }));
  // Multipart forms are parsed before the CSRF check. Import uploads use the field "file"
  // (up to 30 MB); every other form uses "images" (photos, up to 5 MB each).
  app.use((req, res, next) => {
    if (!req.is("multipart/form-data")) return next();
    if (req.path === "/imports") return importUploadMiddleware.single("file")(req, res, next);
    return uploadMiddleware.array("images")(req, res, next);
  });

  // Session + current user.
  app.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    let session = findSession(ctx.db, ctx.clock, token);
    if (!session) {
      const created = createSession(ctx.db, ctx.clock, null);
      session = created.session;
      setSessionCookie(res, ctx, created.token);
    }
    let flash: Flash[] = [];
    if (req.method === "GET" && session.flash) {
      flash = JSON.parse(session.flash);
      ctx.db.prepare("UPDATE sessions SET flash = NULL WHERE id = ?").run(session.id);
    }
    req.state = { app: ctx, session, user: session.user_id ? loadUser(ctx.db, session.user_id) : null, flash };
    next();
  });

  // CSRF: every state-changing request must carry the session's token.
  app.use((req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const sent = (req.body && req.body._csrf) || req.get("x-csrf-token");
    if (sent !== req.state.session.csrf_token) return next(new HttpError(403, "This form expired or came from another site. Reload the page and try again."));
    next();
  });

  // Lazily release expired reservations so availability is always current.
  app.use((_req, _res, next) => {
    expireReservations(ctx.db, ctx.clock);
    next();
  });

  registerRoutes(app, ctx);

  app.use((req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, "Page not found")));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err?.code === "LIMIT_FILE_SIZE") err = new DomainError(req.path === "/imports" ? "Import files must be 30 MB or smaller." : "Each image must be 5 MB or smaller.", 422);
    if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE") err = new DomainError("Upload at most 6 images at a time.", 422);
    const isApi = req.path.startsWith("/api/");
    if (err instanceof HttpError && err.status === 401 && !isApi) {
      if (req.method === "GET") return res.redirect(`/login?return_to=${encodeURIComponent(req.originalUrl)}`);
    }
    let status = 500;
    let message = "Something went wrong.";
    if (err instanceof HttpError || err instanceof DomainError) {
      status = err.status;
      message = err.message;
    } else if (err instanceof ValidationError) {
      status = 422;
      message = Object.values(err.fields).join(" ");
    } else {
      console.error(err);
    }
    if (isApi) return res.status(status).json({ error: message });
    // Business-rule failures on form posts: show the message where the user came from.
    if (req.method === "POST" && status !== 403 && (err instanceof DomainError || err instanceof ValidationError) && req.state) {
      const back = safeBack(refererPath(req), "/");
      addFlash(req, "error", message);
      return res.redirect(303, back);
    }
    if (!req.state) return res.status(status).send(message);
    res.status(status).send(
      layout(req, {
        title: status === 404 ? "Not found" : "Problem",
        body: html`<div class="empty"><h1>${status === 404 ? "Not found" : status === 403 ? "Not allowed" : "Something went wrong"}</h1>
          <p>${message}</p><p><a class="btn btn-quiet" href="/">Back to your library</a></p></div>`,
      }),
    );
  });

  return app;
}

function refererPath(req: Request): string | null {
  const ref = req.get("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.host !== req.get("host")) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: Response, ctx: AppContext, token: string) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: ctx.config.cookieSecure, maxAge: 14 * 86400_000, path: "/" });
}

export function addFlash(req: Request, kind: Flash["kind"], message: string) {
  const { db } = req.state.app;
  const row = db.prepare("SELECT flash FROM sessions WHERE id = ?").get(req.state.session.id) as { flash: string | null } | undefined;
  const list: Flash[] = row?.flash ? JSON.parse(row.flash) : [];
  list.push({ kind, message });
  db.prepare("UPDATE sessions SET flash = ? WHERE id = ?").run(JSON.stringify(list), req.state.session.id);
}
