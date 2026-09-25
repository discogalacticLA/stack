import type { Request } from "express";
import { hasRole } from "../lib/auth.js";
import { html, type SafeHtml } from "../lib/html.js";
import { cartCount } from "../domain/orders.js";
import { csrf, flashes } from "./components.js";

export const APP_NAME = "Stack";

export interface PageOpts {
  title: string;
  body: SafeHtml;
  nav?: string;
  wide?: boolean;
}

export function layout(req: Request, o: PageOpts): string {
  const { user, app } = req.state;
  const nav = (key: string, href: string, label: string) =>
    html`<a href="${href}"${o.nav === key ? html` aria-current="page"` : ""}>${label}</a>`;
  const cart = user ? cartCount(app.db, user.id) : 0;
  const demoUsers = app.config.demoSwitcher
    ? (app.db.prepare("SELECT id, username, display_name FROM users WHERE is_demo = 1 ORDER BY id").all() as any[])
    : [];

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · ${APP_NAME}</title>
<link rel="stylesheet" href="/static/styles.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7.5' fill='%231d1b18'/%3E%3Ccircle cx='8' cy='8' r='2.5' fill='%23b0431f'/%3E%3C/svg%3E">
<script src="/static/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="proto-banner" role="note">Local prototype · sample data is synthetic · marketplace transactions are <strong>simulated</strong> — no real money, shipping or messages.</div>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true"></span>${APP_NAME}<span class="brand-note">working title</span></a>
    <nav class="mainnav" aria-label="Main">
      ${user ? nav("library", "/library", "Library") : ""}
      ${user ? nav("crates", "/crates", "Crates") : ""}
      ${user ? nav("charts", "/charts", "Top 5") : ""}
      ${user ? nav("wants", "/wants", "Wantlist") : ""}
      ${user ? nav("imports", "/imports", "Import") : ""}
      ${nav("discover", "/discover", "Archive")}
      ${user ? nav("selling", "/selling", "Sell") : ""}
      ${user ? nav("orders", "/orders", "Orders") : ""}
      ${hasRole(user, "contributor") ? nav("contribute", "/contribute", "Contribute") : ""}
      ${hasRole(user, "moderator") ? nav("moderate", "/moderate", "Moderate") : ""}
    </nav>
    <div class="usernav">
      ${user
        ? html`<a class="cart-link" href="/cart"${o.nav === "cart" ? html` aria-current="page"` : ""}>Cart <span class="count" aria-label="${cart} items">${cart}</span></a>
          <span class="whoami">${user.display_name}${user.roles.length ? html` <span class="muted small">(${user.roles.join(", ")})</span>` : ""}</span>
          <form method="post" action="/logout" class="inline">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit">Sign out</button></form>`
        : html`<a class="btn btn-sm" href="/login">Sign in</a>`}
    </div>
  </div>
  ${demoUsers.length
    ? html`<form class="dev-switcher" method="post" action="/dev/switch-user">
        ${csrf(req)}
        <label for="dev-user">Development only — switch demo account:</label>
        <select id="dev-user" name="user_id">
          ${demoUsers.map((u) => html`<option value="${u.id}"${user?.id === u.id ? html` selected` : ""}>${u.display_name} (@${u.username})</option>`)}
        </select>
        <input type="hidden" name="return_to" value="${req.originalUrl}">
        <button class="btn btn-sm btn-quiet" type="submit">Switch</button>
      </form>`
    : ""}
</header>
<main id="main" class="${o.wide ? "wide" : ""}" tabindex="-1">
${flashes(req)}
${o.body}
</main>
<footer class="footer">
  <p>${APP_NAME} is a local prototype with a temporary name. “Know what you have. Organize it your way. Share your taste. Discover what comes next.”
  Sample catalog entries, artists, labels, artwork and import files are synthetic. Your library, notes, file paths and storage locations are private.
  Marketplace prices are in USD as a demo currency; taxes are not calculated.</p>
</footer>
</body>
</html>`.value;
}
