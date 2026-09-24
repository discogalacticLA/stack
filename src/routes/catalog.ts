/**
 * Public catalog pages: Discover (browse), unified search, master pages (all versions),
 * release pages (one pressing), comparison, and copies for sale.
 */
import type { Express, Request } from "express";
import type { AppContext } from "../context.js";
import { hasRole } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { html, raw, type SafeHtml } from "../lib/html.js";
import { youtubeEmbedUrl, youtubeWatchUrl } from "../lib/mediaLinks.js";
import { COUNTRY_CODES, countryName, SOURCE_KINDS, VERIFICATION } from "../lib/reference.js";
import { asArray } from "../lib/validation.js";
import {
  browseCatalog, compareReleases, facetValues, formatDate, formatDuration, formatText, getMaster, getReleaseDetail, MAX_TEXT_CANDIDATES,
  type SearchParams, type SearchResult,
} from "../domain/catalog.js";
import { getPublicListing, offersForRelease, type OfferSort } from "../domain/listings.js";
import { hasWant } from "../domain/wants.js";
import { PAYLOAD_FIELD_LABELS } from "../domain/proposals.js";
import { unifiedSearch } from "../services/catalog-api/index.js";
import { copyPhoto, cover, csrf, grade, money, pagination, safeBack, statusBadge, verificationBadge } from "../views/components.js";
import { idParam, page } from "./helpers.js";

const PAGE_SIZE = 24;
const SORT_LABELS: Record<SearchParams["sort"], string> = {
  relevance: "Best match",
  title: "Title A–Z",
  artist: "Artist A–Z",
  year_asc: "Year (oldest first)",
  year_desc: "Year (newest first)",
  price_asc: "Lowest price for sale",
};

export function parseSearch(q: Request["query"]): SearchParams & { view: "grid" | "list" } {
  const int = (v: unknown) => (typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : null);
  const sort = String(q.sort ?? "relevance") as SearchParams["sort"];
  return {
    q: String(q.q ?? "").slice(0, 200),
    terms: asArray(q.term).slice(0, 20),
    termMode: q.mode === "all" ? "all" : "any",
    formats: asArray(q.format).slice(0, 10),
    countries: asArray(q.country).slice(0, 20).map((c) => c.slice(0, 60)),
    yearFrom: int(q.year_from),
    yearTo: int(q.year_to),
    forSale: q.sale === "1",
    sort: sort in SORT_LABELS ? sort : "relevance",
    page: Math.max(1, Math.min(500, Number(q.page) || 1)),
    pageSize: PAGE_SIZE,
    view: q.view === "list" ? "list" : "grid",
  };
}

function toQuery(p: ReturnType<typeof parseSearch>, overrides: Record<string, string | string[] | null> = {}): URLSearchParams {
  const u = new URLSearchParams();
  const set: Record<string, string | string[] | null> = {
    q: p.q || null, term: p.terms, mode: p.terms.length > 1 && p.termMode === "all" ? "all" : null, format: p.formats, country: p.countries,
    year_from: p.yearFrom ? String(p.yearFrom) : null, year_to: p.yearTo ? String(p.yearTo) : null, sale: p.forSale ? "1" : null,
    sort: p.sort !== "relevance" ? p.sort : null, view: p.view !== "grid" ? p.view : null, page: p.page > 1 ? String(p.page) : null, ...overrides,
  };
  for (const [k, v] of Object.entries(set)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
    else u.set(k, v);
  }
  return u;
}

const checkbox = (name: string, value: string, label: string, checked: boolean) =>
  html`<label class="check"><input type="checkbox" name="${name}" value="${value}"${checked ? raw(" checked") : ""}> <span>${label}</span></label>`;

function resultHref(r: SearchResult, back: string) {
  const u = new URLSearchParams({ back });
  if (r.kind === "release") return `/releases/${r.id}?${u}`;
  r.matched_release_ids.forEach((id) => u.append("e", String(id)));
  return `/masters/${r.id}?${u}`;
}

function releaseLine(e: SearchResult["primary_release"]) {
  return [e.label ?? "Label unknown", e.catalog_number ?? "no cat. no.", [e.format, e.format_details].filter(Boolean).join(" "), e.country ?? "country ?", e.year ?? "year ?"].join(" · ");
}

function saleText(r: { for_sale_count: number; min_price_cents: number | null }): SafeHtml {
  return r.for_sale_count
    ? html`<span class="forsale">${r.for_sale_count} for sale</span> <span class="muted">from ${money(r.min_price_cents)}</span>`
    : html`<span class="archive-only">Catalog only · none for sale</span>`;
}

export function registerCatalogRoutes(app: Express, ctx: AppContext) {
  // ───────────────────────── Unified search (one box, clear result types) ─────────────────────────
  app.get("/search", (req, res) => {
    const q = String(req.query.q ?? "").slice(0, 200);
    const results = q ? unifiedSearch(ctx.db, q, { limit: 40 }) : [];
    const label: Record<string, string> = { artist: "Artist", label: "Label", master: "Master", release: "Release" };
    page(req, res, {
      title: q ? `Search: ${q}` : "Search",
      nav: "discover",
      body: html`<h1>Search the catalog</h1>
        <form method="get" action="/search" class="searchbar" role="search"><label for="f-sq" class="sr-only">Search</label>
          <input id="f-sq" type="search" name="q" value="${q}" placeholder="Artist, title, label, catalog number or barcode">
          <button class="btn btn-primary" type="submit">Search</button></form>
        ${q ? results.length
          ? html`<ul class="plain search-results">${results.map((r) => html`<li class="panel"><span class="badge">${label[r.type]}</span>
              <a href="${r.url}"><strong>${r.title}</strong></a>${r.artist ? html` — ${r.artist}` : ""}
              <span class="muted small">${[r.year, r.country, r.label, r.catalog_number, r.format].filter(Boolean).join(" · ")}</span></li>`)}</ul>`
          : html`<div class="empty"><h2>Nothing found for “${q}”</h2><p>Try fewer words, or a catalog number without spaces.</p></div>`
          : html`<p class="muted">Searches artists, masters, releases, labels, catalog numbers and barcodes. Use <a href="/discover">Discover</a> to browse with filters.</p>`}`,
    });
  });

  // ───────────────────────── Discover ─────────────────────────
  app.get("/discover", (req, res) => {
    const p = parseSearch(req.query);
    const { total, results, truncated } = browseCatalog(ctx.db, p);
    const facets = facetValues(ctx.db);
    const selfUrl = `/discover?${toQuery(p)}`;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const filtersActive = p.terms.length + p.formats.length + p.countries.length + (p.yearFrom ? 1 : 0) + (p.yearTo ? 1 : 0) + (p.forSale ? 1 : 0);

    const chips: SafeHtml[] = [];
    const chip = (label: string, overrides: Record<string, string | string[] | null>) =>
      chips.push(html`<a class="chip" href="/discover?${toQuery(p, { ...overrides, page: null })}" aria-label="Remove filter: ${label}">${label} <span aria-hidden="true">×</span></a>`);
    if (p.q) chip(`Search: “${p.q}”`, { q: null });
    p.terms.forEach((t) => chip(`Genre/style: ${t}`, { term: p.terms.filter((x) => x !== t) }));
    p.formats.forEach((f) => chip(`Format: ${f}`, { format: p.formats.filter((x) => x !== f) }));
    p.countries.forEach((c) => chip(`Country: ${countryName(c)}`, { country: p.countries.filter((x) => x !== c) }));
    if (p.yearFrom) chip(`From ${p.yearFrom}`, { year_from: null });
    if (p.yearTo) chip(`To ${p.yearTo}`, { year_to: null });
    if (p.forSale) chip("Only with copies for sale", { sale: null });

    const resultsHtml = results.length
      ? p.view === "grid"
        ? html`<ul class="results-grid" data-restore-scroll>${results.map((r) => html`<li class="card"><a class="card-link" href="${resultHref(r, selfUrl)}">
              ${cover(r.image_id, `${r.artist} – ${r.title}`)}
              <span class="meta"><span class="t">${r.title}</span><span class="a">${r.artist}</span>
              <span class="d">${releaseLine(r.primary_release)}</span>
              <span class="d">${r.kind === "master" ? `${r.version_count} version${r.version_count === 1 ? "" : "s"}${r.matched_release_ids.length < r.version_count ? ` · ${r.matched_release_ids.length} match` : ""}` : "Single release (no master)"}</span>
              <span class="sale">${saleText(r)}</span></span></a></li>`)}</ul>`
        : html`<div class="table-wrap" data-restore-scroll><table class="compact"><thead><tr><th><span class="sr-only">Artwork</span></th><th>Artist — Title</th><th>Label</th><th>Cat. no.</th><th class="hide-sm">Format</th><th class="hide-sm">Country</th><th>Year</th><th class="hide-sm">Versions</th><th>Market</th></tr></thead><tbody>
            ${results.map((r) => html`<tr>
              <td>${cover(r.image_id, r.title, { size: "sm" })}</td>
              <td><a href="${resultHref(r, selfUrl)}"><strong>${r.artist}</strong> — ${r.title}</a></td>
              <td>${r.primary_release.label ?? html`<span class="muted">Unknown</span>`}</td>
              <td><span class="catno">${r.primary_release.catalog_number ?? "—"}</span></td>
              <td class="hide-sm">${[r.primary_release.format, r.primary_release.format_details].filter(Boolean).join(" ")}</td>
              <td class="hide-sm">${r.primary_release.country ?? html`<span class="muted">?</span>`}</td>
              <td>${r.earliest_year ?? html`<span class="muted">?</span>`}</td>
              <td class="hide-sm">${r.matched_release_ids.length}/${r.version_count}</td>
              <td class="small">${saleText(r)}</td></tr>`)}
          </tbody></table></div>`
      : html`<div class="empty">
          <h2>Nothing matches</h2>
          ${p.terms.length > 1 && p.termMode === "all" ? html`<p>You asked for releases tagged with <strong>all</strong> of: ${p.terms.join(", ")}. Try <a href="/discover?${toQuery(p, { mode: null, page: null })}">matching any of them</a> instead.</p>` : ""}
          ${p.forSale ? html`<p>You're only seeing releases with copies for sale. <a href="/discover?${toQuery(p, { sale: null, page: null })}">Include catalog-only entries</a>.</p>` : ""}
          ${filtersActive ? html`<p>Remove a filter above, or <a href="/discover?${toQuery(p, { term: [], format: [], country: [], year_from: null, year_to: null, sale: null, mode: null, page: null })}">reset all filters</a> and keep your search.</p>` : ""}
          ${p.q ? html`<p class="muted">Search matches artist, title, label and catalog number. Catalog numbers match with or without spaces and dashes.</p>` : ""}
        </div>`;

    page(req, res, {
      title: p.q ? `“${p.q}”` : "Discover",
      nav: "discover",
      wide: true,
      body: html`<form method="get" action="/discover" id="discover-form" class="discover">
        <aside class="filters" aria-label="Filters">
          <h2 class="sr-only">Filters</h2>
          <fieldset>
            <legend>Genre &amp; style</legend>
            <div class="opts">${facets.genres.map((t) => checkbox("term", t, t, p.terms.includes(t)))}<hr>${facets.styles.map((t) => checkbox("term", t, t, p.terms.includes(t)))}</div>
            <p class="legend" id="mode-label">When several are selected, show releases that have:</p>
            <div role="radiogroup" aria-labelledby="mode-label">
              <label class="check"><input type="radio" name="mode" value="any"${p.termMode === "any" ? raw(" checked") : ""}> <span><strong>Any</strong> of them (broader)</span></label>
              <label class="check"><input type="radio" name="mode" value="all"${p.termMode === "all" ? raw(" checked") : ""}> <span><strong>All</strong> of them (narrower)</span></label>
            </div>
          </fieldset>
          <fieldset><legend>Format</legend>${facets.formats.map((f) => checkbox("format", f, f, p.formats.includes(f)))}<p class="explain">Any selected format matches.</p></fieldset>
          <fieldset><legend>Country</legend><div class="opts">${facets.countries.map((c) => checkbox("country", c, countryName(c), p.countries.includes(c)))}</div>
            <p class="explain">Any selected country matches. Releases with unknown country are excluded when a country is chosen.</p></fieldset>
          <fieldset><legend>Year</legend>
            <div class="grid-2">
              <div class="field"><label for="f-year_from">From</label><input id="f-year_from" name="year_from" inputmode="numeric" pattern="[0-9]{4}" value="${p.yearFrom ?? ""}" placeholder="1990"></div>
              <div class="field"><label for="f-year_to">To</label><input id="f-year_to" name="year_to" inputmode="numeric" pattern="[0-9]{4}" value="${p.yearTo ?? ""}" placeholder="2024"></div>
            </div><p class="explain">Releases with an unknown year are excluded when a year is set.</p></fieldset>
          <fieldset><legend>Availability</legend>
            <label class="check"><input type="radio" name="sale" value=""${!p.forSale ? raw(" checked") : ""}> <span>Whole catalog</span></label>
            <label class="check"><input type="radio" name="sale" value="1"${p.forSale ? raw(" checked") : ""}> <span>Only releases with copies for sale</span></label></fieldset>
          <p class="explain">Different filter groups combine: a result must satisfy every group you use.</p>
          <input type="hidden" name="view" value="${p.view}">
          <div class="actions"><button class="btn" type="submit">Apply filters</button>
          ${filtersActive || p.q ? html`<a class="btn btn-quiet" href="/discover${p.view === "list" ? "?view=list" : ""}">Clear all</a>` : ""}</div>
        </aside>
        <section aria-labelledby="results-heading">
          <div class="searchbar" role="search">
            <label for="f-q" class="sr-only">Search the catalog</label>
            <input id="f-q" type="search" name="q" value="${p.q}" placeholder="Artist, title, label or catalog number (e.g. LLR 004)">
            <button class="btn btn-primary" type="submit">Search</button>
          </div>
          ${chips.length ? html`<div class="active-filters" aria-label="Active filters">${chips}${chips.length > 1 ? html`<a class="chip" href="/discover${p.view === "list" ? "?view=list" : ""}">Clear all</a>` : ""}</div>` : ""}
          ${truncated ? html`<p class="small uncertain">Showing results from the ${MAX_TEXT_CANDIDATES.toLocaleString()} best text matches. Add words or filters to narrow it down.</p>` : ""}
          <div class="toolbar">
            <div class="left"><h1 id="results-heading" class="h-results">${total} result${total === 1 ? "" : "s"}${p.forSale ? " with copies for sale" : ""}</h1></div>
            <div class="right">
              <label for="f-sort" class="small">Sort</label>
              <select id="f-sort" name="sort">${Object.entries(SORT_LABELS).map(([k, v]) => html`<option value="${k}"${k === p.sort ? raw(" selected") : ""}>${v}</option>`)}</select>
              <button class="btn btn-quiet btn-sm" type="submit">Sort</button>
              <span class="segmented" aria-label="View"><a href="/discover?${toQuery(p, { view: null })}" aria-current="${p.view === "grid"}">Artwork</a><a href="/discover?${toQuery(p, { view: "list" })}" aria-current="${p.view === "list"}">Compact list</a></span>
            </div>
          </div>
          ${resultsHtml}
          ${pagination("/discover", toQuery(p, { page: null }), p.page, total, PAGE_SIZE)}
          ${p.page > pages ? html`<p><a href="/discover?${toQuery(p, { page: null })}">Go to the first page</a></p>` : ""}
        </section>
      </form>`,
    });
  });

  // Old URLs from before the master/release rename.
  app.get("/editions/:id", (req, res) => res.redirect(301, `/releases/${idParam(req)}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`));
  app.get("/editions/:id/offers", (req, res) => res.redirect(301, `/releases/${idParam(req)}/offers`));

  // ───────────────────────── Master (all versions) ─────────────────────────
  app.get("/masters/:id", (req, res) => {
    const m = getMaster(ctx.db, idParam(req));
    if (!m) throw notFound("Master");
    const back = safeBack(req.query.back, "");
    const matched = new Set(asArray(req.query.e).map(Number));
    const user = req.state.user;
    const wantId = user ? hasWant(ctx.db, user.id, m.id, null) : null;
    const withBack = (path: string) => (back ? `${path}?back=${encodeURIComponent(back)}` : path);
    page(req, res, {
      title: `${m.artist} – ${m.title}`,
      nav: "discover",
      body: html`
        <nav class="crumbs" aria-label="Breadcrumb">${back ? html`<a href="${back}">← Back to results</a> <span aria-hidden="true">/</span>` : html`<a href="/discover">Discover</a> /`} <span>Master</span></nav>
        <p class="muted small">${m.release_type ? `${String(m.release_type).toUpperCase()} · ` : ""}Master — the shared identity of this music across all its versions</p>
        <h1>${m.title}</h1>
        <p class="lead"><strong>${m.artists.map((a: any) => html`${a.id ? html`<a href="/artists/${a.id}">${a.name}</a>` : a.name}${a.join_text}`)}</strong>${m.year ? ` · ${m.year}` : ""}</p>
        <p>${[...m.genres, ...m.styles].map((t: string) => html`<a class="chip" href="/discover?term=${encodeURIComponent(t)}">${t}</a> `)}</p>
        ${m.description ? html`<p>${m.description}</p>` : ""}
        ${m.discogs_master_id ? html`<p class="small muted">Discogs master ${m.discogs_master_id} · <a href="https://www.discogs.com/master/${m.discogs_master_id}" rel="noopener noreferrer external" target="_blank">view on Discogs ↗</a> (catalog data from the Discogs monthly dump, CC0)</p>` : ""}
        <div class="action-row">
          ${user ? wantId
              ? html`<form method="post" action="/wants/${wantId}/remove" class="inline">${csrf(req)}<button class="btn btn-quiet" type="submit">★ In your wantlist (any version) — remove</button></form>`
              : html`<form method="post" action="/wants" class="inline">${csrf(req)}<input type="hidden" name="master_id" value="${m.id}"><button class="btn btn-quiet" type="submit">☆ Want (any version)</button></form>`
            : html`<a class="btn btn-quiet" href="/login?return_to=${encodeURIComponent(req.originalUrl)}">Sign in to add wants or copies</a>`}
          ${hasRole(user, "contributor") ? html`<a class="btn btn-quiet" href="/contribute/new-edition?master_id=${m.id}">Propose a missing version</a>` : ""}
        </div>
        <h2 id="versions">Versions (${m.releases.length})</h2>
        <p class="muted small">Each version is a specific release (pressing or issue). Select two or more to compare side by side. ${matched.size ? "Highlighted rows matched your search." : ""}</p>
        <form method="get" action="/compare">
          ${back ? html`<input type="hidden" name="back" value="${back}">` : ""}
          <div class="table-wrap"><table class="compact">
            <thead><tr><th><span class="sr-only">Compare</span></th><th>Cat. no.</th><th>Label</th><th>Format</th><th>Country</th><th>Date</th><th class="hide-sm">Tracks</th><th>Status</th><th>For sale</th></tr></thead>
            <tbody>${m.releases.map((e: any) => html`<tr${matched.has(e.id) ? raw(' class="matched"') : ""}>
              <td><label class="check"><input type="checkbox" name="ids" value="${e.id}"><span class="sr-only">Compare release ${e.catalog_number ?? e.id}</span></label></td>
              <td><a href="${withBack(`/releases/${e.id}`)}"><span class="catno">${e.catalog_number ?? "none / unknown"}</span></a>${matched.has(e.id) ? html` <span class="badge">match</span>` : ""}</td>
              <td>${e.label ?? html`<span class="muted">Unknown</span>`}</td>
              <td>${e.format}${e.format_details ? html` <span class="muted">${e.format_details}</span>` : ""}</td>
              <td>${e.country ? countryName(e.country) : html`<span class="uncertain">Unknown</span>`}</td>
              <td>${e.year ? formatDate(e) : html`<span class="uncertain">Unknown</span>`}${e.date_note ? html` <span title="${e.date_note}" class="muted">(note)</span>` : ""}</td>
              <td class="hide-sm">${e.track_count}</td>
              <td>${verificationBadge(e.verification_status)}</td>
              <td>${e.for_sale_count ? html`<a class="forsale" href="/releases/${e.id}/offers">${e.for_sale_count} from ${money(e.min_price_cents)}</a>` : html`<span class="archive-only">None</span>`}</td>
            </tr>`)}</tbody>
          </table></div>
          <div class="actions"><button class="btn" type="submit">Compare selected versions</button></div>
        </form>`,
    });
  });

  // ───────────────────────── Release (one pressing) ─────────────────────────
  app.get("/releases/:id", (req, res) => {
    const d = getReleaseDetail(ctx.db, idParam(req));
    if (!d) throw notFound("Release");
    const { release: e, master: m } = d;
    const user = req.state.user;
    const back = safeBack(req.query.back, "");
    const wantId = user ? hasWant(ctx.db, user.id, e.master_id, e.id) : null;
    const v = VERIFICATION[e.verification_status];
    const barcodes = d.identifiers.filter((i) => i.identifier_type === "Barcode");
    const credits = new Map<string, any[]>();
    for (const c of d.credits) credits.set(c.role || "Credit", [...(credits.get(c.role || "Credit") ?? []), c]);
    page(req, res, {
      title: `${e.title} (${e.catalog_number ?? "release"})`,
      nav: "discover",
      body: html`
        <nav class="crumbs" aria-label="Breadcrumb">
          ${back ? html`<a href="${back}">← Back to results</a> <span aria-hidden="true">/</span>` : html`<a href="/discover">Discover</a> <span aria-hidden="true">/</span>`}
          ${m ? html`<a href="/masters/${m.id}${back ? `?back=${encodeURIComponent(back)}` : ""}">${m.title}</a> <span aria-hidden="true">/</span>` : ""} <span>Release ${e.catalog_number ?? ""}</span>
        </nav>
        <div class="detail">
          <div>
            ${d.images.length
              ? html`${cover(d.images[0].id, `${e.title} ${d.images[0].kind}`, { size: "lg", lazy: false })}
                <p class="image-kind">Catalog image · ${d.images[0].kind} · ${d.images[0].attribution}</p>
                ${d.images.length > 1 ? html`<div class="gallery">${d.images.slice(1).map((im) => html`<div>${cover(im.id, `${e.title} ${im.kind}`, { size: "sm" })}<p class="image-kind">${im.kind}</p></div>`)}</div>` : ""}`
              : html`${cover(null, e.title, { size: "lg" })}<p class="image-kind">No catalog image is available for this release.</p>`}
            <p class="muted small">Catalog images show the release in general. Photos of individual copies appear only on listings.</p>
          </div>
          <div>
            <p class="muted small">${m ? html`Version of <a href="/masters/${m.id}">${m.artist} — ${m.title}</a> · ${m.releases.length} version${m.releases.length === 1 ? "" : "s"} known` : "Release without a master (no other versions grouped)"}</p>
            <h1>${e.title} <span class="catno">${e.catalog_number ?? "no cat. no."}</span></h1>
            <p><strong>${d.artists.map((a: any) => html`${a.id ? html`<a href="/artists/${a.id}">${a.name}</a>` : a.name}${a.join_text}`)}</strong></p>
            <p>${verificationBadge(e.verification_status)} <span class="muted small">${v.explain}</span></p>
            ${d.pendingProposals ? html`<p class="small"><span class="badge status-pending">${d.pendingProposals} pending correction${d.pendingProposals === 1 ? "" : "s"}</span> awaiting moderator review.</p>` : ""}
            <dl class="facts">
              <dt>Label${d.labels.length > 1 ? "s" : ""}</dt><dd>${d.labels.length ? d.labels.map((l) => html`${l.label_id ? html`<a href="/labels/${l.label_id}">${l.name}</a>` : l.name} ${l.catalog_number ? html`<span class="catno">${l.catalog_number}</span>` : ""}<br>`) : e.label ? e.label : html`<span class="uncertain">Unknown</span>`}</dd>
              <dt>Format</dt><dd>${d.formats.length ? d.formats.map((f) => html`${formatText(f)}<br>`) : `${e.format}${e.format_details ? `, ${e.format_details}` : ""}`}</dd>
              <dt>Country</dt><dd>${e.country ? countryName(e.country) : html`<span class="uncertain">Unknown</span>`}</dd>
              <dt>Released</dt><dd>${e.year || e.released_date ? formatDate(e) : html`<span class="uncertain">Unknown</span>`}${e.date_note ? html`<br><span class="uncertain small">${e.date_note}</span>` : ""}</dd>
              <dt>Genre / style</dt><dd>${[...d.genres, ...d.styles].join(", ") || "—"}</dd>
              ${barcodes.length ? html`<dt>Barcode</dt><dd>${barcodes.map((i) => html`<span class="mono">${i.value}</span>${i.description ? html` <span class="muted small">${i.description}</span>` : ""}<br>`)}</dd>` : ""}
              ${e.data_quality ? html`<dt>Data quality</dt><dd>${e.data_quality} <span class="muted small">(as rated in the source)</span></dd>` : ""}
            </dl>
            ${e.notes ? html`<div class="panel"><h3>Notes</h3><p class="prewrap">${e.notes}</p></div>` : ""}
            <div class="action-row" aria-label="Actions for this release">
              ${user ? html`<a class="btn" href="/collection/add?release_id=${e.id}">+ Add to collection</a>` : html`<a class="btn" href="/login?return_to=${encodeURIComponent(req.originalUrl)}">Sign in to collect, want or buy</a>`}
              ${user ? wantId
                  ? html`<form method="post" action="/wants/${wantId}/remove" class="inline">${csrf(req)}<button class="btn btn-quiet" type="submit">★ Wanted — remove</button></form>`
                  : html`<form method="post" action="/wants" class="inline">${csrf(req)}<input type="hidden" name="release_id" value="${e.id}"><button class="btn btn-quiet" type="submit">☆ Want this release</button></form>`
                : ""}
              ${e.for_sale_count
                ? html`<a class="btn btn-primary" href="/releases/${e.id}/offers">View ${e.for_sale_count} cop${e.for_sale_count === 1 ? "y" : "ies"} for sale · from ${money(e.min_price_cents)}</a>`
                : html`<span class="btn btn-quiet" aria-disabled="true">No copies for sale</span>`}
              ${m && m.releases.length > 1 ? html`<a class="btn btn-quiet" href="/compare?${m.releases.map((x: any) => `ids=${x.id}`).join("&")}">Compare all ${m.releases.length} versions</a>` : ""}
            </div>
            ${d.unavailable.length ? html`<p class="muted small">Not shown as for sale: ${d.unavailable.map((u) => `${u.n} ${u.status}`).join(", ")}.</p>` : ""}
            ${d.discogsUrl ? html`<p class="small muted">Discogs release ${e.discogs_release_id} · <a href="${d.discogsUrl}" rel="noopener noreferrer external" target="_blank">view on Discogs ↗</a></p>` : ""}
          </div>
        </div>

        <h2>Track listing <span class="muted small">(this release)</span></h2>
        ${d.tracks.length
          ? html`<div class="table-wrap"><table class="tracklist compact"><tbody>${d.tracks.map((t) => t.track_type === "heading"
              ? html`<tr><td></td><td colspan="2"><strong>${t.title}</strong></td></tr>`
              : html`<tr${t.track_type === "subtrack" ? raw(' class="subtrack"') : ""}><td>${t.position}</td><td>${t.track_type === "subtrack" ? "↳ " : ""}${t.title}${t.artist_credit ? html` <span class="muted">— ${t.artist_credit}</span>` : ""}</td><td class="num">${t.duration ?? formatDuration(t.duration_seconds)}</td></tr>`)}</tbody></table></div>`
          : html`<p class="uncertain">No track listing recorded for this release yet.</p>`}

        ${d.credits.length ? html`<h2>Credits</h2><dl class="facts">${[...credits.entries()].map(([role, list]) => html`<dt>${role}</dt><dd>${list.map((c: any, i: number) => html`${i ? ", " : ""}${c.artist_id ? html`<a href="/artists/${c.artist_id}">${c.anv || c.name}</a>` : c.anv || c.name}${c.tracks ? html` <span class="muted small">(${c.tracks})</span>` : ""}`)}</dd>`)}</dl>` : ""}
        ${d.companies.length ? html`<h2>Companies</h2><dl class="facts">${d.companies.map((c) => html`<dt>${c.role}</dt><dd>${c.company_id ? html`<a href="/companies/${c.company_id}">${c.name ?? "?"}</a>` : c.name ?? "?"}${c.catalog_number ? html` <span class="catno">${c.catalog_number}</span>` : ""}</dd>`)}</dl>` : ""}

        ${d.mediaLinks.length ? html`<h2>Listen elsewhere</h2>
          <p class="muted small">External YouTube videos linked by contributors or listed in the catalog source. This site does not host audio and cannot confirm an upload is authorised by the rights holders. Nothing loads from YouTube until you press Preview.</p>
          <div class="listen">${d.mediaLinks.map((ml) => html`<div class="listen-item">
            <strong>${ml.title ?? (ml.track_position ? `Track ${ml.track_position}` : "Whole record")}</strong>
            <span class="actions">
              <button type="button" class="btn btn-quiet btn-sm" data-embed-src="${youtubeEmbedUrl(ml.external_id)}" data-embed-title="YouTube preview ${ml.track_position ?? ""}">▶ Preview on YouTube (loads youtube-nocookie.com)</button>
              <a href="${youtubeWatchUrl(ml.external_id)}" rel="noopener noreferrer external" target="_blank">Open on YouTube ↗</a>
            </span></div>`)}</div>` : ""}

        <h2>Identifiers</h2>
        ${d.identifiers.length
          ? html`<div class="table-wrap"><table class="compact"><tbody>${d.identifiers.map((i) => html`<tr><th scope="row">${i.identifier_type}</th><td class="mono">${i.value}</td><td class="muted">${i.description ?? ""}</td></tr>`)}</tbody></table></div>`
          : html`<p class="uncertain">No identifiers recorded. Runout etchings and barcodes help tell releases apart.</p>`}

        <h2>Sources</h2>
        ${d.sources.length
          ? html`<ul>${d.sources.map((s) => html`<li><strong>${SOURCE_KINDS[s.kind]}:</strong> ${s.citation}${s.url ? html` — <a href="${s.url}" rel="noopener noreferrer nofollow">${s.url}</a>` : ""} <span class="muted small">(added by ${s.added_by_name ?? "system"}, ${s.created_at.slice(0, 10)})</span></li>`)}</ul>`
          : d.discogsUrl ? html`<p class="small">Imported from the Discogs monthly data dump (CC0). No additional sources cited here.</p>` : html`<p class="uncertain">No sources cited. Details on this page are unverified.</p>`}

        <h2>Revision history</h2>
        ${d.revisions.length
          ? html`<ol class="small">${d.revisions.map((rv) => html`<li><strong>${rv.summary}</strong> — proposed by ${rv.proposed_by_name ?? "system"}, accepted by ${rv.accepted_by_name ?? "seed import"} on ${rv.created_at.slice(0, 10)}
              ${(() => {
                const ch = JSON.parse(rv.changes) as { field: keyof typeof PAYLOAD_FIELD_LABELS; before: unknown; after: unknown }[];
                return ch.length && rv.proposal_id
                  ? html`<details><summary>What changed (${ch.length})</summary><ul>${ch.map((c) => html`<li>${PAYLOAD_FIELD_LABELS[c.field] ?? c.field}: <del>${String(c.before ?? "—")}</del> → <ins>${String(c.after ?? "—")}</ins></li>`)}</ul></details>`
                  : "";
              })()}</li>`)}</ol>`
          : html`<p class="muted">No local revisions recorded.</p>`}
        ${hasRole(user, "contributor") && e.master_id
          ? html`<div class="actions"><a class="btn btn-quiet" href="/contribute/correction?release_id=${e.id}">Propose a correction</a></div>`
          : user && !hasRole(user, "contributor") ? html`<p class="muted small">Catalog corrections require the contributor role.</p>` : ""}
      `,
    });
  });

  // ───────────────────────── Compare releases ─────────────────────────
  app.get("/compare", (req, res) => {
    const ids = [...new Set(asArray(req.query.ids).flatMap((s) => s.split(",")).map(Number).filter((n) => n > 0))].slice(0, 6);
    const back = safeBack(req.query.back, "");
    if (ids.length < 2) {
      return page(req, res, { title: "Compare releases", body: html`<div class="empty"><h1>Choose at least two releases</h1><p>Open a master and tick two or more versions to compare them side by side.</p>
        ${back ? html`<p><a class="btn btn-quiet" href="${back}">Back to results</a></p>` : ""}</div>` }, 422);
    }
    const onlyDiff = req.query.only_diff === "1";
    const { releases, rows, trackRows } = compareReleases(ctx.db, ids);
    if (releases.length < 2) throw notFound("Release");
    const differing = rows.filter((r) => r.differs).length;
    const toggleQ = new URLSearchParams();
    ids.forEach((i) => toggleQ.append("ids", String(i)));
    if (back) toggleQ.set("back", back);
    if (!onlyDiff) toggleQ.set("only_diff", "1");
    const renderRows = (list: typeof rows) => list.filter((r) => !onlyDiff || r.differs).map((r) => html`<tr><th scope="row">${r.field}</th>${r.values.map((v) => html`<td class="${r.differs ? "differs" : ""}">${v}</td>`)}</tr>`);
    const m = releases[0].master;
    page(req, res, {
      title: "Compare releases",
      wide: true,
      body: html`
        <nav class="crumbs">${back ? html`<a href="${back}">← Back to results</a> /` : ""} ${m ? html`<a href="/masters/${m.id}">${m.title}</a> /` : ""} <span>Compare</span></nav>
        <h1>Compare ${releases.length} releases</h1>
        <p><span class="legend-diff">≠ Highlighted</span> cells differ. ${differing} of ${rows.length} fields differ. <a href="/compare?${toggleQ}">${onlyDiff ? "Show all fields" : "Show only differences"}</a></p>
        <div class="table-wrap"><table class="compare">
          <thead><tr><th scope="col">Field</th>${releases.map((e) => html`<th scope="col"><a href="/releases/${e.release.id}"><span class="catno">${e.release.catalog_number ?? "no cat. no."}</span></a><br>${verificationBadge(e.release.verification_status)}</th>`)}</tr></thead>
          <tbody>${renderRows(rows)}</tbody>
        </table></div>
        <h2>Track listings</h2>
        <p class="muted small">Aligned by position. Different releases can have different track listings.</p>
        <div class="table-wrap"><table class="compare compact">
          <thead><tr><th scope="col">Pos.</th>${releases.map((e) => html`<th scope="col">${e.release.catalog_number ?? "no cat. no."}</th>`)}</tr></thead>
          <tbody>${trackRows.length ? renderRows(trackRows) : html`<tr><td colspan="${releases.length + 1}">No track listings recorded.</td></tr>`}</tbody>
        </table></div>
        <div class="actions">${releases.map((e) => (e.release.for_sale_count ? html`<a class="btn btn-quiet" href="/releases/${e.release.id}/offers">${e.release.catalog_number}: ${e.release.for_sale_count} for sale</a>` : ""))}</div>`,
    });
  });

  // ───────────────────────── Copies for sale ─────────────────────────
  app.get("/releases/:id/offers", (req, res) => {
    const d = getReleaseDetail(ctx.db, idParam(req));
    if (!d) throw notFound("Release");
    const e = d.release;
    const user = req.state.user;
    const destRaw = req.query.dest === undefined ? (user?.country ?? "") : String(req.query.dest);
    const dest = COUNTRY_CODES.includes(destRaw) ? destRaw : null;
    const sort = (["total", "price", "condition"].includes(String(req.query.sort)) ? String(req.query.sort) : "total") as OfferSort;
    const offers = offersForRelease(ctx.db, e.id, dest, sort);
    const inCart = new Set(user ? (ctx.db.prepare("SELECT listing_id FROM cart_items WHERE user_id = ?").all(user.id) as any[]).map((r) => r.listing_id) : []);
    page(req, res, {
      title: `Copies for sale · ${e.title}`,
      nav: "discover",
      body: html`
        <nav class="crumbs">${d.master ? html`<a href="/masters/${d.master.id}">${d.master.title}</a> /` : ""} <a href="/releases/${e.id}">Release <span class="catno">${e.catalog_number ?? ""}</span></a> / <span>For sale</span></nav>
        <h1>Copies for sale</h1>
        <p><strong>${d.credit} — ${e.title}</strong> · <span class="catno">${e.catalog_number ?? "no cat. no."}</span> · ${e.label ?? "label unknown"} · ${e.format} ${e.format_details ?? ""} · ${countryName(e.country)}</p>
        <p class="muted small">Each listing is one specific physical copy. Condition grades and photos describe that copy, not the release in general.</p>
        <form method="get" class="toolbar panel">
          <div class="left">
            <label for="f-dest">Ship to</label>
            <select id="f-dest" name="dest"><option value="">Choose destination…</option>${COUNTRY_CODES.map((c) => html`<option value="${c}"${c === dest ? raw(" selected") : ""}>${countryName(c)}</option>`)}</select>
            <label for="f-osort">Sort by</label>
            <select id="f-osort" name="sort">
              <option value="total"${sort === "total" ? raw(" selected") : ""}>Delivered total</option>
              <option value="price"${sort === "price" ? raw(" selected") : ""}>Item price</option>
              <option value="condition"${sort === "condition" ? raw(" selected") : ""}>Best condition</option>
            </select>
            <button class="btn btn-sm" type="submit">Update</button>
          </div>
          <p class="estimate">Totals are estimates in USD (demo currency). Taxes, duties and customs fees are <strong>not included</strong>.</p>
        </form>
        ${offers.length
          ? html`<div class="offers">${offers.map((o) => html`<article class="offer" aria-labelledby="offer-${o.id}">
              <div class="photo-row">${o.photo_ids.length ? o.photo_ids.slice(0, 2).map((pid) => copyPhoto(pid, `listing ${o.id}`, "sm")) : html`<p class="muted small">Seller has not added photos of this copy.</p>`}</div>
              <div>
                <h3 id="offer-${o.id}"><a href="/listings/${o.id}">Media ${grade(o.media_condition)} · Sleeve ${grade(o.sleeve_condition)}</a></h3>
                <p>${o.condition_description}</p>
                <p class="small">Seller: <strong>${o.seller.display_name}</strong> · ships from ${countryName(o.shipping_profile.origin_country)} · ${o.seller.completed_orders} completed simulated order${o.seller.completed_orders === 1 ? "" : "s"} · member since ${o.seller.member_since}</p>
              </div>
              <div>
                <p class="price">${money(o.price_cents)}</p>
                ${o.shipping.ok
                  ? html`<p class="small">+ ${money(o.shipping.cents)} shipping <span class="estimate">(${o.shipping.zone} rate)</span></p><p class="total">≈ ${money(o.total_cents)} delivered <span class="estimate">est., excl. taxes</span></p>`
                  : html`<p class="small uncertain">${o.shipping.reason}</p><p class="estimate">No delivered total shown.</p>`}
                ${user?.id === o.seller.id ? html`<p class="muted small">This is your listing.</p>`
                  : inCart.has(o.id) ? html`<a class="btn btn-quiet" href="/cart">In cart — view cart</a>`
                  : html`<form method="post" action="/cart/add">${csrf(req)}<input type="hidden" name="listing_id" value="${o.id}"><button class="btn btn-primary" type="submit"${!user ? raw(" disabled") : ""}>Add to cart</button></form>${!user ? html`<p class="small"><a href="/login?return_to=${encodeURIComponent(req.originalUrl)}">Sign in to buy</a></p>` : ""}`}
              </div>
            </article>`)}</div>`
          : html`<div class="empty"><h2>No copies of this release are for sale</h2><p>Add it to your wantlist to find it later, or check other versions.</p>
              ${d.master ? html`<p><a class="btn btn-quiet" href="/masters/${d.master.id}#versions">See other versions</a></p>` : ""}</div>`}
        ${d.unavailable.length ? html`<p class="muted small">${d.unavailable.map((u) => `${u.n} ${u.status}`).join(", ")} cop${d.unavailable.reduce((a, b) => a + b.n, 0) === 1 ? "y" : "ies"} not shown (not purchasable).</p>` : ""}`,
    });
  });

  // ───────────────────────── Single public listing ─────────────────────────
  app.get("/listings/:id", (req, res) => {
    const l = getPublicListing(ctx.db, idParam(req));
    if (!l) throw notFound("Listing");
    const user = req.state.user;
    page(req, res, {
      title: `${l.title} — listing #${l.id}`,
      body: html`
        <nav class="crumbs"><a href="/releases/${l.release_id}">Release <span class="catno">${l.catalog_number ?? ""}</span></a> / <a href="/releases/${l.release_id}/offers">All copies for sale</a> / <span>Listing #${l.id}</span></nav>
        <h1>${l.artist} — ${l.title}</h1>
        <p>${statusBadge(l.status)} <span class="catno">${l.catalog_number ?? "no cat. no."}</span> · ${l.label ?? "label unknown"} · ${l.format} · ${countryName(l.country)} · ${l.year ?? "year unknown"}</p>
        <div class="detail">
          <div class="photo-row">${l.photo_ids.length ? l.photo_ids.map((p) => copyPhoto(p, `listing ${l.id}`, "lg")) : html`<p class="muted">No photos of this copy.</p>`}</div>
          <div>
            <dl class="facts">
              <dt>Price</dt><dd><strong>${money(l.price_cents)}</strong> <span class="muted small">USD demo currency</span></dd>
              <dt>Media</dt><dd>${grade(l.media_condition)}</dd>
              <dt>Sleeve</dt><dd>${grade(l.sleeve_condition)}</dd>
              <dt>Condition notes</dt><dd>${l.condition_description}</dd>
              <dt>Seller</dt><dd>${l.seller.display_name} · ${countryName(l.seller.country)}</dd>
            </dl>
            ${l.status === "available" && user?.id !== l.seller.id
              ? html`<form method="post" action="/cart/add">${csrf(req)}<input type="hidden" name="listing_id" value="${l.id}"><button class="btn btn-primary" type="submit"${!user ? raw(" disabled") : ""}>Add to cart</button></form>`
              : l.status !== "available" ? html`<p class="uncertain">This copy is ${l.status} and can't be purchased.</p>` : ""}
          </div>
        </div>`,
    });
  });
}
