import type { Express } from "express";
import type { AppContext } from "../context.js";
import { createSession, destroySession, verifyPassword } from "../lib/auth.js";
import { forbidden } from "../lib/errors.js";
import { html } from "../lib/html.js";
import { addFlash, setSessionCookie } from "../app.js";
import { csrf, errorSummary, safeBack, textField } from "../views/components.js";
import { page } from "./helpers.js";

export const DEMO_PASSWORD = "demo-password";

export function registerAuthRoutes(app: Express, ctx: AppContext) {
  const loginPage = (req: any, res: any, error?: string, username = "") => {
    const demo = ctx.config.isDevelopment
      ? (ctx.db.prepare("SELECT u.username, u.display_name, GROUP_CONCAT(r.role) AS roles FROM users u LEFT JOIN user_roles r ON r.user_id = u.id WHERE u.is_demo = 1 GROUP BY u.id ORDER BY u.id").all() as any[])
      : [];
    page(req, res, {
      title: "Sign in",
      body: html`<div class="form-narrow">
        <h1>Sign in</h1>
        ${error ? errorSummary({ _form: error }, "Sign-in failed") : ""}
        <form method="post" action="/login" class="panel">
          ${csrf(req)}
          <input type="hidden" name="return_to" value="${safeBack(req.query.return_to ?? req.body?.return_to, "/")}">
          ${textField({ label: "Username", name: "username", value: username, autocomplete: "username", required: true })}
          ${textField({ label: "Password", name: "password", type: "password", autocomplete: "current-password", required: true })}
          <button class="btn btn-primary" type="submit">Sign in</button>
        </form>
        ${demo.length
          ? html`<div class="panel"><h2>Local demo accounts</h2>
            <p class="muted small">Development only. All use the password <code>${DEMO_PASSWORD}</code>. Everyone can collect, buy and sell; roles add archive permissions.</p>
            <table class="compact"><thead><tr><th>Username</th><th>Name</th><th>Roles</th></tr></thead><tbody>
            ${demo.map((d) => html`<tr><td><code>${d.username}</code></td><td>${d.display_name}</td><td>${d.roles ?? "member"}</td></tr>`)}
            </tbody></table></div>`
          : ""}
      </div>`,
    }, error ? 401 : 200);
  };

  app.get("/login", (req, res) => loginPage(req, res));

  app.post("/login", (req, res) => {
    const username = String(req.body.username ?? "").trim();
    const user = ctx.db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(username) as { id: number; password_hash: string } | undefined;
    if (!user || !verifyPassword(String(req.body.password ?? ""), user.password_hash)) {
      return loginPage(req, res, "Username or password is incorrect.", username);
    }
    // Rotate the session on sign-in.
    destroySession(ctx.db, req.state.session.id);
    const { token } = createSession(ctx.db, ctx.clock, user.id);
    setSessionCookie(res, ctx, token);
    res.redirect(303, safeBack(req.body.return_to, "/"));
  });

  app.post("/logout", (req, res) => {
    destroySession(ctx.db, req.state.session.id);
    res.clearCookie("ra_sid");
    res.redirect(303, "/");
  });

  // Development-only account switcher. Not registered at all outside development.
  if (ctx.config.demoSwitcher) {
    app.post("/dev/switch-user", (req, res) => {
      if (!ctx.config.demoSwitcher) throw forbidden();
      const target = ctx.db.prepare("SELECT id, display_name FROM users WHERE id = ? AND is_demo = 1").get(Number(req.body.user_id)) as any;
      if (!target) throw forbidden("Only demo accounts can be switched to.");
      destroySession(ctx.db, req.state.session.id);
      const { token, session } = createSession(ctx.db, ctx.clock, target.id);
      setSessionCookie(res, ctx, token);
      req.state.session = session;
      addFlash(req, "info", `Now acting as ${target.display_name} (development switcher).`);
      res.redirect(303, safeBack(req.body.return_to, "/"));
    });
  }
}
