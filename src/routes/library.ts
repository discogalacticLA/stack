import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { DomainError } from "../lib/errors.js";
import { html, raw, type SafeHtml } from "../lib/html.js";
import { centsToInput } from "../lib/money.js";
import { countryName, MEDIA_CONDITIONS, SLEEVE_CONDITIONS } from "../lib/reference.js";
import { saveImages } from "../lib/uploads.js";
import { ValidationError, type FieldErrors } from "../lib/validation.js";
import { artistCredit, getEditionSummary } from "../domain/catalog.js";
import {
  addCopyPhoto, addToCrate, applyBulkAction, bulkRequestFromBody, createCopy, createDigital, createManualCopy, deleteCopyPhoto, describeBulkAction,
  filterQuery, FORMAT_GROUPS, getOwnCopy, getOwnDigital, getPref, GROUP_LABELS, groupCounts, libraryCounts, libraryFacets, linkCopyToEdition,
  listCrates, listLibrary, listTags, parseBulkAction, parseLibraryFilters, parseRef, parseRefs, refKey, relatedHoldings, removeFromCrate,
  resolveBulkScope, setPref, SORT_LABELS, SUGGESTED_TAGS, updateCopy, updateDigital, type ItemRef, type LibraryFilters, type LibraryGroup, type LibrarySort,
} from "../domain/library.js";
import { addManualWant, addWant, listWants, removeWant, updateWantNote, WANT_KIND_LABELS } from "../domain/wants.js";
import { copyPhoto, cover, csrf, errorSummary, grade, money, pagination, selectField, statusBadge, textArea, textField } from "../views/components.js";
import { idParam, me, page } from "./helpers.js";

interface ViewPrefs { view: "grid" | "table"; sort: LibrarySort; dir: "asc" | "desc"; group: LibraryGroup }
const DEFAULT_PREFS: ViewPrefs = { view: "grid", sort: "artist", dir: "asc", group: "" };

export const itemHref = (r: { item_type: string; item_id: number }) => (r.item_type === "physical" ? `/copies/${r.item_id}` : `/digital/${r.item_id}`);

/** Artwork only when it legitimately exists (archive image of a linked edition); otherwise an honest placeholder. */
export function itemArt(r: any, size: "sm" | "md" = "md") {
  if (r.image_id) return cover(r.image_id, `${r.artist} – ${r.title}`, { size });
  return html`<div class="cover cover-${size} cover-missing" role="img" aria-label="No artwork for ${r.title}"><span>${r.format_group === "Digital" ? "Digital" : r.format_group ?? ""}<br>no artwork</span></div>`;
}

export const bpm = (x100: number | null | undefined) => (x100 == null ? "" : (x100 / 100).toFixed(x100 % 100 ? 1 : 0));

function typeBadge(r: any) {
  return r.item_type === "digital" ? html`<span class="badge kind-digital">Digital${r.version ? html` · ${r.version}` : ""}</span>` : html`<span class="badge kind-physical">${r.format_group}</span>`;
}

function itemLine(r: any): SafeHtml {
  return html`${r.label ?? ""}${r.catno ? html` · <span class="catno">${r.catno}</span>` : ""}${r.year ? ` · ${r.year}` : ""}`;
}

const conditionOpts = (list: readonly { code: string; label: string }[]) => list.map((c) => ({ value: c.code, label: c.label }));

function physicalForm(req: Request, ctx: AppContext, o: { action: string; values: Record<string, any>; errors?: FieldErrors; submit: string; editionId?: number; descriptive: boolean; allowSellNext?: boolean }) {
  const user = me(req);
  const crates = listCrates(ctx.db, user.id);
  const tags = listTags(ctx.db, user.id);
  const v = o.values;
  return html`<form method="post" action="${o.action}" class="form-narrow" novalidate>
    ${csrf(req)}${errorSummary(o.errors)}
    ${o.editionId ? html`<input type="hidden" name="edition_id" value="${o.editionId}">` : ""}
    ${o.descriptive ? html`<fieldset><legend>What is it? <span class="private-label">Private</span></legend>
        <p class="hint">Only you see these details. They don't create or change any archive entry.</p>
        <div class="grid-2">
          ${textField({ label: "Artist", name: "artist_text", value: v.artist_text, errors: o.errors, required: true })}
          ${textField({ label: "Title", name: "title_text", value: v.title_text, errors: o.errors, required: true })}
          ${textField({ label: "Label", name: "label_text", value: v.label_text, errors: o.errors })}
          ${textField({ label: "Catalog number", name: "catno_text", value: v.catno_text, errors: o.errors })}
          ${selectField({ label: "Format", name: "format_group", value: v.format_group, options: FORMAT_GROUPS.filter((f) => f !== "Digital").map((f) => ({ value: f, label: f })), blank: "Choose…", errors: o.errors, required: true })}
          ${textField({ label: "Format details", name: "format_raw", value: v.format_raw, errors: o.errors, placeholder: '12", 45 RPM, white label' })}
          ${textField({ label: "Year", name: "release_year", value: v.release_year, errors: o.errors, inputmode: "numeric" })}
          ${textField({ label: "Genre (your own label)", name: "genre_text", value: v.genre_text, errors: o.errors })}
        </div></fieldset>` : ""}
    <fieldset><legend>Condition of this copy</legend>
      <div class="grid-2">
        ${selectField({ label: "Media condition", name: "media_condition", value: v.media_condition, options: conditionOpts(MEDIA_CONDITIONS), blank: "Choose…", errors: o.errors, required: true })}
        ${selectField({ label: "Sleeve condition", name: "sleeve_condition", value: v.sleeve_condition, options: conditionOpts(SLEEVE_CONDITIONS), blank: "Choose…", errors: o.errors, required: true })}
      </div>
    </fieldset>
    <fieldset><legend>Organize <span class="private-label">Private</span></legend>
      <p class="hint">Tags, crates and DJ notes are personal. They never change shared archive genres or styles.</p>
      ${o.editionId || o.descriptive ? selectField({ label: "Add to crate", name: "crate_id", value: v.crate_id ?? "", options: crates.map((c) => ({ value: String(c.id), label: c.name })), blank: "No crate", errors: o.errors }) : ""}
      ${textField({ label: "Personal tags", name: "tags", value: v.tags, errors: o.errors, hint: `Comma-separated. Ideas: ${SUGGESTED_TAGS.join(", ")}${tags.length ? `. Yours: ${tags.map((t) => t.name).join(", ")}` : ""}` })}
      <div class="grid-2">
        ${selectField({ label: "Energy", name: "dj_energy", value: v.dj_energy ?? "", options: [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} — ${["low", "gentle", "mid", "high", "peak"][n - 1]}` })), blank: "Not set", errors: o.errors })}
        ${textField({ label: "BPM notes", name: "dj_bpm_notes", value: v.dj_bpm_notes, errors: o.errors, placeholder: "A1 122, B2 ~126" })}
      </div>
      ${textField({ label: "Storage location", name: "storage_location", value: v.storage_location, errors: o.errors, placeholder: "Shelf 3, box B" })}
      ${textArea({ label: "Private notes", name: "private_notes", value: v.private_notes, errors: o.errors, rows: 3 })}
    </fieldset>
    <fieldset><legend>Acquisition <span class="private-label">Private</span></legend>
      <div class="grid-3">
        ${textField({ label: "Acquired on", name: "acquired_on", type: "date", value: v.acquired_on, errors: o.errors })}
        ${textField({ label: "Acquired from", name: "acquired_from", value: v.acquired_from, errors: o.errors })}
        ${textField({ label: "Cost (USD)", name: "acquisition_cost", value: v.acquisition_cost, errors: o.errors, inputmode: "decimal" })}
      </div>
    </fieldset>
    <div class="actions">
      <button class="btn btn-primary" type="submit" name="next" value="view">${o.submit}</button>
      ${o.allowSellNext ? html`<button class="btn" type="submit" name="next" value="sell">${o.submit} and list for sale</button>` : ""}
      <a class="btn btn-quiet" href="/library">Cancel</a>
    </div>
  </form>`;
}

function digitalForm(req: Request, ctx: AppContext, o: { action: string; values: Record<string, any>; errors?: FieldErrors; submit: string }) {
  const user = me(req);
  const v = o.values;
  const copies = ctx.db.prepare("SELECT item_id, artist, title, format_raw FROM library_items WHERE owner_id = ? AND item_type = 'physical' ORDER BY artist, title LIMIT 500").all(user.id) as any[];
  return html`<form method="post" action="${o.action}" class="form-narrow" novalidate>
    ${csrf(req)}${errorSummary(o.errors)}
    <p class="muted small">No audio is uploaded. Nothing here is taken as proof of rights, authenticity or a particular master.</p>
    <fieldset><legend>What is it?</legend>
      <div class="grid-2">
        ${selectField({ label: "Track or release", name: "granularity", value: v.granularity ?? "track", options: [{ value: "track", label: "Single track" }, { value: "release", label: "Whole release" }], errors: o.errors, required: true })}
        ${selectField({ label: "Kind of holding", name: "holding_kind", value: v.holding_kind ?? "unspecified", options: [
          { value: "purchased", label: "Purchased download" }, { value: "personal", label: "Personal file (e.g. my own rip or promo)" },
          { value: "linked_to_physical", label: "Digital copy of a record I own" }, { value: "unspecified", label: "Not specified" }], errors: o.errors })}
        ${textField({ label: "Artist", name: "artist_text", value: v.artist_text, errors: o.errors, required: true })}
        ${textField({ label: "Title", name: "title_text", value: v.title_text, errors: o.errors, required: true })}
        ${textField({ label: "Version / mix", name: "version_text", value: v.version_text, errors: o.errors, placeholder: "Extended Mix, Radio Edit…" })}
        ${textField({ label: "Album / release", name: "album_text", value: v.album_text, errors: o.errors })}
        ${textField({ label: "Label", name: "label_text", value: v.label_text, errors: o.errors })}
        ${textField({ label: "Catalog number", name: "catno_text", value: v.catno_text, errors: o.errors })}
        ${textField({ label: "Year", name: "release_year", value: v.release_year, errors: o.errors, inputmode: "numeric" })}
        ${textField({ label: "Genre (your own label)", name: "genre_text", value: v.genre_text, errors: o.errors })}
      </div></fieldset>
    <fieldset><legend>File details</legend>
      <div class="grid-3">
        ${textField({ label: "File format", name: "file_format", value: v.file_format, errors: o.errors, placeholder: "AIFF, FLAC, MP3" })}
        ${textField({ label: "Bitrate (kbps)", name: "bitrate_kbps", value: v.bitrate_kbps, errors: o.errors, inputmode: "numeric" })}
        ${textField({ label: "Sample rate (Hz)", name: "sample_rate_hz", value: v.sample_rate_hz, errors: o.errors, inputmode: "numeric" })}
        ${textField({ label: "Bit depth", name: "bit_depth", value: v.bit_depth, errors: o.errors, inputmode: "numeric" })}
        ${textField({ label: "BPM", name: "bpm", value: v.bpm, errors: o.errors, inputmode: "decimal" })}
        ${textField({ label: "Key", name: "musical_key", value: v.musical_key, errors: o.errors, placeholder: "8A, Cmaj" })}
      </div></fieldset>
    <fieldset><legend>Private</legend>
      <div class="grid-2">
        ${textField({ label: "Acquired from", name: "acquisition_source", value: v.acquisition_source, errors: o.errors, placeholder: "Store, promo, own rip…" })}
        ${textField({ label: "Acquired on", name: "acquired_on", type: "date", value: v.acquired_on, errors: o.errors })}
      </div>
      ${selectField({ label: "Digital copy of one of your records (optional)", name: "linked_copy_id", value: v.linked_copy_id ? String(v.linked_copy_id) : "", options: copies.map((c) => ({ value: String(c.item_id), label: `${c.artist} — ${c.title} (${c.format_raw ?? ""})` })), blank: "Not linked", errors: o.errors, hint: "Only link when you know this file came from that record." })}
      ${textField({ label: "Personal tags", name: "tags", value: v.tags, errors: o.errors, hint: `Comma-separated. Ideas: ${SUGGESTED_TAGS.join(", ")}` })}
      ${textArea({ label: "Private notes", name: "private_notes", value: v.private_notes, errors: o.errors, rows: 3 })}
    </fieldset>
    <div class="actions"><button class="btn btn-primary" type="submit">${o.submit}</button><a class="btn btn-quiet" href="/library">Cancel</a></div>
  </form>`;
}

function crateAdder(req: Request, ctx: AppContext, ref: ItemRef, current: { id: number; name: string }[]) {
  const crates = listCrates(ctx.db, me(req).id).filter((c) => !current.some((x) => x.id === c.id));
  return html`<div class="panel"><h3>Crates</h3>
    ${current.length ? html`<ul class="plain">${current.map((c) => html`<li><a href="/crates/${c.id}">${c.name}</a>
      <form method="post" action="/crates/${c.id}/remove-item" class="inline">${csrf(req)}<input type="hidden" name="ref" value="${refKey(ref)}"><input type="hidden" name="return_to" value="${req.originalUrl}"><button class="btn btn-quiet btn-sm" type="submit">Remove</button></form></li>`)}</ul>` : html`<p class="muted small">Not in any crate.</p>`}
    ${crates.length ? html`<form method="post" action="/crates/add-item" class="searchbar">${csrf(req)}<input type="hidden" name="ref" value="${refKey(ref)}"><input type="hidden" name="return_to" value="${req.originalUrl}">
      <label for="f-add-crate" class="sr-only">Add to crate</label><select id="f-add-crate" name="crate_id">${crates.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
      <button class="btn btn-sm" type="submit">Add to crate</button></form>` : html`<p class="small"><a href="/crates">Create a crate</a></p>`}
  </div>`;
}

function notesPanel(req: Request, action: string, notes: string | null) {
  return html`<form method="post" action="${action}" class="panel private-note">${csrf(req)}
    <label for="f-quick-notes" class="private-label">Private notes — only you can see these</label>
    <textarea id="f-quick-notes" name="private_notes" rows="3">${notes ?? ""}</textarea>
    <div class="actions"><button class="btn btn-sm" type="submit">Save notes</button></div></form>`;
}

function relatedPanel(ctx: AppContext, ownerId: number, ref: ItemRef) {
  const rel = relatedHoldings(ctx.db, ownerId, ref);
  if (!rel.items.length && !rel.wants.length) return "";
  return html`<div class="panel"><h3>Also in your library</h3>
    <ul class="plain">${rel.items.map((i: any) => html`<li><a href="${itemHref(i)}">${i.item_type === "digital" ? "Digital" : i.format_group}${i.format_raw ? ` (${i.format_raw})` : ""}${i.catno ? ` · ${i.catno}` : ""}</a> <span class="muted small">— ${i.via}</span></li>`)}
    ${rel.wants.map((w: any) => html`<li>On your wantlist: ${WANT_KIND_LABELS[w.want_kind]}${w.catalog_number ? ` · ${w.catalog_number}` : ""}${w.configuration_note ? ` · ${w.configuration_note}` : ""} <a class="small" href="/wants">Wantlist</a></li>`)}</ul>
    <p class="muted small">Shown only for links you confirmed (same archive release, or a digital copy you linked).</p></div>`;
}

function sourcePanel(src: any) {
  if (!src) return "";
  const s = src.data.source ?? {};
  const isDiscogs = src.kind.startsWith("discogs");
  const custom = isDiscogs ? Object.entries(s.custom ?? {}) : [];
  return html`<details class="panel"><summary>Imported from ${src.library_name} <span class="muted small">(${isDiscogs ? `Discogs release ${src.external_id ?? "?"}` : `TrackID ${src.external_id}`} · private)</span></summary>
    <p class="muted small">This is what the export said. Your edits are stored separately and are never overwritten by later imports.</p>
    <dl class="facts">
      ${isDiscogs ? html`
        <dt>Format as exported</dt><dd>${s.format || "—"}</dd>
        <dt>Folder</dt><dd>${s.folder || "—"}</dd>
        <dt>Rating</dt><dd>${s.rating || "—"}</dd>
        <dt>Conditions as exported</dt><dd>${s.media || "—"} / ${s.sleeve || "—"}</dd>
        <dt>Notes from Discogs</dt><dd class="prewrap">${s.notes || "—"}</dd>
        ${custom.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}
        ${s.discogs_url ? html`<dt>Link</dt><dd><a href="${s.discogs_url}" rel="noopener noreferrer external" target="_blank">View release on Discogs ↗</a> <span class="muted small">(external; we don't copy Discogs data or artwork)</span></dd>` : ""}`
      : html`
        <dt>Cue / loop markers</dt><dd>${(s.cues ?? []).length} (read-only)</dd>
        <dt>Tempo map points</dt><dd>${(s.tempo ?? []).length} (read-only)</dd>`}
    </dl>
    ${(src.data.warnings ?? []).length ? html`<p class="small uncertain">${src.data.warnings.join(" ")}</p>` : ""}
  </details>`;
}

export function registerLibraryRoutes(app: Express, ctx: AppContext) {
  app.get("/", (req, res) => res.redirect(302, req.state.user ? "/library" : "/discover"));

  // ───────────────────────── Library ─────────────────────────
  app.get("/library", (req, res) => {
    const user = me(req);
    const f = parseLibraryFilters(req.query);
    // Explicit view changes are remembered server-side (not in the browser).
    const saved = getPref(ctx.db, user.id, "library_view", DEFAULT_PREFS);
    const prefs: ViewPrefs = {
      view: req.query.view === "table" || req.query.view === "grid" ? req.query.view : saved.view,
      sort: String(req.query.sort ?? "") in SORT_LABELS ? (req.query.sort as LibrarySort) : saved.sort,
      dir: req.query.dir === "desc" || req.query.dir === "asc" ? req.query.dir : saved.dir,
      group: String(req.query.group ?? "") in GROUP_LABELS && req.query.group !== undefined ? (req.query.group as LibraryGroup) : saved.group,
    };
    if (["view", "sort", "dir", "group"].some((k) => req.query[k] !== undefined)) setPref(ctx.db, user.id, "library_view", prefs);
    const pageSize = prefs.view === "grid" ? 48 : 100;
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const counts = libraryCounts(ctx.db, user.id);
    const facets = libraryFacets(ctx.db, user.id);
    const crates = listCrates(ctx.db, user.id);
    const tags = listTags(ctx.db, user.id);
    const { total, rows } = listLibrary(ctx.db, user.id, f, prefs.sort, prefs.dir, pageNo, pageSize);
    const groups = prefs.group ? groupCounts(ctx.db, user.id, f, prefs.group) : null;
    const q = (extra: Record<string, string | null> = {}) => `/library?${filterQuery(f, extra)}`;
    const filtered = Object.values(f).some(Boolean);
    const groupFilterKey: Record<string, keyof LibraryFilters> = { format: "format", genre: "genre", folder: "folder", artist: "q", label: "q" };
    const batch = f.batch ? (ctx.db.prepare("SELECT id, filename FROM import_batches WHERE id = ? AND owner_id = ?").get(Number(f.batch), user.id) as any) : null;

    const chips: SafeHtml[] = [];
    const chip = (label: string, key: keyof LibraryFilters) => chips.push(html`<a class="chip" href="${q({ [key]: null, page: null })}" aria-label="Remove filter ${label}">${label} <span aria-hidden="true">×</span></a>`);
    if (f.q) chip(`Search “${f.q}”`, "q");
    if (f.type) chip(f.type === "physical" ? "Physical only" : "Digital only", "type");
    if (f.format) chip(`Format: ${f.format}`, "format");
    if (f.genre) chip(`Genre: ${f.genre}`, "genre");
    if (f.tag) chip(`Tag: ${f.tag}`, "tag");
    if (f.crate) chip(`Crate: ${crates.find((c) => String(c.id) === f.crate)?.name ?? "?"}`, "crate");
    if (f.folder) chip(f.folder.startsWith("pl:") ? `Playlist: ${facets.playlists.find((p) => `pl:${p.id}` === f.folder)?.path ?? "?"}` : `Folder: ${f.folder}`, "folder");
    if (f.resolved) chip(f.resolved === "yes" ? "Linked to archive" : "Not linked to archive", "resolved");
    if (f.batch) chip(`From import #${f.batch}${batch ? ` (${batch.filename})` : ""}`, "batch");
    if (f.status) chip(`Status: ${f.status}`, "status");

    const option = (value: string, label: string, current: string) => html`<option value="${value}"${value === current ? raw(" selected") : ""}>${label}</option>`;
    const results = rows.length
      ? prefs.view === "grid"
        ? html`<ul class="results-grid" data-restore-scroll>${rows.map((r) => html`<li class="card">
            <label class="card-select"><input type="checkbox" name="refs" value="${refKey({ type: r.item_type, id: r.item_id })}" form="bulk-form"><span class="sr-only">Select ${r.title}</span></label>
            <a class="card-link" href="${itemHref(r)}">${itemArt(r)}
            <span class="meta"><span class="t">${r.title}</span><span class="a">${r.artist}</span>
            <span class="d">${typeBadge(r)} ${itemLine(r)}</span>
            ${r.tags.length ? html`<span class="d">${r.tags.slice(0, 4).map((t: string) => html`<span class="tag">${t}</span>`)}</span>` : ""}</span></a></li>`)}</ul>`
        : html`<div class="table-wrap" data-restore-scroll><table class="compact library-table">
            <thead><tr><th><label class="check"><input type="checkbox" id="select-page"><span class="sr-only">Select all on this page</span></label></th>
              ${(["artist", "title"] as LibrarySort[]).map((s) => html`<th><a href="${q({ sort: s, dir: prefs.sort === s && prefs.dir === "asc" ? "desc" : "asc" })}"${prefs.sort === s ? raw(` aria-sort="${prefs.dir === "asc" ? "ascending" : "descending"}"`) : ""}>${SORT_LABELS[s]}${prefs.sort === s ? (prefs.dir === "asc" ? " ↑" : " ↓") : ""}</a></th>`)}
              <th>Format</th><th class="hide-sm">Label · Cat. no.</th>
              <th><a href="${q({ sort: "year", dir: prefs.sort === "year" && prefs.dir === "asc" ? "desc" : "asc" })}"${prefs.sort === "year" ? raw(` aria-sort="${prefs.dir === "asc" ? "ascending" : "descending"}"`) : ""}>Year${prefs.sort === "year" ? (prefs.dir === "asc" ? " ↑" : " ↓") : ""}</a></th>
              <th class="hide-sm">Genre</th><th class="hide-sm">BPM · Key</th><th class="hide-sm">Tags</th>
              <th class="hide-sm"><a href="${q({ sort: "date_added", dir: prefs.sort === "date_added" && prefs.dir === "desc" ? "asc" : "desc" })}">Added${prefs.sort === "date_added" ? (prefs.dir === "asc" ? " ↑" : " ↓") : ""}</a></th></tr></thead>
            <tbody>${rows.map((r) => html`<tr>
              <td><label class="check"><input type="checkbox" name="refs" value="${refKey({ type: r.item_type, id: r.item_id })}" form="bulk-form"><span class="sr-only">Select ${r.title}</span></label></td>
              <td>${r.artist}</td>
              <td><a href="${itemHref(r)}"><strong>${r.title}</strong></a>${r.version ? html` <span class="muted">(${r.version})</span>` : ""}${r.listing_status ? html` ${statusBadge(r.listing_status)}` : ""}</td>
              <td>${typeBadge(r)}${r.item_type === "physical" && r.media_condition ? html` <span class="small">${grade(r.media_condition)}/${grade(r.sleeve_condition)}</span>` : ""}</td>
              <td class="hide-sm small">${r.label ?? ""}${r.catno ? html` · <span class="catno">${r.catno}</span>` : ""}</td>
              <td>${r.year ?? html`<span class="muted">—</span>`}</td>
              <td class="hide-sm small">${r.genre ?? html`<span class="muted">—</span>`}</td>
              <td class="hide-sm small nowrap">${bpm(r.bpm_x100)}${r.musical_key ? ` · ${r.musical_key}` : ""}</td>
              <td class="hide-sm">${r.tags.map((t: string) => html`<span class="tag">${t}</span>`)}</td>
              <td class="hide-sm small nowrap">${String(r.date_added).slice(0, 10)}</td></tr>`)}</tbody></table></div>`
      : counts.physical_copies + counts.digital_tracks + counts.digital_releases === 0
        ? html`<div class="empty"><h2>Your library is empty</h2>
            <p>Bring in what you already have, or add things one by one.</p>
            <div class="actions"><a class="btn btn-primary" href="/imports">Import from Discogs or Rekordbox</a><a class="btn btn-quiet" href="/copies/new">Add a record manually</a><a class="btn btn-quiet" href="/digital/new">Add a digital file manually</a></div></div>`
        : html`<div class="empty"><h2>Nothing matches these filters</h2><p><a class="btn btn-quiet" href="/library">Clear all filters</a></p></div>`;

    page(req, res, {
      title: "Library",
      nav: "library",
      wide: true,
      body: html`
        <div class="toolbar"><div class="left"><h1>Library</h1></div>
          <div class="right"><a class="btn btn-sm" href="/imports">Import</a><a class="btn btn-quiet btn-sm" href="/copies/new">+ Record</a><a class="btn btn-quiet btn-sm" href="/digital/new">+ Digital</a><a class="btn btn-quiet btn-sm" href="/wants">Wantlist (${counts.wants})</a></div></div>
        <p class="counts small" aria-label="Library counts">
          <strong>${counts.physical_copies}</strong> physical cop${counts.physical_copies === 1 ? "y" : "ies"} (${counts.physical_editions} archive edition${counts.physical_editions === 1 ? "" : "s"} linked, ${counts.physical_unresolved} not linked) ·
          <strong>${counts.digital_tracks}</strong> digital track${counts.digital_tracks === 1 ? "" : "s"} · <strong>${counts.digital_releases}</strong> digital release${counts.digital_releases === 1 ? "" : "s"} ·
          <strong>${counts.releases_linked}</strong> archive release${counts.releases_linked === 1 ? "" : "s"} represented · wants are kept separately (<a href="/wants">${counts.wants}</a>)</p>
        <form method="get" action="/library" class="panel library-controls" role="search">
          <div class="searchbar"><label for="f-lq" class="sr-only">Search your library</label>
            <input id="f-lq" type="search" name="q" value="${f.q}" placeholder="Artist, title, label, catalog number or version">
            <button class="btn btn-primary" type="submit">Search</button></div>
          <div class="grid-filters">
            <div class="field"><label for="f-type">Holdings</label><select id="f-type" name="type">${option("", "Physical + digital", f.type)}${option("physical", "Physical only", f.type)}${option("digital", "Digital only", f.type)}</select></div>
            <div class="field"><label for="f-format">Format</label><select id="f-format" name="format">${option("", "Any", f.format)}${facets.formats.map((x) => option(x, x, f.format))}</select></div>
            <div class="field"><label for="f-genre">Genre</label><select id="f-genre" name="genre">${option("", "Any", f.genre)}${facets.genres.map((x) => option(x, x, f.genre))}${option("(none)", "No genre recorded", f.genre)}</select></div>
            <div class="field"><label for="f-tag">Personal tag</label><select id="f-tag" name="tag">${option("", "Any", f.tag)}${tags.map((t) => option(t.name, `${t.name} (${t.n})`, f.tag))}</select></div>
            <div class="field"><label for="f-crate">Crate</label><select id="f-crate" name="crate">${option("", "Any", f.crate)}${crates.map((c) => option(String(c.id), `${c.name} (${c.n})`, f.crate))}</select></div>
            <div class="field"><label for="f-folder">Imported folder / playlist</label><select id="f-folder" name="folder">${option("", "Any", f.folder)}
              ${facets.folders.map((x) => option(x, `Discogs: ${x}`, f.folder))}${facets.playlists.map((p) => option(`pl:${p.id}`, `Rekordbox: ${p.path}`, f.folder))}</select></div>
            <div class="field"><label for="f-resolved">Archive link</label><select id="f-resolved" name="resolved">${option("", "Any", f.resolved)}${option("yes", "Linked to an archive edition", f.resolved)}${option("no", "Not linked", f.resolved)}</select></div>
          </div>
          ${f.batch ? html`<input type="hidden" name="batch" value="${f.batch}">` : ""}
          <div class="toolbar">
            <div class="left">
              <label for="f-sort">Sort</label><select id="f-sort" name="sort">${Object.entries(SORT_LABELS).map(([k, v]) => option(k, v, prefs.sort))}</select>
              <label for="f-dir" class="sr-only">Direction</label><select id="f-dir" name="dir">${option("asc", "Ascending", prefs.dir)}${option("desc", "Descending", prefs.dir)}</select>
              <label for="f-group">Group by</label><select id="f-group" name="group">${Object.entries(GROUP_LABELS).map(([k, v]) => option(k, v, prefs.group))}</select>
              <button class="btn btn-sm" type="submit">Apply</button>
              ${filtered ? html`<a class="btn btn-quiet btn-sm" href="/library">Clear filters</a>` : ""}
            </div>
            <span class="segmented" aria-label="View"><a href="${q({ view: "grid" })}" aria-current="${prefs.view === "grid"}">Artwork</a><a href="${q({ view: "table" })}" aria-current="${prefs.view === "table"}">Table</a></span>
          </div>
          <p class="explain">Sort, grouping and view are remembered for your account.</p>
        </form>
        ${chips.length ? html`<div class="active-filters">${chips}</div>` : ""}
        <p><strong>${total}</strong> item${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""}.</p>
        ${groups ? html`<section class="panel" aria-labelledby="groups-h"><h2 id="groups-h">Grouped by ${GROUP_LABELS[prefs.group].toLowerCase()}</h2>
            ${prefs.group === "folder" || prefs.group === "genre" ? html`<p class="explain">An item can appear in more than one group (several genres, or several playlists).</p>` : ""}
            <ul class="group-list">${groups.map((g) => {
              const key = groupFilterKey[prefs.group];
              const href = key === "q" ? q({ q: g.key === "(none)" ? null : g.key, page: null }) : q({ [key]: g.key, page: null });
              return html`<li><a href="${href}">${g.label}</a> <span class="muted">${g.n}</span></li>`;
            })}</ul></section>` : ""}
        ${results}
        ${pagination("/library", filterQuery(f), pageNo, total, pageSize)}
        ${rows.length ? bulkBar(req, ctx, f, rows, total, crates) : ""}`,
    });
  });

  function bulkBar(req: Request, _ctx: AppContext, f: LibraryFilters, rows: any[], total: number, crates: { id: number; name: string }[]) {
    return html`<form method="post" action="/library/bulk/preview" id="bulk-form" class="bulkbar" aria-label="Bulk actions">
      ${csrf(req)}
      ${rows.map((r) => html`<input type="hidden" name="page_refs" value="${refKey({ type: r.item_type, id: r.item_id })}">`)}
      ${Object.entries(f).map(([k, v]) => (v ? html`<input type="hidden" name="f_${k}" value="${v}">` : ""))}
      <fieldset class="scope"><legend class="sr-only">Apply to</legend>
        <label class="check"><input type="radio" name="scope" value="selected" id="scope-selected" checked> <span>Selected (<span id="selected-count">0</span>)</span></label>
        <label class="check"><input type="radio" name="scope" value="page" id="scope-page"> <span>This page (${rows.length})</span></label>
        <label class="check"><input type="radio" name="scope" value="all_matching"> <span>All ${total} matching</span></label>
      </fieldset>
      <label for="f-action" class="sr-only">Action</label>
      <select id="f-action" name="action"><option value="add_to_crate">Add to crate…</option><option value="remove_from_crate">Remove from crate…</option><option value="add_tag">Add tag…</option><option value="remove_tag">Remove tag…</option></select>
      <label for="f-bcrate" class="sr-only">Crate</label>
      <select id="f-bcrate" name="crate_id"><option value="">crate</option>${crates.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
      <label for="f-btag" class="sr-only">Tag</label><input id="f-btag" type="text" name="tag" placeholder="tag" list="tag-suggestions">
      <datalist id="tag-suggestions">${SUGGESTED_TAGS.map((t) => html`<option value="${t}">`)}</datalist>
      <button class="btn btn-primary btn-sm" type="submit">Review change…</button>
    </form>`;
  }

  app.post("/library/bulk/preview", (req, res) => {
    const user = me(req);
    const bulk = bulkRequestFromBody(req.body);
    const action = parseBulkAction(req.body);
    const refs = resolveBulkScope(ctx.db, user.id, bulk);
    const back = `/library?${filterQuery(bulk.filters)}`;
    if (!refs.length) {
      addFlash(req, "error", bulk.scope === "selected" ? "Select at least one item, or choose “This page” or “All matching”." : "No items are in that scope.");
      return res.redirect(303, back);
    }
    const physical = refs.filter((r) => r.type === "physical").length;
    const scopeText = bulk.scope === "all_matching" ? `all ${refs.length} items matching your current filters` : bulk.scope === "page" ? `the ${refs.length} items on the page you were viewing` : `${refs.length} selected item${refs.length === 1 ? "" : "s"}`;
    const sample = refs.slice(0, 12).map((r) => ctx.db.prepare("SELECT artist, title, item_type FROM library_items WHERE item_type = ? AND item_id = ?").get(r.type, r.id) as any);
    page(req, res, {
      title: "Confirm bulk change",
      nav: "library",
      body: html`<div class="confirm-box form-narrow">
        <h1>Confirm bulk change</h1>
        <p class="lead"><strong>${describeBulkAction(ctx.db, user.id, action)}</strong></p>
        <p>Applies to <strong>${scopeText}</strong> — ${physical} physical, ${refs.length - physical} digital.</p>
        <ul class="small">${sample.map((s) => html`<li>${s.artist} — ${s.title} <span class="muted">(${s.item_type})</span></li>`)}${refs.length > sample.length ? html`<li>…and ${refs.length - sample.length} more</li>` : ""}</ul>
        <form method="post" action="/library/bulk/apply">${csrf(req)}
          ${refs.map((r) => html`<input type="hidden" name="refs" value="${refKey(r)}">`)}
          <input type="hidden" name="expected_count" value="${refs.length}">
          <input type="hidden" name="action" value="${action.kind}">
          ${"tag" in action ? html`<input type="hidden" name="tag" value="${action.tag}">` : html`<input type="hidden" name="crate_id" value="${action.crateId}">`}
          <input type="hidden" name="return_to" value="${back}">
          <div class="actions"><button class="btn btn-primary" type="submit">Apply to ${refs.length} item${refs.length === 1 ? "" : "s"}</button><a class="btn btn-quiet" href="${back}">Cancel</a></div>
        </form></div>`,
    });
  });

  app.post("/library/bulk/apply", (req, res) => {
    const user = me(req);
    const refs = resolveBulkScope(ctx.db, user.id, { scope: "selected", selected: parseRefs(req.body.refs), page: [], filters: parseLibraryFilters({}) });
    const action = parseBulkAction(req.body);
    const back = typeof req.body.return_to === "string" && req.body.return_to.startsWith("/library") ? req.body.return_to : "/library";
    if (refs.length !== Number(req.body.expected_count)) {
      addFlash(req, "error", "Your library changed since you reviewed this. Nothing was applied; please review again.");
      return res.redirect(303, back);
    }
    const changed = applyBulkAction(ctx.db, ctx.clock, user.id, refs, action);
    addFlash(req, "success", `${describeBulkAction(ctx.db, user.id, action)}: ${changed} of ${refs.length} item${refs.length === 1 ? "" : "s"} changed${changed < refs.length ? " (the rest already matched)" : ""}.`);
    res.redirect(303, back);
  });

  // ───────────────────────── Physical copies ─────────────────────────
  const copyValues = (c: any) => ({
    ...c, tags: c.tags.join(", "), acquisition_cost: centsToInput(c.acquisition_cost_cents), dj_energy: c.dj_energy ? String(c.dj_energy) : "",
  });

  app.get("/copies/new", (req, res) => {
    me(req);
    page(req, res, { title: "Add a record", nav: "library", body: html`<h1>Add a record manually</h1>
      <p class="muted">For records not in the archive (or when you'd rather not look them up). It stays private. You can link it to an archive edition later. To add a known archive edition instead, find it in the <a href="/discover">archive</a> and choose “Add to collection”.</p>
      ${physicalForm(req, ctx, { action: "/copies/new", values: { media_condition: "", sleeve_condition: "" }, submit: "Add record", descriptive: true })}` });
  });

  app.post("/copies/new", (req, res) => {
    const user = me(req);
    try {
      const id = createManualCopy(ctx.db, ctx.clock, user.id, req.body);
      addFlash(req, "success", "Record added to your library (private).");
      res.redirect(303, `/copies/${id}`);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      page(req, res, { title: "Add a record", nav: "library", body: html`<h1>Add a record manually</h1>${physicalForm(req, ctx, { action: "/copies/new", values: req.body, errors: e.fields, submit: "Add record", descriptive: true })}` }, 422);
    }
  });

  const renderAddFromEdition = (req: Request, res: Response, editionId: number, values: Record<string, any>, errors?: FieldErrors) => {
    const e = getEditionSummary(ctx.db, editionId)!;
    const title = (ctx.db.prepare("SELECT title FROM releases WHERE id = ?").get(e.release_id) as any).title;
    page(req, res, {
      title: "Add a copy",
      nav: "library",
      body: html`<h1>Add a copy to your library</h1>
        <p class="panel"><strong>${artistCredit(ctx.db, e.release_id)} — ${title}</strong><br><span class="catno">${e.catalog_number ?? "no cat. no."}</span> · ${e.label ?? "label unknown"} · ${e.format} ${e.format_details ?? ""} · ${countryName(e.country)} · ${e.release_year ?? "year unknown"}
        <br><a class="small" href="/editions/${e.id}">Not this edition? Check the edition details</a></p>
        <p class="muted">Your copy is <strong>private</strong> and <strong>not for sale</strong> unless you create a listing.</p>
        ${physicalForm(req, ctx, { action: "/collection/add", values, errors, submit: "Add copy", editionId: e.id, descriptive: false, allowSellNext: true })}`,
    }, errors ? 422 : 200);
  };

  app.get("/collection/add", (req, res) => {
    me(req);
    const e = getEditionSummary(ctx.db, Number(req.query.edition_id));
    if (!e) return page(req, res, { title: "Add a copy", nav: "library", body: html`<div class="empty"><h1>Choose an edition first</h1><p>Find the edition in the <a href="/discover">archive</a>, or <a href="/copies/new">add a record manually</a>.</p></div>` });
    renderAddFromEdition(req, res, e.id, { media_condition: "", sleeve_condition: "" });
  });

  app.post("/collection/add", (req, res) => {
    const user = me(req);
    const editionId = Number(req.body.edition_id);
    if (!getEditionSummary(ctx.db, editionId)) throw new DomainError("Edition not found.", 404);
    try {
      const id = createCopy(ctx.db, ctx.clock, user.id, editionId, req.body);
      addFlash(req, "success", "Copy added to your library (private).");
      res.redirect(303, req.body.next === "sell" ? `/copies/${id}/sell` : `/copies/${id}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderAddFromEdition(req, res, editionId, req.body, e.fields);
      if (e instanceof DomainError && e.status === 422) return renderAddFromEdition(req, res, editionId, req.body, { crate_id: e.message });
      throw e;
    }
  });

  app.get("/copies/:id", (req, res) => {
    const user = me(req);
    const c = getOwnCopy(ctx.db, user.id, idParam(req));
    const ref: ItemRef = { type: "physical", id: c.id };
    const suggestions = c.edition_id == null
      ? (ctx.db.prepare(
          `SELECT e.id, e.catalog_number, e.format, e.country, e.release_year, r.title FROM editions e JOIN releases r ON r.id = e.release_id
           WHERE (e.catalog_number_norm IS NOT NULL AND e.catalog_number_norm = ?) OR r.title = ? COLLATE NOCASE LIMIT 8`,
        ).all(String(c.catno_text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") || "~", c.title_text ?? "~") as any[])
      : [];
    page(req, res, {
      title: `${c.title}`,
      nav: "library",
      body: html`
        <nav class="crumbs"><a href="/library">Library</a> / <span>${c.title}</span></nav>
        <h1>${c.title}</h1>
        <p class="lead"><strong>${c.artist}</strong></p>
        <p>${html`<span class="badge kind-physical">${c.display_format_group}</span>`} ${c.display_format_raw ?? ""} ${c.label ? ` · ${c.label}` : ""}${c.catno ? html` · <span class="catno">${c.catno}</span>` : ""}${c.year ? ` · ${c.year}` : ""}</p>
        ${c.edition_id
          ? html`<p class="small">Linked to archive edition <a href="/editions/${c.edition_id}"><span class="catno">${c.catalog_number ?? "no cat. no."}</span> (${c.format} ${c.format_details ?? ""}, ${countryName(c.country)})</a>. ${c.genre ? html`Archive genre: ${c.genre}.` : ""}</p>`
          : html`<p class="small uncertain">Not linked to an archive edition. The details above are your own private record${c.source ? " from your import" : ""}.</p>`}
        <div class="detail">
          <div>
            ${c.edition_id ? itemArt({ ...c, image_id: (ctx.db.prepare("SELECT id FROM archive_images WHERE edition_id = ? ORDER BY kind = 'front' DESC, id LIMIT 1").get(c.edition_id) as any)?.id, format_group: c.display_format_group }) : itemArt({ ...c, format_group: c.display_format_group })}
            <h2>Photos of this copy</h2>
            <p class="muted small">Actual-copy photos stay private unless you attach them to a published listing.</p>
            <div class="photo-row">${c.photos.map((p: any) => html`<div>${copyPhoto(p.id, c.title, "sm")}<form method="post" action="/copy-photos/${p.id}/delete">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit">Remove</button></form></div>`)}</div>
            <form method="post" action="/copies/${c.id}/photos" enctype="multipart/form-data" class="panel">${csrf(req)}
              <div class="field"><label for="f-images">Add photos (JPEG, PNG or WebP, up to 5 MB each)</label><input id="f-images" type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></div>
              <button class="btn btn-sm" type="submit">Upload</button></form>
          </div>
          <div>
            <div class="panel"><h3>Condition</h3><p>Media ${grade(c.media_condition)} · Sleeve ${grade(c.sleeve_condition)}</p>
              <dl class="facts small"><dt>Tags</dt><dd>${c.tags.length ? c.tags.map((t: string) => html`<span class="tag">${t}</span>`) : "—"}</dd>
              <dt>Energy · BPM</dt><dd>${c.dj_energy ?? "—"} · ${c.dj_bpm_notes ?? "—"}</dd>
              <dt>Location</dt><dd>${c.storage_location ?? "—"}</dd>
              <dt>Acquired</dt><dd>${[c.acquired_on, c.acquired_from].filter(Boolean).join(" · ") || "—"}${c.acquisition_cost_cents != null ? html` · ${money(c.acquisition_cost_cents)}` : ""}</dd>
              <dt>Added</dt><dd>${String(c.date_added).slice(0, 10)}${c.source_folder ? ` · Discogs folder “${c.source_folder}”` : ""}</dd></dl>
              <p class="private-label">Private — only you can see this</p></div>
            ${notesPanel(req, `/copies/${c.id}/notes`, c.private_notes)}
            ${crateAdder(req, ctx, ref, c.crates)}
            ${relatedPanel(ctx, user.id, ref)}
            ${sourcePanel(c.source)}
            ${suggestions.length ? html`<div class="panel"><h3>Link to an archive edition?</h3>
              <p class="small muted">Possible matches by catalog number or title. Only link if you've checked it's the same pressing.</p>
              ${suggestions.map((s) => html`<form method="post" action="/copies/${c.id}/link-edition" class="cart-line">${csrf(req)}<input type="hidden" name="edition_id" value="${s.id}">
                <span class="grow"><a href="/editions/${s.id}">${s.title} <span class="catno">${s.catalog_number ?? "—"}</span></a> ${s.format} · ${countryName(s.country)} · ${s.release_year ?? "?"}</span>
                <button class="btn btn-quiet btn-sm" type="submit">Link</button></form>`)}</div>` : ""}
            <div class="action-row">
              <a class="btn btn-quiet" href="/copies/${c.id}/edit">Edit</a>
              ${c.listing ? html`<a class="btn" href="/selling/listings/${c.listing.id}">Listing #${c.listing.id}: ${statusBadge(c.listing.status)}</a>`
                : c.edition_id ? html`<a class="btn btn-quiet" href="/copies/${c.id}/sell">Sell this copy</a>`
                : html`<span class="muted small">Link to an archive edition to be able to sell this copy.</span>`}
            </div>
          </div>
        </div>`,
    });
  });

  app.post("/copies/:id/notes", (req, res) => {
    const user = me(req);
    const c = getOwnCopy(ctx.db, user.id, idParam(req));
    updateCopy(ctx.db, ctx.clock, user.id, c.id, { ...copyValues(c), private_notes: String(req.body.private_notes ?? ""), crate_id: "" });
    addFlash(req, "success", "Notes saved.");
    res.redirect(303, `/copies/${c.id}`);
  });

  app.post("/copies/:id/link-edition", (req, res) => {
    const user = me(req);
    linkCopyToEdition(ctx.db, ctx.clock, user.id, idParam(req), Number(req.body.edition_id));
    addFlash(req, "success", "Linked to the archive edition. Your own notes, tags and imported details are unchanged.");
    res.redirect(303, `/copies/${req.params.id}`);
  });

  app.get("/copies/:id/edit", (req, res) => {
    const user = me(req);
    const c = getOwnCopy(ctx.db, user.id, idParam(req));
    page(req, res, { title: "Edit", nav: "library", body: html`<h1>Edit · ${c.title}</h1>${physicalForm(req, ctx, { action: `/copies/${c.id}/edit`, values: copyValues(c), submit: "Save", descriptive: c.edition_id == null })}` });
  });

  app.post("/copies/:id/edit", (req, res) => {
    const user = me(req);
    const c = getOwnCopy(ctx.db, user.id, idParam(req));
    try {
      updateCopy(ctx.db, ctx.clock, user.id, c.id, req.body);
      addFlash(req, "success", "Saved. Later imports won't overwrite your edits.");
      res.redirect(303, `/copies/${c.id}`);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      page(req, res, { title: "Edit", nav: "library", body: html`<h1>Edit · ${c.title}</h1>${physicalForm(req, ctx, { action: `/copies/${c.id}/edit`, values: req.body, errors: e.fields, submit: "Save", descriptive: c.edition_id == null })}` }, 422);
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
    res.redirect(303, `/copies/${id}`);
  });

  app.post("/copy-photos/:id/delete", (req, res) => {
    const user = me(req);
    const photo = ctx.db.prepare("SELECT p.copy_id FROM copy_photos p JOIN copies c ON c.id = p.copy_id WHERE p.id = ? AND c.owner_id = ?").get(idParam(req), user.id) as any;
    deleteCopyPhoto(ctx.db, ctx.clock, user.id, idParam(req));
    addFlash(req, "success", "Photo removed.");
    res.redirect(303, `/copies/${photo.copy_id}`);
  });

  // ───────────────────────── Digital holdings ─────────────────────────
  const digitalValues = (d: any) => ({ ...d, bpm: bpm(d.bpm_x100), tags: d.tags.join(", ") });

  app.get("/digital/new", (req, res) => {
    me(req);
    page(req, res, { title: "Add a digital file", nav: "library", body: html`<h1>Add a digital file or release</h1>${digitalForm(req, ctx, { action: "/digital/new", values: { granularity: "track" }, submit: "Add" })}` });
  });

  app.post("/digital/new", (req, res) => {
    const user = me(req);
    try {
      const id = createDigital(ctx.db, ctx.clock, user.id, req.body);
      addFlash(req, "success", "Added to your library (private).");
      res.redirect(303, `/digital/${id}`);
    } catch (e) {
      if (e instanceof ValidationError) return page(req, res, { title: "Add a digital file", nav: "library", body: html`<h1>Add a digital file or release</h1>${digitalForm(req, ctx, { action: "/digital/new", values: req.body, errors: e.fields, submit: "Add" })}` }, 422);
      throw e;
    }
  });

  app.get("/digital/:id", (req, res) => {
    const user = me(req);
    const d = getOwnDigital(ctx.db, user.id, idParam(req));
    const ref: ItemRef = { type: "digital", id: d.id };
    const kindLabel: Record<string, string> = { purchased: "Purchased download", personal: "Personal file", linked_to_physical: "Digital copy of a record you own", unspecified: "Kind not specified" };
    page(req, res, {
      title: d.title_text,
      nav: "library",
      body: html`<nav class="crumbs"><a href="/library">Library</a> / <span>${d.title_text}</span></nav>
        <h1>${d.title_text}${d.version_text ? html` <span class="muted">(${d.version_text})</span>` : ""}</h1>
        <p class="lead"><strong>${d.artist_text}</strong>${d.album_text ? html` · ${d.album_text}` : ""}</p>
        <p><span class="badge kind-digital">Digital ${d.granularity}</span> ${kindLabel[d.holding_kind]}${d.label_text ? ` · ${d.label_text}` : ""}${d.release_year ? ` · ${d.release_year}` : ""}${d.genre_text ? ` · Genre tag: ${d.genre_text}` : ""}</p>
        <div class="detail">
          <div>
            ${itemArt({ ...d, format_group: "Digital", title: d.title_text, artist: d.artist_text })}
            <div class="panel"><h3>File</h3><dl class="facts small">
              <dt>Format</dt><dd>${d.file_format ?? "—"}</dd>
              <dt>Quality</dt><dd>${[d.bitrate_kbps ? `${d.bitrate_kbps} kbps` : "", d.sample_rate_hz ? `${(d.sample_rate_hz / 1000).toFixed(1)} kHz` : "", d.bit_depth ? `${d.bit_depth}-bit` : ""].filter(Boolean).join(" · ") || "—"}</dd>
              <dt>Length</dt><dd>${d.duration_seconds ? `${Math.floor(d.duration_seconds / 60)}:${String(d.duration_seconds % 60).padStart(2, "0")}` : "—"}</dd>
              <dt>BPM · Key</dt><dd>${bpm(d.bpm_x100) || "—"} · ${d.musical_key ?? "—"}</dd>
              <dt>Rating</dt><dd>${d.rating != null ? `${"★".repeat(d.rating)}${"☆".repeat(5 - d.rating)}` : "—"}</dd>
              <dt>Play count</dt><dd>${d.play_count ?? "—"} ${d.play_count != null ? html`<span class="muted small">(cumulative, as exported; not a listening history)</span>` : ""}</dd>
            </dl>
            <p class="private-label">Private — file location and comments</p>
            <dl class="facts small"><dt>Location</dt><dd class="mono break">${d.file_location ?? "—"}</dd><dt>Comments</dt><dd>${d.source_comments ?? "—"}</dd>
              <dt>Acquired</dt><dd>${[d.acquisition_source, d.acquired_on].filter(Boolean).join(" · ") || "—"}</dd></dl></div>
          </div>
          <div>
            ${notesPanel(req, `/digital/${d.id}/notes`, d.private_notes)}
            <div class="panel"><h3>Tags</h3><p>${d.tags.length ? d.tags.map((t: string) => html`<span class="tag">${t}</span>`) : html`<span class="muted small">No tags yet.</span>`}</p></div>
            ${crateAdder(req, ctx, ref, d.crates)}
            ${d.playlists.length ? html`<div class="panel"><h3>In imported Rekordbox playlists</h3><ul class="plain">${d.playlists.map((p: any) => html`<li><a href="/library?folder=pl:${p.id}">${p.path}</a></li>`)}</ul><p class="muted small">Private. Shown as exported; not synchronised.</p></div>` : ""}
            ${d.linked_copy ? html`<p class="small">Digital copy of <a href="/copies/${d.linked_copy.item_id}">${d.linked_copy.title} (${d.linked_copy.format_raw ?? "record"})</a> — linked by you.</p>` : ""}
            ${relatedPanel(ctx, user.id, ref)}
            ${sourcePanel(d.source)}
            <div class="action-row"><a class="btn btn-quiet" href="/digital/${d.id}/edit">Edit</a><span class="muted small">Digital files can't be listed for sale.</span></div>
          </div>
        </div>`,
    });
  });

  app.post("/digital/:id/notes", (req, res) => {
    const user = me(req);
    const d = getOwnDigital(ctx.db, user.id, idParam(req));
    updateDigital(ctx.db, ctx.clock, user.id, d.id, { ...digitalValues(d), private_notes: String(req.body.private_notes ?? "") });
    addFlash(req, "success", "Notes saved.");
    res.redirect(303, `/digital/${d.id}`);
  });

  app.get("/digital/:id/edit", (req, res) => {
    const user = me(req);
    const d = getOwnDigital(ctx.db, user.id, idParam(req));
    page(req, res, { title: "Edit", nav: "library", body: html`<h1>Edit · ${d.title_text}</h1>${digitalForm(req, ctx, { action: `/digital/${d.id}/edit`, values: digitalValues(d), submit: "Save" })}` });
  });

  app.post("/digital/:id/edit", (req, res) => {
    const user = me(req);
    const d = getOwnDigital(ctx.db, user.id, idParam(req));
    try {
      updateDigital(ctx.db, ctx.clock, user.id, d.id, req.body);
      addFlash(req, "success", "Saved. Later imports won't overwrite your edits.");
      res.redirect(303, `/digital/${d.id}`);
    } catch (e) {
      if (e instanceof ValidationError) return page(req, res, { title: "Edit", nav: "library", body: html`<h1>Edit · ${d.title_text}</h1>${digitalForm(req, ctx, { action: `/digital/${d.id}/edit`, values: req.body, errors: e.fields, submit: "Save" })}` }, 422);
      throw e;
    }
  });

  // Single-item crate membership (from detail pages).
  app.post("/crates/add-item", (req, res) => {
    const user = me(req);
    const ref = parseRef(req.body.ref);
    if (!ref) throw new DomainError("Unknown item.", 422);
    const n = addToCrate(ctx.db, ctx.clock, user.id, Number(req.body.crate_id), [ref]);
    addFlash(req, n ? "success" : "info", n ? "Added to crate." : "Already in that crate.");
    res.redirect(303, safeReturn(req.body.return_to));
  });

  app.post("/crates/:id/remove-item", (req, res) => {
    const user = me(req);
    const ref = parseRef(req.body.ref);
    if (!ref) throw new DomainError("Unknown item.", 422);
    removeFromCrate(ctx.db, ctx.clock, user.id, idParam(req), [ref]);
    addFlash(req, "success", "Removed from crate. The item is still in your library.");
    res.redirect(303, safeReturn(req.body.return_to, `/crates/${req.params.id}`));
  });

  // ───────────────────────── Wantlist ─────────────────────────
  const renderWants = (req: Request, res: Response, values: Record<string, any> = { want_kind: "any_format" }, errors?: FieldErrors) => {
    const user = me(req);
    const q = String(req.query.q ?? "");
    const wants = listWants(ctx.db, user.id, { q });
    page(req, res, {
      title: "Wantlist",
      nav: "wants",
      body: html`<h1>Wantlist</h1>
        <p class="muted">Private. Wants are never counted as things you own. <a href="/imports">Import a Discogs wantlist</a>.</p>
        <form method="get" class="searchbar" role="search"><label for="f-wq" class="sr-only">Search wants</label><input id="f-wq" type="search" name="q" value="${q}" placeholder="Search your wants"><button class="btn" type="submit">Search</button></form>
        ${wants.length
          ? html`<div class="table-wrap"><table class="compact"><thead><tr><th>Want</th><th>Kind</th><th class="hide-sm">Details</th><th>Market</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
            ${wants.map((w) => html`<tr>
              <td><strong>${w.artist}</strong> — ${w.release_id ? html`<a href="${w.edition_id ? `/editions/${w.edition_id}` : `/releases/${w.release_id}`}">${w.title}</a>` : w.title}
                ${w.source_entry_id ? html`<br><span class="muted small">Imported${w.discogs_release_id ? html` · <a href="https://www.discogs.com/release/${w.discogs_release_id}" rel="noopener noreferrer external" target="_blank">Discogs ${w.discogs_release_id} ↗</a>` : ""}</span>` : ""}</td>
              <td>${WANT_KIND_LABELS[w.want_kind]}${w.configuration_note ? html`<br><span class="small">${w.configuration_note}</span>` : ""}</td>
              <td class="hide-sm small">${[w.label, w.catno, w.format, w.year].filter(Boolean).join(" · ") || "—"}
                <form method="post" action="/wants/${w.id}/note" class="searchbar">${csrf(req)}<label for="f-wn-${w.id}" class="sr-only">Private note</label><input id="f-wn-${w.id}" name="note" value="${w.note ?? ""}" placeholder="Private note"><button class="btn btn-quiet btn-sm" type="submit">Save</button></form></td>
              <td>${w.for_sale == null ? html`<span class="muted small">Not linked to the archive</span>` : w.for_sale ? html`<a class="forsale" href="${w.edition_id ? `/editions/${w.edition_id}/offers` : `/releases/${w.release_id}#editions`}">${w.for_sale} for sale from ${money(w.min_price)}</a>` : html`<span class="archive-only">None for sale</span>`}</td>
              <td><form method="post" action="/wants/${w.id}/remove">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit">Remove</button></form></td></tr>`)}
          </tbody></table></div>`
          : html`<div class="empty"><h2>${q ? "No wants match" : "No wants yet"}</h2><p>Add one below, use “Want” on an archive page, or import a Discogs wantlist.</p></div>`}
        <h2>Add a want</h2>
        <form method="post" action="/wants/manual" class="form-narrow panel" novalidate>${csrf(req)}${errorSummary(errors)}
          ${selectField({ label: "What do you want?", name: "want_kind", value: values.want_kind, options: [
            { value: "any_format", label: "This music, any acceptable format" }, { value: "edition", label: "A specific edition" }, { value: "configuration", label: "A specific collectible configuration" }], errors, required: true })}
          <div class="grid-2">
            ${textField({ label: "Artist", name: "artist_text", value: values.artist_text, errors, required: true })}
            ${textField({ label: "Title", name: "title_text", value: values.title_text, errors, required: true })}
            ${textField({ label: "Label", name: "label_text", value: values.label_text, errors })}
            ${textField({ label: "Catalog number", name: "catno_text", value: values.catno_text, errors })}
            ${selectField({ label: "Format", name: "format_group", value: values.format_group, options: FORMAT_GROUPS.map((f) => ({ value: f, label: f })), blank: "Any", errors })}
            ${textField({ label: "Year", name: "release_year", value: values.release_year, errors, inputmode: "numeric" })}
          </div>
          ${textField({ label: "Configuration", name: "configuration_note", value: values.configuration_note, errors, hint: "For collectible wants: e.g. first press, black vinyl, with poster." })}
          ${textField({ label: "Private note", name: "note", value: values.note, errors })}
          <button class="btn btn-primary" type="submit">Add want</button></form>`,
    }, errors ? 422 : 200);
  };

  app.get("/wants", (req, res) => renderWants(req, res));

  app.post("/wants/manual", (req, res) => {
    const user = me(req);
    try {
      addManualWant(ctx.db, ctx.clock, user.id, req.body);
      addFlash(req, "success", "Added to your wantlist.");
      res.redirect(303, "/wants");
    } catch (e) {
      if (e instanceof ValidationError) return renderWants(req, res, req.body, e.fields);
      throw e;
    }
  });

  app.post("/wants", (req, res) => {
    const user = me(req);
    const editionId = req.body.edition_id ? Number(req.body.edition_id) : null;
    const releaseId = Number(req.body.release_id);
    addWant(ctx.db, ctx.clock, user.id, releaseId, editionId);
    addFlash(req, "success", editionId ? "Edition added to your wantlist." : "Release added to your wantlist (any edition).");
    res.redirect(303, editionId ? `/editions/${editionId}` : `/releases/${releaseId}`);
  });

  app.post("/wants/:id/note", (req, res) => {
    const user = me(req);
    updateWantNote(ctx.db, ctx.clock, user.id, idParam(req), req.body.note);
    addFlash(req, "success", "Note saved.");
    res.redirect(303, "/wants");
  });

  app.post("/wants/:id/remove", (req, res) => {
    const user = me(req);
    removeWant(ctx.db, user.id, idParam(req));
    addFlash(req, "success", "Removed from wantlist.");
    res.redirect(303, safeReturn(refererPath(req), "/wants"));
  });
}

export function safeReturn(v: unknown, fallback = "/library"): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") ? s : fallback;
}

function refererPath(req: Request): string | null {
  const ref = req.get("referer");
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return u.host === req.get("host") ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}
