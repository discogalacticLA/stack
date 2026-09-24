/** Crates (manual, ordered) and Top 5 charts. */
import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { DomainError } from "../lib/errors.js";
import { html, raw } from "../lib/html.js";
import { ValidationError, type FieldErrors } from "../lib/validation.js";
import {
  addToCrate, crateItems, createCrate, deleteCrate, filterQuery, getOwnCrate, listCrates, listLibrary, moveCrateItem, parseLibraryFilters,
  parseRef, refKey, removeFromCrate, updateCrate,
} from "../domain/library.js";
import {
  addChartEntry, createChart, deleteChart, entryProblem, getOwnChart, listCharts, MAX_CHART_ENTRIES, moveChartEntry, removeChartEntry, SCOPES,
  updateChartDetails, updateEntryCommentary,
} from "../domain/charts.js";
import { csrf, errorSummary, selectField, textArea, textField } from "../views/components.js";
import { idParam, me, page } from "./helpers.js";
import { itemArt, itemHref } from "./library.js";

export function registerCurationRoutes(app: Express, ctx: AppContext) {
  // ───────────────────────── Crates ─────────────────────────
  const renderCrates = (req: Request, res: Response, values: Record<string, any> = {}, errors?: FieldErrors) => {
    const user = me(req);
    const crates = listCrates(ctx.db, user.id);
    const playlists = ctx.db.prepare(
      `SELECT sp.id, sp.path, (SELECT COUNT(*) FROM source_playlist_items WHERE playlist_id = sp.id) AS n FROM current_source_playlists sp
       JOIN source_libraries sl ON sl.id = sp.source_library_id WHERE sl.owner_id = ? AND sp.node_type = 'playlist' ORDER BY sp.path`,
    ).all(user.id) as any[];
    page(req, res, {
      title: "Crates",
      nav: "crates",
      body: html`<h1>Crates</h1>
        <p class="muted">Private, hand-ordered selections from your library. An item can be in any number of crates; removing it from a crate never removes it from your library.</p>
        ${crates.length ? html`<ul class="crate-list">${crates.map((c) => html`<li class="panel"><a href="/crates/${c.id}"><strong>${c.name}</strong></a> <span class="muted">${c.n} item${c.n === 1 ? "" : "s"}</span>${c.description ? html`<p class="small">${c.description}</p>` : ""}</li>`)}</ul>`
          : html`<div class="empty"><h2>No crates yet</h2><p>Create one below, then add items from your library.</p></div>`}
        <h2>New crate</h2>
        <form method="post" action="/crates" class="panel form-narrow" novalidate>${csrf(req)}${errorSummary(errors)}
          ${textField({ label: "Name", name: "name", value: values.name, errors, required: true, placeholder: "Sunday brunch" })}
          ${textArea({ label: "Description", name: "description", value: values.description, errors, rows: 2 })}
          <button class="btn btn-primary" type="submit">Create crate</button></form>
        ${playlists.length ? html`<h2>Start from an imported Rekordbox playlist</h2>
          <p class="muted small">Copies the playlist's tracks, in order, into a new private crate. The imported playlist itself is left as exported.</p>
          <ul class="plain">${playlists.map((p) => html`<li><form method="post" action="/crates/from-playlist/${p.id}" class="cart-line">${csrf(req)}<span class="grow">${p.path} <span class="muted small">(${p.n})</span></span><button class="btn btn-quiet btn-sm" type="submit">Make crate</button></form></li>`)}</ul>` : ""}`,
    }, errors ? 422 : 200);
  };

  app.get("/crates", (req, res) => renderCrates(req, res));

  app.post("/crates", (req, res) => {
    const user = me(req);
    try {
      const id = createCrate(ctx.db, ctx.clock, user.id, req.body);
      addFlash(req, "success", "Crate created. Add items from your library.");
      res.redirect(303, `/crates/${id}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderCrates(req, res, req.body, e.fields);
      if (e instanceof DomainError && e.status === 422) return renderCrates(req, res, req.body, { name: e.message });
      throw e;
    }
  });

  app.post("/crates/from-playlist/:id", (req, res) => {
    const user = me(req);
    const pl = ctx.db.prepare(
      "SELECT sp.* FROM current_source_playlists sp JOIN source_libraries sl ON sl.id = sp.source_library_id WHERE sp.id = ? AND sl.owner_id = ?",
    ).get(idParam(req), user.id) as any;
    if (!pl) throw new DomainError("Playlist not found.", 404);
    const refs = (ctx.db.prepare(
      "SELECT d.id FROM source_playlist_items spi JOIN digital_holdings d ON d.source_entry_id = spi.source_entry_id AND d.owner_id = ? WHERE spi.playlist_id = ? ORDER BY spi.position",
    ).all(user.id, pl.id) as any[]).map((r) => ({ type: "digital" as const, id: r.id }));
    let name = pl.path.slice(0, 50);
    for (let i = 2; ctx.db.prepare("SELECT 1 FROM crates WHERE owner_id = ? AND name = ?").get(user.id, name); i++) name = `${pl.path.slice(0, 45)} (${i})`;
    const id = createCrate(ctx.db, ctx.clock, user.id, { name, description: `Started from the imported Rekordbox playlist “${pl.path}”.` });
    addToCrate(ctx.db, ctx.clock, user.id, id, refs);
    addFlash(req, "success", `Crate created with ${refs.length} tracks.`);
    res.redirect(303, `/crates/${id}`);
  });

  app.get("/crates/:id", (req, res) => {
    const user = me(req);
    const crate = getOwnCrate(ctx.db, user.id, idParam(req));
    const items = crateItems(ctx.db, user.id, crate.id);
    const lq = String(req.query.lq ?? "");
    const inCrate = new Set(items.map((i) => refKey({ type: i.item_type, id: i.item_id })));
    const candidates = lq ? listLibrary(ctx.db, user.id, parseLibraryFilters({ q: lq }), "artist", "asc", 1, 20).rows.filter((r) => !inCrate.has(refKey({ type: r.item_type, id: r.item_id }))) : [];
    page(req, res, {
      title: crate.name,
      nav: "crates",
      body: html`<nav class="crumbs"><a href="/crates">Crates</a> / <span>${crate.name}</span></nav>
        <h1>${crate.name} <span class="muted small">${items.length} item${items.length === 1 ? "" : "s"} · private</span></h1>
        ${crate.description ? html`<p>${crate.description}</p>` : ""}
        ${items.length
          ? html`<ol class="crate-order">${items.map((it, i) => html`<li class="cart-line">
              <span class="pos" aria-hidden="true">${i + 1}</span>
              ${itemArt(it, "sm")}
              <span class="grow"><a href="${itemHref(it)}"><strong>${it.title}</strong>${it.version ? ` (${it.version})` : ""}</a><br><span class="small">${it.artist} · ${it.item_type === "digital" ? "Digital" : it.format_group}${it.catno ? ` · ${it.catno}` : ""}</span></span>
              <span class="reorder" role="group" aria-label="Move ${it.title}">
                ${(["top", "up", "down", "bottom"] as const).map((d) => html`<form method="post" action="/crates/${crate.id}/move" class="inline">${csrf(req)}<input type="hidden" name="crate_item_id" value="${it.crate_item_id}"><input type="hidden" name="to" value="${d}">
                  <button class="btn btn-quiet btn-sm" type="submit"${(i === 0 && (d === "up" || d === "top")) || (i === items.length - 1 && (d === "down" || d === "bottom")) ? raw(" disabled") : ""} aria-label="Move ${it.title} ${d === "top" ? "to the top" : d === "bottom" ? "to the bottom" : d}">${{ top: "⤒", up: "↑", down: "↓", bottom: "⤓" }[d]}</button></form>`)}
                <form method="post" action="/crates/${crate.id}/move" class="inline">${csrf(req)}<input type="hidden" name="crate_item_id" value="${it.crate_item_id}">
                  <label for="f-pos-${it.crate_item_id}" class="sr-only">Position for ${it.title}</label>
                  <input id="f-pos-${it.crate_item_id}" class="pos-input" name="to" inputmode="numeric" value="${i + 1}" size="3"><button class="btn btn-quiet btn-sm" type="submit">Move</button></form>
                <form method="post" action="/crates/${crate.id}/remove-item" class="inline">${csrf(req)}<input type="hidden" name="ref" value="${refKey({ type: it.item_type, id: it.item_id })}"><button class="btn btn-quiet btn-sm" type="submit">Remove</button></form>
              </span></li>`)}</ol>`
          : html`<div class="empty"><h2>This crate is empty</h2><p>Search your library below, or use bulk “Add to crate” on the <a href="/library">library</a> page.</p></div>`}
        <h2>Add from your library</h2>
        <form method="get" class="searchbar" role="search"><label for="f-lq" class="sr-only">Search your library</label><input id="f-lq" type="search" name="lq" value="${lq}" placeholder="Search your library"><button class="btn" type="submit">Search</button></form>
        ${lq ? candidates.length ? html`<form method="post" action="/crates/${crate.id}/add" class="panel">${csrf(req)}
            ${candidates.map((r) => html`<label class="check"><input type="checkbox" name="refs" value="${refKey({ type: r.item_type, id: r.item_id })}"> <span>${r.artist} — <strong>${r.title}</strong>${r.version ? ` (${r.version})` : ""} <span class="muted small">${r.item_type === "digital" ? "Digital" : r.format_group}</span></span></label>`)}
            <button class="btn btn-primary btn-sm" type="submit">Add selected to the end</button></form>`
          : html`<p class="muted">No library items match “${lq}” (or they're already here).</p>` : ""}
        <details class="panel"><summary>Rename, describe or delete</summary>
          <form method="post" action="/crates/${crate.id}/edit">${csrf(req)}
            ${textField({ label: "Name", name: "name", value: crate.name, required: true })}${textArea({ label: "Description", name: "description", value: crate.description, rows: 2 })}
            <button class="btn btn-sm" type="submit">Save</button></form>
          <form method="post" action="/crates/${crate.id}/delete">${csrf(req)}<p class="small">Deleting the crate keeps every item in your library.</p><button class="btn btn-danger btn-sm" type="submit">Delete crate</button></form>
        </details>
        <p><a href="/library?${filterQuery(parseLibraryFilters({ crate: String(crate.id) }))}">View this crate in the library (filters, grouping, bulk actions)</a></p>`,
    });
  });

  app.post("/crates/:id/add", (req, res) => {
    const user = me(req);
    const refs = (Array.isArray(req.body.refs) ? req.body.refs : [req.body.refs]).map(parseRef).filter(Boolean);
    const n = addToCrate(ctx.db, ctx.clock, user.id, idParam(req), refs as any);
    addFlash(req, "success", `Added ${n} item${n === 1 ? "" : "s"}.`);
    res.redirect(303, `/crates/${req.params.id}`);
  });

  app.post("/crates/:id/move", (req, res) => {
    const user = me(req);
    const raw = String(req.body.to ?? "");
    const to = ["up", "down", "top", "bottom"].includes(raw) ? (raw as "up") : Number(raw);
    if (typeof to === "number" && (!Number.isInteger(to) || to < 1)) throw new DomainError("Enter a position number (1 or more).", 422);
    moveCrateItem(ctx.db, ctx.clock, user.id, idParam(req), Number(req.body.crate_item_id), to);
    res.redirect(303, `/crates/${req.params.id}`);
  });

  app.post("/crates/:id/edit", (req, res) => {
    const user = me(req);
    updateCrate(ctx.db, ctx.clock, user.id, idParam(req), req.body);
    addFlash(req, "success", "Crate saved.");
    res.redirect(303, `/crates/${req.params.id}`);
  });

  app.post("/crates/:id/delete", (req, res) => {
    const user = me(req);
    deleteCrate(ctx.db, user.id, idParam(req));
    addFlash(req, "success", "Crate deleted. Its items are still in your library.");
    res.redirect(303, "/crates");
  });

  // ───────────────────────── Top 5 charts ─────────────────────────
  const thisMonth = () => ctx.clock.now().toISOString().slice(0, 7);
  const renderCharts = (req: Request, res: Response, values: Record<string, any> = {}, errors?: FieldErrors) => {
    const user = me(req);
    const charts = listCharts(ctx.db, user.id);
    page(req, res, {
      title: "Top 5",
      nav: "charts",
      body: html`<h1>Top 5</h1>
        <p class="muted">Ranked picks you choose yourself — nothing is filled in automatically. Drafts are private.</p>
        ${charts.length ? html`<ul class="crate-list">${charts.map((c) => html`<li class="panel"><a href="/charts/${c.id}"><strong>${c.title}</strong></a>
            <span class="badge">${c.chart_type} chart</span> <span class="badge">${c.period_kind === "month" ? c.period_month : "all time"}</span>
            <span class="badge status-draft">draft · private</span> <span class="small ${c.n === MAX_CHART_ENTRIES ? "" : "muted"}">${c.n} of ${MAX_CHART_ENTRIES}${c.n === MAX_CHART_ENTRIES ? " — complete" : ""}</span></li>`)}</ul>`
          : html`<div class="empty"><h2>No charts yet</h2><p>Start a monthly or all-time Top 5 below.</p></div>`}
        <h2>New Top 5</h2>
        <form method="post" action="/charts" class="panel form-narrow" novalidate>${csrf(req)}${errorSummary(errors)}
          ${selectField({ label: "Tracks or releases?", name: "chart_type", value: values.chart_type ?? "release", options: [{ value: "release", label: "Releases (records, albums, EPs)" }, { value: "track", label: "Tracks" }], errors, required: true })}
          ${selectField({ label: "What is it?", name: "scope", value: values.scope ?? "favorites", options: Object.entries(SCOPES).map(([k, s]) => ({ value: k, label: s.label })), errors, required: true,
            hint: "Monthly charts (favorites, discoveries, new releases) are for one month. “Most played” uses cumulative play counts from your Rekordbox export and is all-time only." })}
          ${textField({ label: "Month (for monthly charts)", name: "period_month", value: values.period_month ?? thisMonth(), errors, placeholder: "2026-09", hint: "YYYY-MM" })}
          ${textField({ label: "Title (optional)", name: "title", value: values.title, errors })}
          ${textArea({ label: "Introduction (optional)", name: "commentary", value: values.commentary, errors, rows: 2 })}
          <button class="btn btn-primary" type="submit">Create draft</button></form>`,
    }, errors ? 422 : 200);
  };

  app.get("/charts", (req, res) => renderCharts(req, res));
  app.post("/charts", (req, res) => {
    const user = me(req);
    try {
      const id = createChart(ctx.db, ctx.clock, user.id, req.body);
      res.redirect(303, `/charts/${id}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderCharts(req, res, req.body, e.fields);
      throw e;
    }
  });

  app.get("/charts/:id", (req, res) => {
    const user = me(req);
    const chart = getOwnChart(ctx.db, user.id, idParam(req));
    const lq = String(req.query.lq ?? "");
    const typeFilter = chart.scope === "most_played" ? "digital" : "";
    const candidates = lq || chart.scope === "most_played"
      ? listLibrary(ctx.db, user.id, parseLibraryFilters({ q: lq, type: typeFilter }), "artist", "asc", 1, 30).rows
      : [];
    const full = chart.entries.length >= MAX_CHART_ENTRIES;
    page(req, res, {
      title: chart.title,
      nav: "charts",
      body: html`<nav class="crumbs"><a href="/charts">Top 5</a> / <span>${chart.title}</span></nav>
        <h1>${chart.title}</h1>
        <p><span class="badge">${chart.chart_type} chart</span> <span class="badge">${SCOPES[chart.scope as keyof typeof SCOPES].label}</span> <span class="badge">${chart.period_kind === "month" ? chart.period_month : "all time"}</span> <span class="badge status-draft">draft · private</span></p>
        <p><strong>${chart.entries.length} of ${MAX_CHART_ENTRIES}</strong> ${chart.complete ? "— complete." : "— not complete yet. Empty positions stay empty until you choose something."}</p>
        ${chart.scope === "most_played" ? html`<p class="sim-notice"><strong>Note</strong> Play counts are cumulative totals from your last Rekordbox export. They are not monthly listening history.</p>` : ""}
        ${chart.scope === "new_releases" ? html`<p class="explain">“New releases this month” is your own call; release dates in your library may be missing or approximate.</p>` : ""}
        ${chart.commentary ? html`<p>${chart.commentary}</p>` : ""}
        <ol class="chart-list">${Array.from({ length: MAX_CHART_ENTRIES }, (_, i) => {
          const e = chart.entries[i];
          if (!e) return html`<li class="panel chart-empty"><span class="pos">${i + 1}</span> <span class="muted">Empty</span></li>`;
          return html`<li class="panel"><div class="cart-line"><span class="pos">${i + 1}</span>${itemArt(e, "sm")}
            <span class="grow"><a href="${itemHref(e)}"><strong>${e.track_position ? `${e.track_position} — ` : ""}${e.title}</strong>${e.version ? ` (${e.version})` : ""}</a><br><span class="small">${e.artist} · ${e.item_type === "digital" ? "Digital" : e.format_group}${chart.scope === "most_played" && e.play_count != null ? ` · ${e.play_count} plays (cumulative)` : ""}</span></span>
            <span class="reorder">
              <form method="post" action="/charts/${chart.id}/entries/${e.id}/up" class="inline">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit"${i === 0 ? raw(" disabled") : ""} aria-label="Move ${e.title} up">↑</button></form>
              <form method="post" action="/charts/${chart.id}/entries/${e.id}/down" class="inline">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit"${i === chart.entries.length - 1 ? raw(" disabled") : ""} aria-label="Move ${e.title} down">↓</button></form>
              <form method="post" action="/charts/${chart.id}/entries/${e.id}/remove" class="inline">${csrf(req)}<button class="btn btn-quiet btn-sm" type="submit">Remove</button></form>
            </span></div>
            <form method="post" action="/charts/${chart.id}/entries/${e.id}/commentary">${csrf(req)}
              <label for="f-com-${e.id}" class="small">Why it's here</label><textarea id="f-com-${e.id}" name="commentary" rows="2">${e.commentary ?? ""}</textarea>
              <button class="btn btn-quiet btn-sm" type="submit">Save commentary</button></form></li>`;
        })}</ol>
        ${full ? html`<p class="muted">All five positions are filled. Remove one to add something else.</p>` : html`
          <h2>Add from your library</h2>
          <form method="get" class="searchbar" role="search"><label for="f-clq" class="sr-only">Search your library</label><input id="f-clq" type="search" name="lq" value="${lq}" placeholder="Search your library"><button class="btn" type="submit">Search</button></form>
          ${candidates.length ? html`<ul class="plain">${candidates.map((r) => {
            const ref = { type: r.item_type, id: r.item_id } as const;
            const needsTrack = chart.chart_type === "track" && r.item_type === "physical";
            const problem = entryProblem(ctx.db, chart, ref, needsTrack ? "x" : null);
            return html`<li><form method="post" action="/charts/${chart.id}/entries" class="cart-line">${csrf(req)}<input type="hidden" name="ref" value="${refKey(ref)}">
              <span class="grow">${r.artist} — <strong>${r.title}</strong>${r.version ? ` (${r.version})` : ""} <span class="muted small">${r.item_type === "digital" ? "Digital" : r.format_group}</span>${problem ? html`<br><span class="small uncertain">${problem}</span>` : ""}</span>
              ${needsTrack && !problem ? html`<label for="f-tp-${r.item_id}" class="sr-only">Track on this record</label><input id="f-tp-${r.item_id}" name="track_position" placeholder="Track, e.g. B1 Vauxhall Hum" required>` : ""}
              <button class="btn btn-sm" type="submit"${problem ? raw(" disabled") : ""}>Add at #${chart.entries.length + 1}</button></form></li>`;
          })}</ul>` : lq ? html`<p class="muted">No library items match “${lq}”.</p>` : ""}`}
        <details class="panel"><summary>Edit title and introduction, or delete</summary>
          <form method="post" action="/charts/${chart.id}/details">${csrf(req)}${textField({ label: "Title", name: "title", value: chart.title, required: true })}${textArea({ label: "Introduction", name: "commentary", value: chart.commentary, rows: 2 })}<button class="btn btn-sm" type="submit">Save</button></form>
          <form method="post" action="/charts/${chart.id}/delete">${csrf(req)}<button class="btn btn-danger btn-sm" type="submit">Delete this chart</button></form>
        </details>
        <p class="muted small">Publishing (as a dated monthly snapshot) is planned for the social milestone; charts are private drafts for now.</p>`,
    });
  });

  app.post("/charts/:id/entries", (req, res) => {
    const user = me(req);
    const ref = parseRef(req.body.ref);
    if (!ref) throw new DomainError("Unknown item.", 422);
    addChartEntry(ctx.db, ctx.clock, user.id, idParam(req), ref, req.body);
    addFlash(req, "success", "Added.");
    res.redirect(303, `/charts/${req.params.id}`);
  });
  for (const dir of ["up", "down"] as const) {
    app.post(`/charts/:id/entries/:eid/${dir}`, (req, res) => {
      moveChartEntry(ctx.db, ctx.clock, me(req).id, idParam(req), idParam(req, "eid"), dir);
      res.redirect(303, `/charts/${req.params.id}`);
    });
  }
  app.post("/charts/:id/entries/:eid/remove", (req, res) => {
    removeChartEntry(ctx.db, ctx.clock, me(req).id, idParam(req), idParam(req, "eid"));
    res.redirect(303, `/charts/${req.params.id}`);
  });
  app.post("/charts/:id/entries/:eid/commentary", (req, res) => {
    updateEntryCommentary(ctx.db, ctx.clock, me(req).id, idParam(req), idParam(req, "eid"), req.body.commentary);
    addFlash(req, "success", "Commentary saved.");
    res.redirect(303, `/charts/${req.params.id}`);
  });
  app.post("/charts/:id/details", (req, res) => {
    updateChartDetails(ctx.db, ctx.clock, me(req).id, idParam(req), req.body);
    addFlash(req, "success", "Saved.");
    res.redirect(303, `/charts/${req.params.id}`);
  });
  app.post("/charts/:id/delete", (req, res) => {
    deleteChart(ctx.db, me(req).id, idParam(req));
    addFlash(req, "success", "Chart deleted. The items are still in your library.");
    res.redirect(303, "/charts");
  });
}
