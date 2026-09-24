import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { DomainError } from "../lib/errors.js";
import { html, raw } from "../lib/html.js";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, type SourceKind } from "../imports/adapters/types.js";
import {
  ADAPTERS, BACKGROUND_THRESHOLD, batchRows, beginCommit, commitImport, commitInBackground, decideAllUndecided, decideRow, DEFAULT_SOURCE_NAMES,
  discardPreview, entrySummary, getBatch, listBatches, listSourceLibraries, previewImport, undoImport,
} from "../imports/service.js";
import { csrf, pagination, statusBadge } from "../views/components.js";
import { idParam, me, page } from "./helpers.js";

const CLASS_LABEL: Record<string, string> = { new: "New", existing: "Already imported", changed: "Changed", ambiguous: "Needs review", invalid: "Invalid" };
const KIND_HELP: Record<SourceKind, string> = {
  discogs_collection: "On Discogs: Collection → Export. Creates private physical copies (and digital releases for “File” formats).",
  discogs_wantlist: "On Discogs: Wantlist → Export. Creates wants only — never owned items.",
  rekordbox: "In Rekordbox: File → Export Collection in xml format. Creates private digital tracks and reads your playlists. Read-only: nothing is written back.",
};

function countsLine(c: any) {
  if (!c || c.total == null) return "";
  return html`<span class="small">${c.total} rows: <strong>${c.new}</strong> new · ${c.existing} already imported · ${c.changed} changed · <strong>${c.ambiguous}</strong> need review · ${c.invalid} invalid</span>`;
}

function fieldsSummary(f: any) {
  if (!f) return "";
  const bits = [f.label_text, f.catno_text, f.format_raw ?? f.file_format, f.release_year, f.media_condition ? `${f.media_condition}/${f.sleeve_condition}` : null, f.source_folder ? `folder “${f.source_folder}”` : null,
    f.bpm_x100 ? `${(f.bpm_x100 / 100).toFixed(1)} BPM` : null, f.musical_key, f.rating != null ? `${f.rating}★` : null].filter(Boolean);
  return html`<strong>${f.artist_text}</strong> — ${f.title_text}${f.version_text ? ` (${f.version_text})` : ""} <span class="muted small">${bits.join(" · ")}</span>`;
}

export function registerImportRoutes(app: Express, ctx: AppContext) {
  app.get("/imports", (req, res) => {
    const user = me(req);
    const batches = listBatches(ctx.db, user.id);
    const sources = listSourceLibraries(ctx.db, user.id);
    page(req, res, {
      title: "Import",
      nav: "imports",
      body: html`<h1>Import</h1>
        <p>Bring in exports you already have. Every import is previewed first, saved privately, and can be undone. Your notes, tags and crates are never overwritten by a later import.</p>
        <form method="post" action="/imports" enctype="multipart/form-data" class="panel form-narrow">${csrf(req)}
          <fieldset><legend>What are you importing?</legend>
            ${(Object.keys(ADAPTERS) as SourceKind[]).map((k, i) => html`<label class="check"><input type="radio" name="kind" value="${k}"${i === 0 ? raw(" checked") : ""}> <span><strong>${ADAPTERS[k].label}</strong><br><span class="small muted">${KIND_HELP[k]}</span></span></label>`)}
          </fieldset>
          <div class="field"><label for="f-source">Source name (optional)</label>
            <p class="hint" id="h-source">Name different libraries separately, e.g. “Rekordbox — studio laptop”. Rekordbox track IDs are only compared within the same source.</p>
            <input id="f-source" name="source_name" list="source-names" aria-describedby="h-source" placeholder="Default: ${DEFAULT_SOURCE_NAMES.discogs_collection} / ${DEFAULT_SOURCE_NAMES.rekordbox}">
            <datalist id="source-names">${sources.map((s) => html`<option value="${s.name}">`)}</datalist></div>
          <div class="field"><label for="f-file">Export file (.csv or .xml, up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB, ${MAX_IMPORT_ROWS.toLocaleString()} rows)</label>
            <input id="f-file" type="file" name="file" accept=".csv,.xml,text/csv,text/xml,application/xml" required></div>
          <button class="btn btn-primary" type="submit">Upload and preview</button>
          <p class="explain">Nothing is added to your library until you confirm the preview. The file itself isn't stored; its fingerprint is, so an identical re-upload is recognised.</p>
        </form>
        <p class="small">No export handy? Try the synthetic samples in <code>fixtures/</code>, or <a href="/copies/new">add a record</a> / <a href="/digital/new">add a digital file</a> by hand.</p>
        ${sources.length ? html`<h2>Your sources</h2><ul class="plain">${sources.map((s) => html`<li><strong>${s.name}</strong> <span class="muted small">${ADAPTERS[s.kind as SourceKind].label} · ${s.entries} entries · last import ${s.last_import ? String(s.last_import).slice(0, 16).replace("T", " ") : "never"}</span></li>`)}</ul>` : ""}
        <h2>Import history</h2>
        ${batches.length ? html`<div class="table-wrap"><table class="compact"><thead><tr><th>#</th><th>File</th><th>Source</th><th>Status</th><th>Summary</th><th>Date</th></tr></thead><tbody>
          ${batches.map((b) => html`<tr><td><a href="/imports/${b.id}">#${b.id}</a></td><td class="break">${b.filename}</td><td>${b.source_name}</td><td>${statusBadge(b.status)}</td><td>${countsLine(b.counts)}</td><td class="small nowrap">${String(b.created_at).slice(0, 16).replace("T", " ")}</td></tr>`)}
        </tbody></table></div>` : html`<div class="empty"><p>No imports yet.</p></div>`}`,
    });
  });

  app.post("/imports", (req, res) => {
    const user = me(req);
    const kind = String(req.body.kind ?? "") as SourceKind;
    if (!ADAPTERS[kind]) throw new DomainError("Choose what you're importing.", 422);
    const file = req.file;
    if (!file) throw new DomainError("Choose a file to import.", 422);
    const id = previewImport(ctx.db, ctx.clock, user.id, { kind, sourceName: String(req.body.source_name ?? ""), filename: file.originalname, buffer: file.buffer });
    res.redirect(303, `/imports/${id}`);
  });

  app.get("/imports/:id", (req, res) => {
    const user = me(req);
    const b = getBatch(ctx.db, user.id, idParam(req));
    const filter = ["new", "existing", "changed", "ambiguous", "invalid"].includes(String(req.query.show)) ? String(req.query.show) : b.status === "previewed" && b.counts.ambiguous ? "ambiguous" : "";
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const { total, rows } = b.rows_total ? batchRows(ctx.db, user.id, b.id, filter, pageNo) : { total: 0, rows: [] as ReturnType<typeof batchRows>["rows"] };
    const c = b.counts;
    const tab = (k: string, label: string, n: number | undefined) => html`<a href="/imports/${b.id}?show=${k}" aria-current="${filter === k}">${label}${n != null ? ` (${n})` : ""}</a>`;
    const progress = b.status === "committing";
    page(req, res, {
      title: `Import #${b.id}`,
      nav: "imports",
      body: html`${progress ? raw('<meta http-equiv="refresh" content="2">') : ""}
        <nav class="crumbs"><a href="/imports">Import</a> / <span>#${b.id}</span></nav>
        <h1>${b.filename} ${statusBadge(b.status)}</h1>
        <p class="muted">${ADAPTERS[b.kind as SourceKind].label} → source “${b.source_name}” · ${(b.file_bytes / 1024).toFixed(1)} KB · fingerprint <code>${String(b.file_fingerprint).slice(0, 12)}…</code> · uploaded ${String(b.created_at).slice(0, 16).replace("T", " ")} UTC</p>
        ${b.error ? html`<div class="flash flash-error" role="alert"><strong>${b.status === "failed" && !b.rows_total ? "This file couldn't be read." : "The import stopped."}</strong> ${b.error}</div>` : ""}
        ${b.identical_to_batch_id && b.status === "previewed" ? html`<div class="flash flash-info" role="status"><strong>Identical file.</strong> This is byte-for-byte the same file as <a href="/imports/${b.identical_to_batch_id}">import #${b.identical_to_batch_id}</a>. Committing will not create anything new.</div>` : ""}
        ${b.notices.length ? html`<ul class="small notices">${b.notices.map((n: string) => html`<li>${n}</li>`)}</ul>` : ""}
        ${progress ? html`<div class="panel" role="status" aria-live="polite"><strong>Importing…</strong> ${b.rows_applied} of ${b.rows_total} rows saved. <progress max="${b.rows_total}" value="${b.rows_applied}"></progress> <span class="muted small">This page refreshes itself. You can keep using the app.</span></div>` : ""}
        ${b.rows_total ? html`
          <div class="stat-row">
            <div class="stat"><span class="n">${c.new}</span> new</div>
            <div class="stat"><span class="n">${c.existing}</span> already imported</div>
            <div class="stat"><span class="n">${c.changed}</span> changed</div>
            <div class="stat ${c.ambiguous ? "attention" : ""}"><span class="n">${c.ambiguous}</span> need review</div>
            <div class="stat"><span class="n">${c.invalid}</span> invalid</div>
            <div class="stat"><span class="n">${c.missing_from_export}</span> not in this file</div>
          </div>
          ${c.missing_from_export ? html`<p class="small">${c.missing_from_export} previously imported entr${c.missing_from_export === 1 ? "y is" : "ies are"} not in this file. ${raw("<strong>Nothing will be deleted</strong>")} — missing entries are only reported.</p>` : ""}
          ${c.playlists ? html`<p class="small">${c.playlists} playlist${c.playlists === 1 ? "" : "s"} will be imported as private, read-only playlists.</p>` : ""}` : ""}
        ${b.report ? html`<div class="panel"><h2>Import report</h2>
            <p>${b.report.created} created · ${b.report.updated} updated · ${b.report.unchanged} unchanged · ${b.report.skipped} skipped · ${b.report.invalid} invalid${b.report.kept_user_edits ? ` · kept your edits on ${b.report.kept_user_edits}` : ""}${b.report.playlists ? ` · ${b.report.playlists} playlists` : ""}${b.report.unresolved_track_refs ? ` (${b.report.unresolved_track_refs} playlist entries pointed at tracks not in the file)` : ""}.</p>
            <p class="small">${b.report.note} ${b.report.missing_from_export ? `Not in this export: ${b.report.missing_from_export}${b.report.missing_examples?.length ? ` (e.g. ${b.report.missing_examples.slice(0, 5).join("; ")})` : ""}.` : ""}</p>
            ${b.report.undo ? html`<p class="small"><strong>Undone</strong> ${String(b.report.undo.at).slice(0, 16).replace("T", " ")}: removed ${b.report.undo.removed}, kept ${b.report.undo.kept_edited_or_used} you had edited or organised, restored ${b.report.undo.restored} updated item${b.report.undo.restored === 1 ? "" : "s"}${b.report.undo.restore_skipped_user_edits ? `, left ${b.report.undo.restore_skipped_user_edits} you edited afterwards` : ""}.</p>` : ""}
            ${b.status === "committed" ? html`<div class="actions"><a class="btn" href="/library?batch=${b.id}">View items created by this import</a>
              <form method="post" action="/imports/${b.id}/undo" class="inline">${csrf(req)}<button class="btn btn-danger" type="submit">Undo this import…</button></form></div>
              <p class="explain">Undo removes records this import created, except ones you've since edited, tagged, put in a crate or chart, photographed or listed. It restores details this import updated unless you've edited them since.</p>` : ""}
          </div>` : ""}
        ${b.status === "previewed" ? html`<div class="action-row">
            <form method="post" action="/imports/${b.id}/commit" class="inline">${csrf(req)}<button class="btn btn-primary" type="submit"${b.undecided ? raw(" disabled") : ""}>Save to my library</button></form>
            <form method="post" action="/imports/${b.id}/discard" class="inline">${csrf(req)}<button class="btn btn-quiet" type="submit">Discard preview</button></form>
            ${b.undecided ? html`<span class="small uncertain">${b.undecided} row${b.undecided === 1 ? " needs" : "s need"} a decision first.</span>` : ""}
          </div>` : ""}
        ${b.status === "failed" && b.rows_total ? html`<form method="post" action="/imports/${b.id}/commit">${csrf(req)}<button class="btn btn-primary" type="submit">Retry — continues where it stopped</button></form>` : ""}
        ${b.rows_total ? html`
          <h2>Rows</h2>
          <p class="segmented">${tab("", "All", c.total)}${tab("ambiguous", "Need review", c.ambiguous)}${tab("new", "New", c.new)}${tab("changed", "Changed", c.changed)}${tab("existing", "Already imported", c.existing)}${tab("invalid", "Invalid", c.invalid)}</p>
          ${b.status === "previewed" && c.ambiguous ? html`<div class="panel"><p class="small"><strong>Why review?</strong> Discogs exports don't identify individual copies, so when a release you already imported appears with different details, we can't tell an edited copy from an additional one. Rekordbox IDs can also change or be reused. We never guess.</p>
            <form method="post" action="/imports/${b.id}/decide-all" class="searchbar">${csrf(req)}<label for="f-all" class="sr-only">Decision for all undecided rows</label>
              <select id="f-all" name="decision"><option value="link">Same item — update imported details (keeps your edits)</option><option value="create">Different item — add as new</option><option value="skip">Skip these rows</option></select>
              <button class="btn btn-sm" type="submit">Apply to all ${b.undecided} undecided</button></form></div>` : ""}
          <div class="table-wrap"><table class="compact"><thead><tr><th>Row</th><th>Result</th><th>Entry</th><th>Notes</th></tr></thead><tbody>
            ${rows.map((r) => html`<tr>
              <td class="nowrap">${r.row_number}${r.external_id ? html`<br><span class="muted small">${b.kind === "rekordbox" ? "TrackID" : "release"} ${r.external_id}</span>` : ""}</td>
              <td>${statusBadge(r.classification === "ambiguous" ? "pending" : r.classification === "invalid" ? "rejected" : r.classification === "existing" ? "withdrawn" : "accepted", CLASS_LABEL[r.classification])}
                ${r.decision ? html`<br><span class="small">Decision: ${r.decision === "link" ? "same item" : r.decision === "create" ? "add as new" : "skip"}</span>` : ""}</td>
              <td>${r.parsed ? fieldsSummary(r.parsed.fields) : html`<span class="muted">—</span>`}
                ${r.classification === "ambiguous" && b.status === "previewed" ? html`<div class="candidates">
                  <p class="small"><strong>Possible match${r.candidate_entry_ids.length === 1 ? "" : "es"} already in your library:</strong></p>
                  ${r.candidate_entry_ids.map((cid: number) => {
                    const e = entrySummary(ctx.db, user.id, cid);
                    return e ? html`<form method="post" action="/imports/${b.id}/decide" class="cart-line">${csrf(req)}<input type="hidden" name="row_id" value="${r.id}"><input type="hidden" name="decision" value="link"><input type="hidden" name="entry_id" value="${cid}">
                      <span class="grow small">${fieldsSummary(e.fields)}${e.holding?.user_edited_at ? html` <span class="badge">you edited this</span>` : ""}</span>
                      <button class="btn btn-quiet btn-sm" type="submit"${r.decision === "link" && r.decision_entry_id === cid ? raw(" aria-pressed=\"true\"") : ""}>Same item</button></form>` : "";
                  })}
                  <div class="actions">
                    <form method="post" action="/imports/${b.id}/decide" class="inline">${csrf(req)}<input type="hidden" name="row_id" value="${r.id}"><input type="hidden" name="decision" value="create"><button class="btn btn-quiet btn-sm" type="submit">Different item — add new</button></form>
                    <form method="post" action="/imports/${b.id}/decide" class="inline">${csrf(req)}<input type="hidden" name="row_id" value="${r.id}"><input type="hidden" name="decision" value="skip"><button class="btn btn-quiet btn-sm" type="submit">Skip</button></form>
                  </div></div>` : ""}</td>
              <td class="small">${r.messages.filter(Boolean).map((m: string) => html`<div>${m}</div>`)}</td></tr>`)}
          </tbody></table></div>
          ${pagination(`/imports/${b.id}`, new URLSearchParams(filter ? { show: filter } : {}), pageNo, total, 100)}` : ""}`,
    });
  });

  const back = (req: Request, res: Response) => res.redirect(303, `/imports/${req.params.id}${req.body.show ? `?show=${encodeURIComponent(req.body.show)}` : ""}`);

  app.post("/imports/:id/decide", (req, res) => {
    const user = me(req);
    const d = String(req.body.decision);
    if (!["create", "skip", "link"].includes(d)) throw new DomainError("Choose a decision.", 422);
    decideRow(ctx.db, user.id, idParam(req), Number(req.body.row_id), d === "link" ? { decision: "link", entryId: Number(req.body.entry_id) } : { decision: d as "create" | "skip" });
    back(req, res);
  });

  app.post("/imports/:id/decide-all", (req, res) => {
    const user = me(req);
    const d = String(req.body.decision);
    if (!["create", "skip", "link"].includes(d)) throw new DomainError("Choose a decision.", 422);
    const n = decideAllUndecided(ctx.db, user.id, idParam(req), d as "create");
    addFlash(req, "success", `Decision applied to ${n} row${n === 1 ? "" : "s"}.`);
    back(req, res);
  });

  app.post("/imports/:id/commit", (req, res) => {
    const user = me(req);
    const id = idParam(req);
    const b = getBatch(ctx.db, user.id, id);
    if (b.rows_total > BACKGROUND_THRESHOLD) {
      beginCommit(ctx.db, ctx.clock, user.id, id);
      void commitInBackground(ctx.db, ctx.clock, id);
      addFlash(req, "info", "Large import started in the background.");
    } else {
      const done = commitImport(ctx.db, ctx.clock, user.id, id);
      addFlash(req, "success", `Saved: ${done.report.created} created, ${done.report.updated} updated, ${done.report.unchanged} unchanged.`);
    }
    res.redirect(303, `/imports/${id}`);
  });

  app.post("/imports/:id/discard", (req, res) => {
    discardPreview(ctx.db, me(req).id, idParam(req));
    addFlash(req, "success", "Preview discarded. Nothing was imported.");
    res.redirect(303, "/imports");
  });

  app.post("/imports/:id/undo", (req, res) => {
    const s = undoImport(ctx.db, ctx.clock, me(req).id, idParam(req));
    addFlash(req, "success", `Import undone: removed ${s.removed}, kept ${s.kept_edited_or_used} you had edited or organised, restored ${s.restored}.`);
    res.redirect(303, `/imports/${req.params.id}`);
  });
}
