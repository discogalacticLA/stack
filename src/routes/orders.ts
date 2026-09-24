import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { DomainError } from "../lib/errors.js";
import { html, raw } from "../lib/html.js";
import { sumCents } from "../lib/money.js";
import { COUNTRY_CODES, countryName } from "../lib/reference.js";
import { ValidationError, type FieldErrors } from "../lib/validation.js";
import {
  ACTION_LABEL, addPurchaseToCollection, addToCart, checkout, getCart, getOrderForParticipant, listOrders, removeFromCart, STATUS_LABEL,
  transitionOrder, type OrderAction, type OrderStatus,
} from "../domain/orders.js";
import { copyPhoto, csrf, errorSummary, grade, money, selectField, simulatedNotice, statusBadge, textField } from "../views/components.js";
import { idParam, me, page } from "./helpers.js";

const destFrom = (req: Request, fallback: string) => {
  const d = String(req.query.dest ?? req.body?.ship_to_country ?? fallback);
  return COUNTRY_CODES.includes(d) ? d : null;
};

export function registerOrderRoutes(app: Express, ctx: AppContext) {
  // ───────── Cart ─────────
  app.post("/cart/add", (req, res) => {
    const user = me(req);
    addToCart(ctx.db, ctx.clock, user.id, Number(req.body.listing_id));
    addFlash(req, "success", "Added to cart. Nothing is reserved until you check out.");
    res.redirect(303, "/cart");
  });

  app.post("/cart/remove", (req, res) => {
    const user = me(req);
    removeFromCart(ctx.db, user.id, Number(req.body.listing_id));
    res.redirect(303, "/cart");
  });

  app.get("/cart", (req, res) => {
    const user = me(req);
    const dest = destFrom(req, user.country);
    const groups = getCart(ctx.db, user.id, dest);
    const payable = groups.filter((g) => g.items.length);
    const allShippable = payable.length > 0 && payable.every((g) => g.shipping.ok);
    page(req, res, {
      title: "Cart",
      nav: "cart",
      body: html`<h1>Cart</h1>
        ${simulatedNotice("Checkout is a simulation. No payment is taken and sellers are not contacted outside this app.")}
        ${groups.length
          ? html`
            <form method="get" class="toolbar panel"><div class="left">
              <label for="f-dest">Ship to</label>
              <select id="f-dest" name="dest"><option value="">Choose…</option>${COUNTRY_CODES.map((c) => html`<option value="${c}"${c === dest ? raw(" selected") : ""}>${countryName(c)}</option>`)}</select>
              <button class="btn btn-sm" type="submit">Update shipping</button></div>
              <p class="estimate">Grouped by seller: checkout creates <strong>one simulated order per seller</strong>, each with its own shipping charge. Taxes and duties are excluded.</p>
            </form>
            ${groups.map((g) => html`<section class="cart-group" aria-label="Items from ${g.seller.display_name}">
              <h2>From ${g.seller.display_name} <span class="muted small">ships from ${countryName(g.items[0]?.shipping_profile.origin_country ?? g.seller.country)}</span></h2>
              ${g.items.map((i) => html`<div class="cart-line">
                <div class="photo-row">${i.photo_ids[0] ? copyPhoto(i.photo_ids[0], i.title, "sm") : ""}</div>
                <div class="grow"><a href="/listings/${i.id}"><strong>${i.artist} — ${i.title}</strong></a><br>
                  <span class="catno">${i.catalog_number ?? "—"}</span> · Media ${grade(i.media_condition)} · Sleeve ${grade(i.sleeve_condition)}</div>
                <strong>${money(i.price_cents)}</strong>
                <form method="post" action="/cart/remove">${csrf(req)}<input type="hidden" name="listing_id" value="${i.id}"><button class="btn btn-quiet btn-sm" type="submit">Remove</button></form>
              </div>`)}
              ${g.unavailable.map((i) => html`<div class="cart-line"><div class="grow"><s>${i.title}</s> <span class="uncertain">No longer available (${i.status})</span></div>
                <form method="post" action="/cart/remove">${csrf(req)}<input type="hidden" name="listing_id" value="${i.id}"><button class="btn btn-quiet btn-sm" type="submit">Remove</button></form></div>`)}
              ${g.items.length ? html`<div class="totals">
                <span>Items</span><span>${money(g.subtotal_cents)}</span>
                <span>Shipping${g.shipping.ok ? "" : ""}</span><span>${g.shipping.ok ? money(g.shipping.cents) : html`<span class="uncertain">n/a</span>`}</span>
                <span class="grand">Order total (est.)</span><span class="grand">${g.total_cents != null ? money(g.total_cents) : "—"}</span>
              </div>
              ${g.shipping.ok ? html`<p class="estimate">${g.shipping.description}</p>` : html`<p class="uncertain small">${g.shipping.reason} Remove these items or choose another destination to check out.</p>`}` : ""}
            </section>`)}
            ${payable.length
              ? html`<div class="totals panel">
                  <span>${payable.length} simulated order${payable.length === 1 ? "" : "s"}</span><span></span>
                  <span class="grand">Grand total (est.)</span><span class="grand">${allShippable ? money(sumCents(payable.map((g) => g.total_cents!))) : "—"}</span>
                </div>
                <div class="actions">${allShippable ? html`<a class="btn btn-primary" href="/checkout?dest=${dest}">Continue to simulated checkout</a>` : html`<span class="btn btn-quiet" aria-disabled="true">Checkout unavailable: fix shipping above</span>`}</div>`
              : ""}`
          : html`<div class="empty"><h2>Your cart is empty</h2><p>Find a release in <a href="/discover">Discover</a> and open “copies for sale”.</p></div>`}`,
    });
  });

  // ───────── Checkout (idempotent) ─────────
  const renderCheckout = (req: Request, res: Response, values: Record<string, any>, errors?: FieldErrors) => {
    const user = me(req);
    const dest = COUNTRY_CODES.includes(values.ship_to_country) ? values.ship_to_country : null;
    const groups = getCart(ctx.db, user.id, dest).filter((g) => g.items.length);
    if (!groups.length) {
      addFlash(req, "info", "Your cart is empty.");
      return res.redirect(303, "/cart");
    }
    page(req, res, {
      title: "Simulated checkout",
      nav: "cart",
      body: html`<h1>Simulated checkout</h1>
        ${simulatedNotice("This creates simulated orders only. No payment details are requested, no money moves, and no emails are sent.")}
        <div class="detail">
          <form method="post" action="/checkout" novalidate>
            ${csrf(req)}${errorSummary(errors)}
            <input type="hidden" name="idempotency_key" value="${values.idempotency_key}">
            <fieldset><legend>Ship to (demo address)</legend>
              ${textField({ label: "Recipient name", name: "ship_to_name", value: values.ship_to_name, errors, required: true, autocomplete: "name" })}
              ${textField({ label: "Address", name: "ship_to_line1", value: values.ship_to_line1, errors, required: true, autocomplete: "address-line1" })}
              <div class="grid-2">
                ${textField({ label: "City", name: "ship_to_city", value: values.ship_to_city, errors, required: true })}
                ${textField({ label: "Postal code", name: "ship_to_postcode", value: values.ship_to_postcode, errors, required: true })}
              </div>
              ${selectField({ label: "Country", name: "ship_to_country", value: values.ship_to_country, options: COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) })), blank: "Choose…", errors, required: true, hint: "Changing the country can change shipping; totals are re-checked when you submit." })}
            </fieldset>
            <p class="small">Placing the order reserves each copy for ${ctx.config.reservationMinutes} minutes while you complete the simulated payment. Unpaid reservations are released automatically.</p>
            <button class="btn btn-primary" type="submit">Place ${groups.length} simulated order${groups.length === 1 ? "" : "s"}</button>
          </form>
          <div>
            <h2>Summary</h2>
            ${groups.map((g) => html`<div class="panel"><h3>Order from ${g.seller.display_name}</h3>
              <ul class="small">${g.items.map((i) => html`<li>${i.title} <span class="catno">${i.catalog_number ?? ""}</span> — ${money(i.price_cents)}</li>`)}</ul>
              <div class="totals"><span>Items</span><span>${money(g.subtotal_cents)}</span><span>Shipping</span><span>${g.shipping.ok ? money(g.shipping.cents) : "—"}</span>
              <span class="grand">Total</span><span class="grand">${g.total_cents != null ? money(g.total_cents) : "—"}</span></div>
              ${!g.shipping.ok ? html`<p class="uncertain small">${g.shipping.reason}</p>` : ""}</div>`)}
            <p class="estimate">Estimates in USD demo currency. Taxes and duties excluded.</p>
          </div>
        </div>`,
    }, errors ? 422 : 200);
  };

  app.get("/checkout", (req, res) => {
    const user = me(req);
    renderCheckout(req, res, { idempotency_key: crypto.randomBytes(18).toString("base64url"), ship_to_name: user.display_name, ship_to_country: destFrom(req, user.country) ?? "" });
  });

  app.post("/checkout", (req, res) => {
    const user = me(req);
    try {
      const r = checkout(ctx.db, ctx.clock, ctx.config.reservationMinutes, user.id, req.body);
      addFlash(req, r.replayed ? "info" : "success", r.replayed
        ? "This checkout was already submitted — showing the orders it created (no duplicates were made)."
        : `Created ${r.orderIds.length} simulated order${r.orderIds.length === 1 ? "" : "s"}. Complete the simulated payment within ${ctx.config.reservationMinutes} minutes.`);
      res.redirect(303, r.orderIds.length === 1 ? `/orders/${r.orderIds[0]}` : "/orders");
    } catch (e) {
      if (e instanceof ValidationError) return renderCheckout(req, res, req.body, e.fields);
      if (e instanceof DomainError) {
        addFlash(req, "error", e.message);
        return res.redirect(303, "/cart");
      }
      throw e;
    }
  });

  // ───────── Orders ─────────
  app.get("/orders", (req, res) => {
    const user = me(req);
    const role = req.query.role === "seller" ? "seller" : "buyer";
    const status = Object.keys(STATUS_LABEL).includes(String(req.query.status)) ? String(req.query.status) : "";
    const orders = listOrders(ctx.db, user.id, role, status || undefined);
    const tab = (r: string, label: string) => html`<a href="/orders?role=${r}" aria-current="${role === r}">${label}</a>`;
    page(req, res, {
      title: "Orders",
      nav: "orders",
      body: html`<h1>Simulated orders</h1>
        ${simulatedNotice()}
        <div class="toolbar"><span class="segmented">${tab("buyer", "Purchases")}${tab("seller", "Sales")}</span>
          <form method="get" class="left"><input type="hidden" name="role" value="${role}"><label for="f-ostatus">Status</label>
            <select id="f-ostatus" name="status"><option value="">All</option>${Object.entries(STATUS_LABEL).map(([k, v]) => html`<option value="${k}"${k === status ? raw(" selected") : ""}>${v}</option>`)}</select>
            <button class="btn btn-sm btn-quiet" type="submit">Filter</button></form></div>
        ${orders.length
          ? html`<div class="table-wrap"><table class="compact"><thead><tr><th>Order</th><th>${role === "buyer" ? "Seller" : "Buyer"}</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Placed</th></tr></thead><tbody>
              ${orders.map((o) => html`<tr><td><a href="/orders/${o.id}">#${o.id}</a></td><td>${role === "buyer" ? o.seller_name_snapshot : o.buyer_name_snapshot}</td>
                <td>${o.first_title}${o.line_count > 1 ? ` +${o.line_count - 1}` : ""}</td><td class="num">${money(o.total_cents)}</td>
                <td>${statusBadge(o.status, STATUS_LABEL[o.status as OrderStatus])}</td><td class="small">${o.created_at.slice(0, 16).replace("T", " ")}</td></tr>`)}
            </tbody></table></div>`
          : html`<div class="empty"><h2>No ${role === "buyer" ? "purchases" : "sales"}${status ? " with this status" : ""} yet</h2></div>`}`,
    });
  });

  app.get("/orders/:id", (req, res) => {
    const user = me(req);
    const o = getOrderForParticipant(ctx.db, user.id, idParam(req));
    const actionForm = (a: OrderAction) =>
      a === "ship"
        ? html`<form method="post" action="/orders/${o.id}/ship" class="panel">${csrf(req)}<h3>Record fulfillment</h3>
            <div class="grid-2">${textField({ label: "Carrier", name: "carrier", required: true, placeholder: "e.g. Postal service" })}${textField({ label: "Tracking reference (optional)", name: "tracking" })}</div>
            <p class="muted small">Recorded only. No carrier is contacted and the buyer is not emailed.</p>
            <button class="btn btn-primary" type="submit">${ACTION_LABEL.ship}</button></form>`
        : html`<form method="post" action="/orders/${o.id}/${a}" class="inline">${csrf(req)}<button class="btn ${a === "cancel" ? "btn-danger" : "btn-primary"}" type="submit">${ACTION_LABEL[a]}</button></form>`;
    page(req, res, {
      title: `Order #${o.id}`,
      nav: "orders",
      body: html`<nav class="crumbs"><a href="/orders?role=${o.role}">${o.role === "buyer" ? "Purchases" : "Sales"}</a> / <span>Order #${o.id}</span></nav>
        <h1>Simulated order #${o.id} ${statusBadge(o.status, STATUS_LABEL[o.status as OrderStatus])}</h1>
        ${simulatedNotice()}
        <p>${o.role === "buyer" ? html`Seller: <strong>${o.seller_name_snapshot}</strong>` : html`Buyer: <strong>${o.buyer_name_snapshot}</strong>`} · placed ${o.created_at.slice(0, 16).replace("T", " ")} UTC</p>
        ${o.status === "awaiting_payment" && o.reserved_until ? html`<p class="sim-notice"><strong>Reserved</strong> until ${o.reserved_until.slice(0, 16).replace("T", " ")} UTC. If the simulated payment isn't completed by then, the copies are released.</p>` : ""}
        ${o.actions.length ? html`<div class="action-row">${o.actions.map(actionForm)}</div>` : ""}
        <h2>Items <span class="muted small">(snapshot at purchase — later catalog or listing edits don't change this)</span></h2>
        ${o.lines.map((l: any) => html`<div class="cart-line">
          <div class="photo-row">${l.photo_ids.slice(0, 2).map((p: number) => copyPhoto(p, l.title_snapshot, "sm"))}</div>
          <div class="grow"><strong>${l.artist_snapshot} — ${l.title_snapshot}</strong><br>
            <span class="catno">${l.catalog_number_snapshot ?? "—"}</span> · ${l.label_snapshot ?? "label unknown"} · ${l.format_snapshot} · ${countryName(l.country_snapshot)} · ${l.year_snapshot ?? "?"}<br>
            Media ${grade(l.media_condition_snapshot)} · Sleeve ${grade(l.sleeve_condition_snapshot)} — <span class="small">${l.condition_description_snapshot}</span>
            <br><a class="small" href="/editions/${l.edition_id}">Current archive entry</a></div>
          <strong>${money(l.price_cents, l.currency)}</strong>
          ${o.role === "buyer" && o.status === "delivered"
            ? l.buyer_copy_id
              ? html`<a class="btn btn-quiet btn-sm" href="/copies/${l.buyer_copy_id}">In your collection</a>`
              : html`<form method="post" action="/order-lines/${l.id}/add-to-collection">${csrf(req)}<button class="btn btn-sm" type="submit">Add to my collection</button></form>`
            : ""}
        </div>`)}
        <div class="totals panel">
          <span>Items</span><span>${money(o.items_subtotal_cents)}</span>
          <span>Shipping</span><span>${money(o.shipping_cents)}</span>
          <span class="grand">Total (simulated)</span><span class="grand">${money(o.total_cents)}</span>
        </div>
        <p class="estimate">${o.shipping_rule_snapshot}. Taxes and duties excluded.</p>
        <h2>Ship to</h2>
        <p>${o.ship_to_name}<br>${o.ship_to_line1}<br>${o.ship_to_city} ${o.ship_to_postcode}<br>${countryName(o.ship_to_country)}</p>
        ${o.fulfillment_carrier ? html`<p>Fulfillment: ${o.fulfillment_carrier}${o.fulfillment_tracking ? ` · ${o.fulfillment_tracking}` : ""}</p>` : ""}
        <h2>History</h2>
        <ol class="small">${o.events.map((ev: any) => html`<li>${ev.created_at.slice(0, 16).replace("T", " ")} — ${ev.from_status ? `${ev.from_status.replace(/_/g, " ")} → ` : ""}<strong>${ev.to_status.replace(/_/g, " ")}</strong> by ${ev.actor_name ?? "system"}${ev.note ? html` <span class="muted">(${ev.note})</span>` : ""}</li>`)}</ol>`,
    });
  });

  for (const action of ["pay", "cancel", "ship", "deliver"] as OrderAction[]) {
    app.post(`/orders/:id/${action}`, (req, res) => {
      const user = me(req);
      const id = idParam(req);
      const to = transitionOrder(ctx.db, ctx.clock, user.id, id, action, req.body);
      addFlash(req, "success", `Order #${id}: ${STATUS_LABEL[to]}.${to === "cancelled" ? " The copies are available again." : ""}`);
      res.redirect(303, `/orders/${id}`);
    });
  }

  app.post("/order-lines/:id/add-to-collection", (req, res) => {
    const user = me(req);
    const copyId = addPurchaseToCollection(ctx.db, ctx.clock, user.id, idParam(req));
    addFlash(req, "success", "Added to your collection as a private copy.");
    res.redirect(303, `/copies/${copyId}`);
  });
}
