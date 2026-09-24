import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { DomainError } from "../lib/errors.js";
import { html, raw } from "../lib/html.js";
import { centsToInput } from "../lib/money.js";
import { COUNTRY_CODES, countryName, MEDIA_CONDITIONS, SLEEVE_CONDITIONS } from "../lib/reference.js";
import { quoteShipping, zoneLabel, type ShippingProfile } from "../lib/shipping.js";
import { ValidationError, type FieldErrors } from "../lib/validation.js";
import { getOwnCopy } from "../domain/library.js";
import {
  createDraftListing, getOwnListing, listSellerListings, listShippingProfiles, publishListing, saveShippingProfile, updateListing, withdrawListing,
} from "../domain/listings.js";
import { copyPhoto, csrf, errorSummary, grade, money, selectField, statusBadge, textArea, textField } from "../views/components.js";
import { idParam, me, page } from "./helpers.js";

function profileSummary(p: ShippingProfile) {
  const z = (first: number | null, add: number | null) => (first == null ? "does not ship" : `${money(first)} + ${money(add ?? first)} each additional`);
  return html`<strong>${p.name}</strong> (from ${countryName(p.origin_country)}): domestic ${z(p.domestic_first, p.domestic_additional)}; same region ${z(p.region_first, p.region_additional)}; international ${z(p.world_first, p.world_additional)}`;
}

function listingForm(req: Request, ctx: AppContext, o: { action: string; copy: any; values: Record<string, any>; errors?: FieldErrors; submit: string }) {
  const user = me(req);
  const profiles = listShippingProfiles(ctx.db, user.id);
  const selectedPhotos = new Set((Array.isArray(o.values.photo_ids) ? o.values.photo_ids : [o.values.photo_ids]).filter(Boolean).map(String));
  const opts = (list: readonly { code: string; label: string }[]) => list.map((c) => ({ value: c.code, label: c.label }));
  return html`<form method="post" action="${o.action}" class="form-narrow" novalidate>
    ${csrf(req)}
    ${errorSummary(o.errors)}
    <fieldset><legend>Price</legend>
      ${textField({ label: "Price (USD, demo currency)", name: "price", value: o.values.price, inputmode: "decimal", placeholder: "24.00", errors: o.errors, required: true, hint: "One listing is one physical copy. Taxes are not calculated in this prototype." })}
    </fieldset>
    <fieldset><legend>Public condition</legend>
      <p class="hint">Buyers see these grades and your description. Your private notes, storage location and purchase price are never shown.</p>
      <div class="grid-2">
        ${selectField({ label: "Media grade", name: "media_condition", value: o.values.media_condition, options: opts(MEDIA_CONDITIONS), blank: "Choose…", errors: o.errors, required: true })}
        ${selectField({ label: "Sleeve grade", name: "sleeve_condition", value: o.values.sleeve_condition, options: opts(SLEEVE_CONDITIONS), blank: "Choose…", errors: o.errors, required: true })}
      </div>
      ${textArea({ label: "Condition description", name: "condition_description", value: o.values.condition_description, errors: o.errors, required: true, rows: 4, hint: "Describe what a buyer should know: marks, noise, seam splits, stickers, how you tested it." })}
    </fieldset>
    <fieldset><legend>Photos of this actual copy</legend>
      ${o.copy.photos.length
        ? html`<div class="photo-row">${o.copy.photos.map((p: any) => html`<label class="check"><input type="checkbox" name="photo_ids" value="${p.id}"${selectedPhotos.has(String(p.id)) ? raw(" checked") : ""}> ${copyPhoto(p.id, o.copy.release_title, "sm")}</label>`)}</div>`
        : html`<p class="muted">No photos yet. <a href="/copies/${o.copy.id}">Upload photos of this copy</a> first, or list without photos.</p>`}
    </fieldset>
    <fieldset><legend>Shipping</legend>
      ${profiles.length
        ? html`${selectField({ label: "Shipping profile", name: "shipping_profile_id", value: o.values.shipping_profile_id ?? String(profiles[0].id), options: profiles.map((p) => ({ value: String(p.id), label: p.name })), errors: o.errors, required: true })}
          <ul class="small">${profiles.map((p) => html`<li>${profileSummary(p)}</li>`)}</ul>`
        : html`<p class="flash flash-error" id="f-shipping_profile_id">You need a shipping profile before listing. <a href="/selling/shipping/new">Create one</a>.</p>`}
    </fieldset>
    <div class="actions"><button class="btn btn-primary" type="submit"${!profiles.length ? raw(" disabled") : ""}>${o.submit}</button><a class="btn btn-quiet" href="/copies/${o.copy.id}">Cancel</a></div>
  </form>`;
}

export function registerSellingRoutes(app: Express, ctx: AppContext) {
  app.get("/selling", (req, res) => {
    const user = me(req);
    const listings = listSellerListings(ctx.db, user.id);
    const profiles = listShippingProfiles(ctx.db, user.id);
    page(req, res, {
      title: "Selling",
      nav: "selling",
      body: html`<h1>Selling</h1>
        <p>To sell, open a copy in <a href="/library">your library</a> and choose “Sell this copy”, or open any release and choose “Add to collection”, then “Add copy and list for sale”.</p>
        <p><a class="btn btn-quiet" href="/orders?role=seller">View simulated orders you've received</a></p>
        <h2>Your listings</h2>
        ${listings.length
          ? html`<div class="table-wrap"><table class="compact"><thead><tr><th>#</th><th>Release</th><th>Cat. no.</th><th class="num">Price</th><th>Status</th><th>Updated</th></tr></thead><tbody>
            ${listings.map((l) => html`<tr><td><a href="/selling/listings/${l.id}">#${l.id}</a></td><td><a href="/selling/listings/${l.id}">${l.title}</a></td><td><span class="catno">${l.catalog_number ?? "—"}</span></td><td class="num">${money(l.price_cents)}</td><td>${statusBadge(l.status)}</td><td class="small">${l.updated_at.slice(0, 10)}</td></tr>`)}
          </tbody></table></div>`
          : html`<div class="empty"><h2>No listings yet</h2><p>Your copies are private until you list one.</p></div>`}
        <h2>Shipping profiles</h2>
        <p class="muted small">Demo rules: each zone has a first-item and additional-item charge. Leave a zone blank if you don't ship there; buyers there will see that no total can be calculated.</p>
        ${profiles.length ? html`<ul>${profiles.map((p) => html`<li>${profileSummary(p)} — <a href="/selling/shipping/${p.id}/edit">Edit</a></li>`)}</ul>` : html`<p class="muted">None yet.</p>`}
        <p><a class="btn btn-quiet" href="/selling/shipping/new">Add shipping profile</a></p>`,
    });
  });

  // ───────── Create listing from a copy ─────────
  const renderSell = (req: Request, res: Response, copy: any, values: Record<string, any>, errors?: FieldErrors) =>
    page(req, res, {
      title: "Sell a copy",
      nav: "selling",
      body: html`<nav class="crumbs"><a href="/collection">Collection</a> / <a href="/copies/${copy.id}">Copy #${copy.id}</a> / <span>Sell</span></nav>
        <h1>Sell this copy</h1>
        <p class="panel"><strong>${copy.artist} — ${copy.release_title}</strong> · <span class="catno">${copy.catalog_number ?? "no cat. no."}</span> · ${copy.label ?? "label unknown"}<br>
          <span class="muted small">Your private grade: media ${grade(copy.media_condition)}, sleeve ${grade(copy.sleeve_condition)}</span></p>
        <p class="muted">Step 1 of 2: create a draft. You'll preview it before anything is published.</p>
        ${listingForm(req, ctx, { action: `/copies/${copy.id}/sell`, copy, values, errors, submit: "Save draft and preview" })}`,
    }, errors ? 422 : 200);

  app.get("/copies/:id/sell", (req, res) => {
    const user = me(req);
    const copy = getOwnCopy(ctx.db, user.id, idParam(req));
    if (copy.listing) {
      addFlash(req, "info", `This copy already has a ${copy.listing.status} listing. One listing per copy.`);
      return res.redirect(303, `/selling/listings/${copy.listing.id}`);
    }
    renderSell(req, res, copy, { media_condition: copy.media_condition, sleeve_condition: copy.sleeve_condition, photo_ids: copy.photos.map((p: any) => String(p.id)) });
  });

  app.post("/copies/:id/sell", (req, res) => {
    const user = me(req);
    const copy = getOwnCopy(ctx.db, user.id, idParam(req));
    try {
      const id = createDraftListing(ctx.db, ctx.clock, user.id, copy.id, req.body);
      addFlash(req, "success", "Draft saved. Check the preview, then publish.");
      res.redirect(303, `/selling/listings/${id}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderSell(req, res, copy, req.body, e.fields);
      if (e instanceof DomainError && e.status === 422) return renderSell(req, res, copy, req.body, { _form: e.message });
      throw e;
    }
  });

  // ───────── Seller's view of a listing: preview, publish, edit, withdraw ─────────
  app.get("/selling/listings/:id", (req, res) => {
    const user = me(req);
    const l = getOwnListing(ctx.db, user.id, idParam(req));
    const copy = getOwnCopy(ctx.db, user.id, l.copy_id);
    const profile = ctx.db.prepare("SELECT * FROM shipping_profiles WHERE id = ?").get(l.shipping_profile_id) as ShippingProfile;
    const sampleDest = [profile.origin_country, ...COUNTRY_CODES.filter((c) => c !== profile.origin_country)].slice(0, 13);
    const order = l.reserved_order_id ? ctx.db.prepare("SELECT id, status FROM orders WHERE id = ?").get(l.reserved_order_id) as any : null;
    page(req, res, {
      title: `Listing #${l.id}`,
      nav: "selling",
      body: html`<nav class="crumbs"><a href="/selling">Selling</a> / <span>Listing #${l.id}</span></nav>
        <h1>Listing #${l.id} ${statusBadge(l.status)}</h1>
        ${l.status === "draft" ? html`<p class="sim-notice" role="note"><strong>Preview</strong> This draft is not visible to anyone else yet. Check it, then publish.</p>` : ""}
        ${order ? html`<p>Linked simulated order: <a href="/orders/${order.id}">#${order.id}</a> (${order.status.replace(/_/g, " ")}).</p>` : ""}
        <h2>What buyers will see</h2>
        <article class="offer">
          <div class="photo-row">${l.photo_ids.length ? l.photo_ids.map((p: number) => copyPhoto(p, copy.release_title, "sm")) : html`<p class="muted small">No photos.</p>`}</div>
          <div>
            <h3>${copy.artist} — ${copy.release_title}</h3>
            <p><span class="catno">${copy.catalog_number ?? "no cat. no."}</span> · Media ${grade(l.media_condition)} · Sleeve ${grade(l.sleeve_condition)}</p>
            <p>${l.condition_description}</p>
            <p class="small">Seller: ${user.display_name}</p>
          </div>
          <div><p class="price">${money(l.price_cents)}</p><p class="estimate">+ shipping by destination</p></div>
        </article>
        <details class="panel"><summary>Shipping charges by destination (${profile.name})</summary>
          <table class="compact"><tbody>${sampleDest.map((c) => {
            const q = quoteShipping([profile], c);
            return html`<tr><td>${countryName(c)}</td><td>${q.ok ? html`${money(q.cents)} <span class="muted small">${zoneLabel(q.zone)}</span>` : html`<span class="uncertain">Not offered</span>`}</td></tr>`;
          })}</tbody></table></details>
        <p class="muted small">Not shown to buyers: your private notes, storage location, crate, tags, DJ notes and acquisition details.</p>
        <div class="action-row">
          ${l.status === "draft" ? html`<form method="post" action="/selling/listings/${l.id}/publish" class="inline">${csrf(req)}<button class="btn btn-primary" type="submit">Publish listing</button></form>` : ""}
          ${["draft", "available"].includes(l.status) ? html`<a class="btn btn-quiet" href="/selling/listings/${l.id}/edit">Edit</a>
            <form method="post" action="/selling/listings/${l.id}/withdraw" class="inline">${csrf(req)}<button class="btn btn-danger" type="submit">Withdraw</button></form>` : ""}
          ${l.status === "available" ? html`<a class="btn btn-quiet" href="/listings/${l.id}">View public page</a>` : ""}
          ${l.status === "reserved" ? html`<p class="small">Reserved in a pending simulated checkout; it can't be edited or withdrawn until the order is cancelled or expires.</p>` : ""}
          ${l.status === "withdrawn" ? html`<a class="btn" href="/copies/${l.copy_id}/sell">Create a new listing for this copy</a>` : ""}
        </div>`,
    });
  });

  const renderEdit = (req: Request, res: Response, l: any, copy: any, values: Record<string, any>, errors?: FieldErrors) =>
    page(req, res, {
      title: "Edit listing",
      nav: "selling",
      body: html`<nav class="crumbs"><a href="/selling">Selling</a> / <a href="/selling/listings/${l.id}">Listing #${l.id}</a> / <span>Edit</span></nav>
        <h1>Edit listing #${l.id}</h1>
        ${l.status === "available" ? html`<p class="muted">This listing is live. Changes apply to future orders only; existing orders keep their original details.</p>` : ""}
        ${listingForm(req, ctx, { action: `/selling/listings/${l.id}/edit`, copy, values, errors, submit: "Save changes" })}`,
    }, errors ? 422 : 200);

  app.get("/selling/listings/:id/edit", (req, res) => {
    const user = me(req);
    const l = getOwnListing(ctx.db, user.id, idParam(req));
    if (!["draft", "available"].includes(l.status)) throw new DomainError(`A ${l.status} listing can't be edited.`);
    renderEdit(req, res, l, getOwnCopy(ctx.db, user.id, l.copy_id), {
      price: centsToInput(l.price_cents), media_condition: l.media_condition, sleeve_condition: l.sleeve_condition,
      condition_description: l.condition_description, shipping_profile_id: String(l.shipping_profile_id), photo_ids: l.photo_ids.map(String),
    });
  });

  app.post("/selling/listings/:id/edit", (req, res) => {
    const user = me(req);
    const l = getOwnListing(ctx.db, user.id, idParam(req));
    try {
      updateListing(ctx.db, ctx.clock, user.id, l.id, req.body);
      addFlash(req, "success", "Listing updated.");
      res.redirect(303, `/selling/listings/${l.id}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderEdit(req, res, l, getOwnCopy(ctx.db, user.id, l.copy_id), req.body, e.fields);
      throw e;
    }
  });

  app.post("/selling/listings/:id/publish", (req, res) => {
    const user = me(req);
    publishListing(ctx.db, ctx.clock, user.id, idParam(req));
    addFlash(req, "success", "Published. Buyers can now find this copy.");
    res.redirect(303, `/selling/listings/${req.params.id}`);
  });

  app.post("/selling/listings/:id/withdraw", (req, res) => {
    const user = me(req);
    withdrawListing(ctx.db, ctx.clock, user.id, idParam(req));
    addFlash(req, "success", "Listing withdrawn. The copy stays in your collection.");
    res.redirect(303, `/selling/listings/${req.params.id}`);
  });

  // ───────── Shipping profiles ─────────
  const shippingForm = (req: Request, res: Response, action: string, values: Record<string, any>, errors?: FieldErrors) => {
    const rate = (name: string, label: string) => textField({ label, name, value: values[name], inputmode: "decimal", errors, placeholder: "blank = not offered" });
    page(req, res, {
      title: "Shipping profile",
      nav: "selling",
      body: html`<h1>Shipping profile</h1>
        <form method="post" action="${action}" class="form-narrow" novalidate>${csrf(req)}${errorSummary(errors)}
          ${textField({ label: "Name", name: "name", value: values.name, errors, required: true, placeholder: "Standard mailer" })}
          ${selectField({ label: "Ships from", name: "origin_country", value: values.origin_country ?? me(req).country, options: COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) })), errors, required: true })}
          <fieldset><legend>Domestic (same country)</legend><div class="grid-2">${rate("domestic_first", "First item")}${rate("domestic_additional", "Each additional")}</div></fieldset>
          <fieldset><legend>Same region (e.g. within Europe)</legend><div class="grid-2">${rate("region_first", "First item")}${rate("region_additional", "Each additional")}</div></fieldset>
          <fieldset><legend>International (everywhere else)</legend><div class="grid-2">${rate("world_first", "First item")}${rate("world_additional", "Each additional")}</div></fieldset>
          <div class="actions"><button class="btn btn-primary" type="submit">Save profile</button><a class="btn btn-quiet" href="/selling">Cancel</a></div>
        </form>`,
    }, errors ? 422 : 200);
  };

  app.get("/selling/shipping/new", (req, res) => shippingForm(req, res, "/selling/shipping/new", {}));
  app.post("/selling/shipping/new", (req, res) => {
    const user = me(req);
    try {
      saveShippingProfile(ctx.db, ctx.clock, user.id, req.body);
      addFlash(req, "success", "Shipping profile saved.");
      res.redirect(303, "/selling");
    } catch (e) {
      if (e instanceof ValidationError) return shippingForm(req, res, "/selling/shipping/new", req.body, e.fields);
      throw e;
    }
  });
  app.get("/selling/shipping/:id/edit", (req, res) => {
    const user = me(req);
    const p = listShippingProfiles(ctx.db, user.id).find((x) => x.id === idParam(req));
    if (!p) throw new DomainError("Shipping profile not found.", 404);
    const v: Record<string, any> = { name: p.name, origin_country: p.origin_country };
    for (const k of ["domestic_first", "domestic_additional", "region_first", "region_additional", "world_first", "world_additional"] as const) v[k] = centsToInput(p[k]);
    shippingForm(req, res, `/selling/shipping/${p.id}/edit`, v);
  });
  app.post("/selling/shipping/:id/edit", (req, res) => {
    const user = me(req);
    try {
      saveShippingProfile(ctx.db, ctx.clock, user.id, req.body, idParam(req));
      addFlash(req, "success", "Shipping profile saved. Existing orders keep the charges they were placed with.");
      res.redirect(303, "/selling");
    } catch (e) {
      if (e instanceof ValidationError) return shippingForm(req, res, `/selling/shipping/${req.params.id}/edit`, req.body, e.fields);
      throw e;
    }
  });
}
