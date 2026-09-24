import type { Express, Request } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { DomainError, notFound } from "../lib/errors.js";
import { html, raw } from "../lib/html.js";
import { centsToInput } from "../lib/money.js";
import { countryName, MEDIA_CONDITIONS, SLEEVE_CONDITIONS } from "../lib/reference.js";
import { saveImages } from "../lib/uploads.js";
import { ValidationError, type FieldErrors } from "../lib/validation.js";
import { getEditionSummary, artistCredit } from "../domain/catalog.js";
import {
  addCopyPhoto, applyBulkAction, bulkRequestFromBody, COLLECTION_PAGE_SIZE, createCopy, createCrate, deleteCopyPhoto, describeBulkAction,
  getOwnCopy, listCopies, listCrates, listTags, parseBulkAction, parseCollectionFilters, resolveBulkScope, SUGGESTED_DJ_TAGS, updateCopy,
  type CollectionFilters,
} from "../domain/collection.js";
import { copyPhoto, cover, csrf, errorSummary, grade, money, pagination, selectField, statusBadge, textArea, textField } from "../views/components.js";
import { idParam, me, page } from "./helpers.js";

function filterQuery(f: CollectionFilters, overrides: Partial<Record<keyof CollectionFilters | "page", string>> = {}) {
  const q = new URLSearchParams();
  const all = { ...f, ...overrides };
  for (const [k, v] of Object.entries(all)) if (v) q.set(k, String(v));
  return q;
}

function describeFilters(db: AppContext["db"], f: CollectionFilters): string {
  const parts: string[] = [];
  if (f.q) parts.push(`search “${f.q}”`);
  if (f.crate === "none") parts.push("not in a crate");
  else if (f.crate) parts.push(`crate “${(db.prepare("SELECT name FROM crates WHERE id = ?").get(Number(f.crate)) as any)?.name ?? "?"}”`);
  if (f.tag) parts.push(`tag “${f.tag}”`);
  if (f.status) parts.push(`status: ${f.status}`);
  return parts.length ? parts.join(", ") : "no filters (your whole collection)";
}

function copyForm(req: Request, ctx: AppContext, o: { action: string; values: Record<string, any>; errors?: FieldErrors; submit: string; editionId?: number; allowSellNext?: boolean }) {
  const user = me(req);
  const crates = listCrates(ctx.db, user.id);
  const tags = listTags(ctx.db, user.id);
  const v = o.values;
  const conditionOpts = (list: readonly { code: string; label: string }[]) => list.map((c) => ({ value: c.code, label: c.label }));
  return html`<form method="post" action="${o.action}" class="form-narrow" novalidate>
    ${csrf(req)}
    ${errorSummary(o.errors)}
    ${o.editionId ? html`<input type="hidden" name="edition_id" value="${o.editionId}">` : ""}
    <fieldset><legend>Condition of this copy</legend>
      <p class="hint">Media and sleeve are graded separately. You can set different public grades on a listing later.</p>
      <div class="grid-2">
        ${selectField({ label: "Media condition", name: "media_condition", value: v.media_condition, options: conditionOpts(MEDIA_CONDITIONS), blank: "Choose…", errors: o.errors, required: true })}
        ${selectField({ label: "Sleeve condition", name: "sleeve_condition", value: v.sleeve_condition, options: conditionOpts(SLEEVE_CONDITIONS), blank: "Choose…", errors: o.errors, required: true })}
      </div>
    </fieldset>
    <fieldset><legend>Organize <span class="private-label">Private</span></legend>
      <p class="hint">Crates, tags and DJ notes are personal. They are never shown to other people or added to the archive.</p>
      ${selectField({ label: "Crate", name: "crate_id", value: v.crate_id ?? "", options: crates.map((c) => ({ value: String(c.id), label: c.name })), blank: "No crate", errors: o.errors, hint: html`Create crates from <a href="/collection">your collection page</a>.` })}
      ${textField({ label: "Personal tags", name: "tags", value: v.tags, errors: o.errors, hint: `Comma-separated. Suggestions: ${SUGGESTED_DJ_TAGS.join(", ")}${tags.length ? `. Yours: ${tags.map((t) => t.name).join(", ")}` : ""}` })}
      <div class="grid-2">
        ${selectField({ label: "Energy", name: "dj_energy", value: v.dj_energy ?? "", options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} — ${["low", "gentle", "mid", "high", "peak"][n - 1]}` })), blank: "Not set", errors: o.errors })}
        ${textField({ label: "BPM notes", name: "dj_bpm_notes", value: v.dj_bpm_notes, errors: o.errors, placeholder: "A1 122, B2 ~126 pitched" })}
      </div>
      ${textField({ label: "Storage location", name: "storage_location", value: v.storage_location, errors: o.errors, placeholder: "Shelf 3, box B" })}
      ${textArea({ label: "Private notes", name: "private_notes", value: v.private_notes, errors: o.errors, rows: 3 })}
    </fieldset>
    <fieldset><legend>Acquisition <span class="private-label">Private</span></legend>
      <div class="grid-3">
        ${textField({ label: "Acquired on", name: "acquired_on", type: "date", value: v.acquired_on, errors: o.errors })}
        ${textField({ label: "Acquired from", name: "acquired_from", value: v.acquired_from, errors: o.errors })}
        ${textField({ label: "Cost (USD)", name: "acquisition_cost", value: v.acquisition_cost, errors: o.errors, inputmode: "decimal", placeholder: "12.00" })}
      </div>
    </fieldset>
    <div class="actions">
      <button class="btn btn-primary" type="submit" name="next" value="view">${o.submit}</button>
      ${o.allowSellNext ? html`<button class="btn" type="submit" name="next" value="sell">${o.submit} and list for sale</button>` : ""}
      <a class="btn btn-quiet" href="/collection">Cancel</a>
    </div>
  </form>`;
}

export function registerCollectionRoutes(app: Express, ctx: AppContext) {
  // ───────── Collection list with filters + bulk selection ─────────
  app.get("/collection", (req, res) => {
    const user = me(req);
    const f = parseCollectionFilters(req.query);
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const { total, rows } = listCopies(ctx.db, user.id, f, pageNo);
    const crates = listCrates(ctx.db, user.id);
    const tags = listTags(ctx.db, user.id);
    const grand = (ctx.db.prepare("SELECT COUNT(*) AS n FROM copies WHERE owner_id = ?").get(user.id) as { n: number }).n;
    const link = (overrides: Partial<Record<keyof CollectionFilters, string>>) => `/collection?${filterQuery(f, overrides)}`;
    const cur = (k: keyof CollectionFilters, v: string) => (f[k] === v ? raw(' aria-current="true"') : "");
    const filtered = !!(f.q || f.crate || f.tag || f.status);

    page(req, res, {
      title: "My collection",
      nav: "collection",
      wide: true,
      body: html`
        <h1>My collection <span class="muted small">${grand} cop${grand === 1 ? "y" : "ies"} · private to you</span></h1>
        <div class="sidebar-layout">
          <nav class="sidenav" aria-label="Collection filters">
            <h3>Status</h3>
            <a href="${link({ status: "" })}"${cur("status", "")}>All</a>
            <a href="${link({ status: "private" })}"${cur("status", "private")}>Private (not listed)</a>
            <a href="${link({ status: "listed" })}"${cur("status", "listed")}>Listed / reserved</a>
            <a href="${link({ status: "sold" })}"${cur("status", "sold")}>Sold</a>
            <h3>Crates</h3>
            <a href="${link({ crate: "" })}"${cur("crate", "")}>Any crate</a>
            ${crates.map((c) => html`<a href="${link({ crate: String(c.id) })}"${cur("crate", String(c.id))}>${c.name} <span>${c.n}</span></a>`)}
            <a href="${link({ crate: "none" })}"${cur("crate", "none")}>Not in a crate</a>
            <form method="post" action="/crates" class="field">${csrf(req)}
              <label for="f-crate-name" class="small">New crate</label>
              <div class="searchbar"><input id="f-crate-name" name="name" maxlength="60" placeholder="e.g. Sunday closing"><button class="btn btn-sm" type="submit">Add</button></div>
            </form>
            <h3>Personal tags</h3>
            ${f.tag ? html`<a href="${link({ tag: "" })}">Any tag</a>` : ""}
            ${tags.length ? tags.map((t) => html`<a href="${link({ tag: t.name })}"${cur("tag", t.name)}><span class="tag">${t.name}</span> <span>${t.n}</span></a>`) : html`<p class="muted small">No tags yet.</p>`}
          </nav>
          <section>
            <form method="get" action="/collection" class="searchbar" role="search">
              ${f.crate ? html`<input type="hidden" name="crate" value="${f.crate}">` : ""}${f.tag ? html`<input type="hidden" name="tag" value="${f.tag}">` : ""}${f.status ? html`<input type="hidden" name="status" value="${f.status}">` : ""}
              <label for="f-cq" class="sr-only">Search your collection</label>
              <input id="f-cq" type="search" name="q" value="${f.q}" placeholder="Search your copies, including private notes and locations">
              <button class="btn" type="submit">Search</button>
            </form>
            <p><strong>${total}</strong> cop${total === 1 ? "y" : "ies"} match: ${describeFilters(ctx.db, f)}. ${filtered ? html`<a href="/collection">Clear filters</a>` : ""}</p>
            ${rows.length
              ? html`<div class="table-wrap"><table class="compact">
                  <thead><tr>
                    <th><label class="check"><input type="checkbox" id="select-page" aria-label="Select all ${rows.length} on this page"><span class="sr-only">Select page</span></label></th>
                    <th><span class="sr-only">Artwork</span></th><th>Release</th><th>Cat. no.</th><th>Grade</th><th class="hide-sm">Crate / tags</th><th class="hide-sm">Location</th><th>Status</th>
                  </tr></thead>
                  <tbody>${rows.map((c) => html`<tr>
                    <td><label class="check"><input type="checkbox" name="ids" value="${c.id}" form="bulk-form"><span class="sr-only">Select ${c.release_title}</span></label></td>
                    <td>${cover(c.image_id, c.release_title, { size: "sm" })}</td>
                    <td><a href="/copies/${c.id}"><strong>${c.artist}</strong> — ${c.release_title}</a><br><span class="muted small">${c.label ?? "label ?"} · ${c.format} ${c.format_details ?? ""} · ${countryName(c.country)} · ${c.release_year ?? "?"}</span></td>
                    <td><span class="catno">${c.catalog_number ?? "—"}</span></td>
                    <td class="nowrap">${grade(c.media_condition)} / ${grade(c.sleeve_condition)}</td>
                    <td class="hide-sm">${c.crate_name ? html`<strong>${c.crate_name}</strong><br>` : ""}${c.tags.map((t: string) => html`<span class="tag">${t}</span>`)}${c.dj_energy ? html`<span class="muted small">energy ${c.dj_energy}</span>` : ""}</td>
                    <td class="hide-sm small">${c.storage_location ?? ""}</td>
                    <td>${c.listing_status ? statusBadge(c.listing_status) : html`<span class="muted small">Private</span>`}</td>
                  </tr>`)}</tbody></table></div>
                ${pagination("/collection", filterQuery(f), pageNo, total, COLLECTION_PAGE_SIZE)}
                <form method="post" action="/collection/bulk/preview" id="bulk-form" class="bulkbar" aria-label="Bulk actions">
                  ${csrf(req)}
                  ${rows.map((c) => html`<input type="hidden" name="page_ids" value="${c.id}">`)}
                  <input type="hidden" name="f_q" value="${f.q}"><input type="hidden" name="f_crate" value="${f.crate}"><input type="hidden" name="f_tag" value="${f.tag}"><input type="hidden" name="f_status" value="${f.status}">
                  <fieldset class="scope"><legend class="sr-only">Apply to</legend>
                    <label class="check"><input type="radio" name="scope" value="selected" id="scope-selected" checked> <span>Selected (<span id="selected-count">0</span>)</span></label>
                    <label class="check"><input type="radio" name="scope" value="page" id="scope-page"> <span>This page (${rows.length})</span></label>
                    <label class="check"><input type="radio" name="scope" value="all_matching"> <span>All ${total} matching</span></label>
                  </fieldset>
                  <label for="f-action" class="sr-only">Action</label>
                  <select id="f-action" name="action"><option value="add_tag">Add tag…</option><option value="remove_tag">Remove tag…</option><option value="move_crate">Move to crate…</option></select>
                  <label for="f-btag" class="sr-only">Tag</label><input id="f-btag" type="text" name="tag" placeholder="tag (for tag actions)" list="tag-suggestions">
                  <datalist id="tag-suggestions">${[...new Set([...tags.map((t) => t.name), ...SUGGESTED_DJ_TAGS])].map((t) => html`<option value="${t}">`)}</datalist>
                  <label for="f-bcrate" class="sr-only">Crate</label>
                  <select id="f-bcrate" name="crate_id"><option value="">crate (for move)</option><option value="none">No crate</option>${crates.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
                  <button class="btn btn-primary btn-sm" type="submit">Review change…</button>
                </form>`
              : grand === 0
                ? html`<div class="empty"><h2>Your collection is empty</h2><p>Find a release in <a href="/">Discover</a>, open the edition you own and choose “Add to collection”.</p></div>`
                : html`<div class="empty"><h2>No copies match these filters</h2><p><a class="btn btn-quiet" href="/collection">Clear filters</a></p></div>`}
          </section>
        </div>`,
    });
  });

  app.post("/crates", (req, res) => {
    const user = me(req);
    try {
      createCrate(ctx.db, ctx.clock, user.id, req.body.name);
      addFlash(req, "success", "Crate created.");
    } catch (e) {
      if (e instanceof ValidationError || e instanceof DomainError) addFlash(req, "error", e instanceof ValidationError ? Object.values(e.fields)[0] : e.message);
      else throw e;
    }
    res.redirect(303, "/collection");
  });

  // ───────── Bulk: preview (explicit scope + count) then apply ─────────
  app.post("/collection/bulk/preview", (req, res) => {
    const user = me(req);
    const bulk = bulkRequestFromBody(req.body);
    const action = parseBulkAction(req.body);
    const ids = resolveBulkScope(ctx.db, user.id, bulk);
    const back = `/collection?${filterQuery(bulk.filters)}`;
    if (!ids.length) {
      addFlash(req, "error", bulk.scope === "selected" ? "Select at least one copy, or choose “This page” / “All matching”." : "No copies are in that scope.");
      return res.redirect(303, back);
    }
    const scopeText =
      bulk.scope === "all_matching" ? `all ${ids.length} copies matching ${describeFilters(ctx.db, bulk.filters)}` : bulk.scope === "page" ? `the ${ids.length} copies on the page you were viewing` : `${ids.length} individually selected cop${ids.length === 1 ? "y" : "ies"}`;
    const sample = ctx.db
      .prepare(`SELECT c.id, r.title, e.catalog_number FROM copies c JOIN editions e ON e.id = c.edition_id JOIN releases r ON r.id = e.release_id WHERE c.id IN (${ids.map(() => "?").join(",")}) ORDER BY r.title LIMIT 12`)
      .all(...ids) as any[];
    page(req, res, {
      title: "Confirm bulk change",
      nav: "collection",
      body: html`<div class="confirm-box form-narrow">
        <h1>Confirm bulk change</h1>
        <p class="lead"><strong>${describeBulkAction(ctx.db, action)}</strong></p>
        <p>Applies to <strong>${scopeText}</strong>.</p>
        <ul class="small">${sample.map((s) => html`<li>${s.title} <span class="catno">${s.catalog_number ?? ""}</span></li>`)}${ids.length > sample.length ? html`<li>…and ${ids.length - sample.length} more</li>` : ""}</ul>
        <form method="post" action="/collection/bulk/apply">
          ${csrf(req)}
          ${ids.map((id) => html`<input type="hidden" name="ids" value="${id}">`)}
          <input type="hidden" name="expected_count" value="${ids.length}">
          <input type="hidden" name="action" value="${action.kind}">
          ${action.kind !== "move_crate" ? html`<input type="hidden" name="tag" value="${action.tag}">` : html`<input type="hidden" name="crate_id" value="${action.crateId ?? "none"}">`}
          <input type="hidden" name="return_to" value="${back}">
          <div class="actions"><button class="btn btn-primary" type="submit">Apply to ${ids.length} cop${ids.length === 1 ? "y" : "ies"}</button><a class="btn btn-quiet" href="${back}">Cancel</a></div>
        </form></div>`,
    });
  });

  app.post("/collection/bulk/apply", (req, res) => {
    const user = me(req);
    const bulk = bulkRequestFromBody({ ...req.body, scope: "selected" });
    const action = parseBulkAction(req.body);
    const ids = resolveBulkScope(ctx.db, user.id, bulk);
    const back = typeof req.body.return_to === "string" && req.body.return_to.startsWith("/collection") ? req.body.return_to : "/collection";
    if (ids.length !== Number(req.body.expected_count)) {
      addFlash(req, "error", "Your collection changed since you reviewed this. Nothing was applied; please review again.");
      return res.redirect(303, back);
    }
    const changed = applyBulkAction(ctx.db, ctx.clock, user.id, ids, action);
    addFlash(req, "success", `${describeBulkAction(ctx.db, action)}: ${changed} of ${ids.length} copies changed${changed < ids.length ? " (the rest already matched)" : ""}.`);
    res.redirect(303, back);
  });

  // ───────── Add / edit copies ─────────
  app.get("/collection/add", (req, res) => {
    me(req);
    const editionId = Number(req.query.edition_id);
    const e = getEditionSummary(ctx.db, editionId);
    if (!e) {
      return page(req, res, { title: "Add a copy", nav: "collection", body: html`<div class="empty"><h1>Choose an edition first</h1><p>Search <a href="/">Discover</a>, open the edition you own and choose “Add to collection”. Copies always belong to a specific edition.</p></div>` });
    }
    renderAdd(req, res, e.id, { media_condition: "", sleeve_condition: "" });
  });

  function renderAdd(req: Request, res: any, editionId: number, values: Record<string, any>, errors?: FieldErrors) {
    const e = getEditionSummary(ctx.db, editionId)!;
    const title = (ctx.db.prepare("SELECT title FROM releases WHERE id = ?").get(e.release_id) as any).title;
    page(req, res, {
      title: "Add a copy",
      nav: "collection",
      body: html`<h1>Add a copy to your collection</h1>
        <p class="panel"><strong>${artistCredit(ctx.db, e.release_id)} — ${title}</strong><br><span class="catno">${e.catalog_number ?? "no cat. no."}</span> · ${e.label ?? "label unknown"} · ${e.format} ${e.format_details ?? ""} · ${countryName(e.country)} · ${e.release_year ?? "year unknown"}
        <br><a class="small" href="/editions/${e.id}">Not this edition? Check the edition details</a></p>
        <p class="muted">Your copy is <strong>private</strong> and <strong>not for sale</strong> unless you create a listing.</p>
        ${copyForm(req, ctx, { action: "/collection/add", values, errors, submit: "Add copy", editionId: e.id, allowSellNext: true })}`,
    }, errors ? 422 : 200);
  }

  app.post("/collection/add", (req, res) => {
    const user = me(req);
    const editionId = Number(req.body.edition_id);
    if (!getEditionSummary(ctx.db, editionId)) throw notFound("Edition");
    try {
      const id = createCopy(ctx.db, ctx.clock, user.id, editionId, req.body);
      addFlash(req, "success", "Copy added to your collection (private).");
      res.redirect(303, req.body.next === "sell" ? `/copies/${id}/sell` : `/copies/${id}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderAdd(req, res, editionId, req.body, e.fields);
      if (e instanceof DomainError) return renderAdd(req, res, editionId, req.body, { crate_id: e.message });
      throw e;
    }
  });

  app.get("/copies/:id", (req, res) => {
    const user = me(req);
    const c = getOwnCopy(ctx.db, user.id, idParam(req));
    page(req, res, {
      title: `My copy · ${c.release_title}`,
      nav: "collection",
      body: html`
        <nav class="crumbs"><a href="/collection">My collection</a> / <span>Copy #${c.id}</span></nav>
        <h1>${c.artist} — ${c.release_title}</h1>
        <p><a href="/editions/${c.edition_id}">Edition <span class="catno">${c.catalog_number ?? "no cat. no."}</span></a> · ${c.label ?? "label unknown"} · ${c.format} ${c.format_details ?? ""} · ${countryName(c.country)} · ${c.release_year ?? "?"}</p>
        <div class="detail">
          <div>
            <h2>Photos of this copy</h2>
            <p class="muted small">Actual-copy photos are private until you attach them to a published listing.</p>
            <div class="photo-row">${c.photos.map((p: any) => html`<div>${copyPhoto(p.id, c.release_title, "sm")}<form method="post" action="/copy-photos/${p.id}/delete">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit">Remove</button></form></div>`)}</div>
            <form method="post" action="/copies/${c.id}/photos" enctype="multipart/form-data" class="panel">
              ${csrf(req)}
              <div class="field"><label for="f-images">Add photos (JPEG, PNG or WebP, up to 5 MB each)</label><input id="f-images" type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></div>
              <button class="btn btn-sm" type="submit">Upload</button>
            </form>
          </div>
          <div>
            <div class="panel">
              <h2>Condition</h2>
              <p>Media ${grade(c.media_condition)} · Sleeve ${grade(c.sleeve_condition)}</p>
            </div>
            <div class="panel private-note">
              <p class="private-label">Private — only you can see this</p>
              <dl class="facts">
                <dt>Crate</dt><dd>${c.crate_name ?? "—"}</dd>
                <dt>Tags</dt><dd>${c.tags.length ? c.tags.map((t: string) => html`<span class="tag">${t}</span>`) : "—"}</dd>
                <dt>Energy</dt><dd>${c.dj_energy ?? "—"}</dd>
                <dt>BPM notes</dt><dd>${c.dj_bpm_notes ?? "—"}</dd>
                <dt>Location</dt><dd>${c.storage_location ?? "—"}</dd>
                <dt>Notes</dt><dd>${c.private_notes ?? "—"}</dd>
                <dt>Acquired</dt><dd>${[c.acquired_on, c.acquired_from].filter(Boolean).join(" · ") || "—"}${c.acquisition_cost_cents != null ? html` · ${money(c.acquisition_cost_cents)}` : ""}</dd>
              </dl>
            </div>
            <div class="action-row">
              <a class="btn btn-quiet" href="/copies/${c.id}/edit">Edit copy</a>
              ${c.listing
                ? html`<a class="btn" href="/selling/listings/${c.listing.id}">Listing #${c.listing.id}: ${statusBadge(c.listing.status)}</a>`
                : html`<a class="btn btn-primary" href="/copies/${c.id}/sell">Sell this copy</a>`}
            </div>
          </div>
        </div>`,
    });
  });

  const copyValues = (c: any) => ({
    ...c,
    tags: c.tags.join(", "),
    acquisition_cost: centsToInput(c.acquisition_cost_cents),
    crate_id: c.crate_id ? String(c.crate_id) : "",
    dj_energy: c.dj_energy ? String(c.dj_energy) : "",
  });

  app.get("/copies/:id/edit", (req, res) => {
    const user = me(req);
    const c = getOwnCopy(ctx.db, user.id, idParam(req));
    page(req, res, { title: "Edit copy", nav: "collection", body: html`<h1>Edit copy · ${c.release_title}</h1>${copyForm(req, ctx, { action: `/copies/${c.id}/edit`, values: copyValues(c), submit: "Save copy" })}` });
  });

  app.post("/copies/:id/edit", (req, res) => {
    const user = me(req);
    const id = idParam(req);
    const c = getOwnCopy(ctx.db, user.id, id);
    try {
      updateCopy(ctx.db, ctx.clock, user.id, id, req.body);
      addFlash(req, "success", "Copy saved.");
      res.redirect(303, `/copies/${id}`);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      page(req, res, { title: "Edit copy", nav: "collection", body: html`<h1>Edit copy · ${c.release_title}</h1>${copyForm(req, ctx, { action: `/copies/${id}/edit`, values: req.body, errors: e.fields, submit: "Save copy" })}` }, 422);
    }
  });

  app.post("/copies/:id/photos", (req, res) => {
    const user = me(req);
    const id = idParam(req);
    getOwnCopy(ctx.db, user.id, id);
    const paths = saveImages(ctx.config.uploadDir, "copies", req.files as Express.Multer.File[]);
    if (!paths.length) throw new DomainError("Choose at least one image to upload.", 422);
    for (const p of paths) addCopyPhoto(ctx.db, ctx.clock, user.id, id, { storage_path: p });
    addFlash(req, "success", `${paths.length} photo${paths.length === 1 ? "" : "s"} added (private until used in a listing).`);
    res.redirect(303, req.body.return_to === "sell" ? `/copies/${id}/sell` : `/copies/${id}`);
  });

  app.post("/copy-photos/:id/delete", (req, res) => {
    const user = me(req);
    const photo = ctx.db.prepare("SELECT copy_id FROM copy_photos WHERE id = ?").get(idParam(req)) as any;
    deleteCopyPhoto(ctx.db, ctx.clock, user.id, idParam(req));
    addFlash(req, "success", "Photo removed.");
    res.redirect(303, `/copies/${photo.copy_id}`);
  });
}
