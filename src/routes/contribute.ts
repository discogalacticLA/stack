import type { Express, Request, Response } from "express";
import type { AppContext } from "../context.js";
import { addFlash } from "../app.js";
import { requireRole } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { html, raw } from "../lib/html.js";
import { FORMATS, SOURCE_KINDS } from "../lib/reference.js";
import { saveImages } from "../lib/uploads.js";
import { ValidationError, type FieldErrors } from "../lib/validation.js";
import { facetValues, getReleaseSummary, listLabels, listMastersBrief, type DuplicateCandidate } from "../domain/catalog.js";
import {
  acceptProposal, releaseAsPayload, getProposal, listProposals, PAYLOAD_FIELD_LABELS, rejectProposal, submitProposal,
} from "../domain/proposals.js";
import { csrf, errorSummary, selectField, statusBadge, textArea, textField, verificationBadge } from "../views/components.js";
import { idParam, page } from "./helpers.js";

function releaseFields(v: Record<string, any>, errors?: FieldErrors, labels: { name: string }[] = [], countries: string[] = []) {
  return html`
    <fieldset><legend>Release details</legend>
      <div class="grid-2">
        ${textField({ label: "Label", name: "label_name", value: v.label_name, errors, hint: "Exact name as printed. Leave blank if unknown.", placeholder: labels[0]?.name })}
        ${textField({ label: "Catalog number", name: "catalog_number", value: v.catalog_number, errors, hint: "As printed, including spaces or dashes. Blank if none." })}
        ${selectField({ label: "Format", name: "format", value: v.format, options: FORMATS.map((f) => ({ value: f, label: f })), blank: "Choose…", errors, required: true })}
        ${textField({ label: "Format details", name: "format_details", value: v.format_details, errors, placeholder: '12", 33 ⅓ RPM, White label' })}
        ${textField({ label: "Country", name: "country", value: v.country, errors, list: "countries", hint: "As printed or commonly cited, e.g. UK, Germany, UK & Europe. Blank if unknown." })}
        ${countries.length ? html`<datalist id="countries">${countries.map((c) => html`<option value="${c}">`)}</datalist>` : ""}
      </div>
      <div class="grid-3">
        ${textField({ label: "Year", name: "release_year", value: v.release_year, errors, inputmode: "numeric" })}
        ${textField({ label: "Month", name: "release_month", value: v.release_month, errors, inputmode: "numeric" })}
        ${textField({ label: "Day", name: "release_day", value: v.release_day, errors, inputmode: "numeric" })}
      </div>
      ${textField({ label: "Date note", name: "date_note", value: v.date_note, errors, hint: "Record uncertainty honestly, e.g. “Sleeve says 1996; runout suggests late 1995”." })}
      ${textArea({ label: "Distinguishing details", name: "edition_notes", value: v.edition_notes, errors, rows: 3, hint: "What tells this release apart from other versions: label colour, sticker, sleeve, runout differences." })}
      ${textArea({ label: "Track listing (this release)", name: "tracks", value: v.tracks, errors, rows: 6, mono: true, hint: "One per line: position | title | duration. Add a different artist credit with “ // ”, e.g. B1 | Title // Artist | 6:12" })}
      ${textArea({ label: "Identifiers", name: "identifiers", value: v.identifiers, errors, rows: 3, mono: true, hint: "One per line: barcode: …, matrix_runout: …, label_code: …, rights_society: …, other: … — optional note after “ — ”." })}
      ${textArea({ label: "Listening links (YouTube)", name: "listening_links", value: v.listening_links, errors, rows: 3, mono: true, hint: "Optional. One YouTube URL per line, optionally prefixed with a track position: “A1 | https://www.youtube.com/watch?v=…”. Link only uploads you believe are legitimate (e.g. official artist or label channels)." })}
    </fieldset>`;
}

function sourceFields(v: Record<string, any>, errors?: FieldErrors) {
  return html`<fieldset><legend>Evidence</legend>
    ${selectField({ label: "Source type", name: "source_kind", value: v.source_kind, options: Object.entries(SOURCE_KINDS).map(([k, l]) => ({ value: k, label: l })), blank: "Choose…", errors, required: true })}
    ${textField({ label: "Source citation", name: "source_citation", value: v.source_citation, errors, required: true, placeholder: "e.g. My copy, examined 2026-03-02; label's release sheet" })}
    ${textField({ label: "Source URL (optional)", name: "source_url", value: v.source_url, errors, type: "url" })}
    ${textArea({ label: "Source notes", name: "source_notes", value: v.source_notes, errors, required: true, rows: 3, hint: "What exactly does the source show, and how confident are you?" })}
    <div class="field"><label for="f-images">Supporting images (optional; JPEG/PNG/WebP, max 6)</label>
      <p class="hint" id="h-images">Photos of labels, runouts or sleeves. Accepted images become archive images credited to you.</p>
      <input id="f-images" type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple aria-describedby="h-images"></div>
  </fieldset>`;
}

function duplicatePanel(dups: DuplicateCandidate[]) {
  return html`<section class="panel dup" aria-labelledby="dup-h">
    <h2 id="dup-h">Possible duplicates — please check before submitting</h2>
    <p>These existing releases look similar. If yours is one of them, propose a correction instead.</p>
    <table class="compact"><thead><tr><th>Release</th><th>Why it matched</th><th>Status</th></tr></thead><tbody>
      ${dups.map((d) => html`<tr><td><a href="/releases/${d.release.id}" target="_blank" rel="noopener">${d.artist} — ${d.title}<br><span class="catno">${d.release.catalog_number ?? "—"}</span> ${d.release.label ?? ""} · ${d.release.format} · ${d.release.country ?? "?"} · ${d.release.year ?? "?"}</a></td>
        <td><ul class="small">${d.reasons.map((r) => html`<li>${r}</li>`)}</ul></td><td>${verificationBadge(d.release.verification_status)}</td></tr>`)}
    </tbody></table>
    <label class="check"><input type="checkbox" name="confirm_not_duplicate" value="yes"> <span>I've compared these and my release is different.</span></label>
    <p class="muted small">Images are not kept between attempts; attach them again before resubmitting.</p>
  </section>`;
}

export function registerContributeRoutes(app: Express, ctx: AppContext) {
  app.get("/contribute", (req, res) => {
    const u = requireRole(req.state.user, "contributor");
    const mine = listProposals(ctx.db, { ...u, roles: ["contributor"] }, "");
    page(req, res, {
      title: "Contribute",
      nav: "contribute",
      body: html`<h1>Contribute to the archive</h1>
        <p>Propose missing releases (versions) or corrections. Every change needs a source and stays <strong>pending</strong> until a moderator accepts it. Accepted changes are recorded in the release's revision history with your name and the moderator's.</p>
        <p class="muted small">To propose, open a master and choose “Propose a missing version”, or open a release and choose “Propose a correction”.</p>
        <div class="actions"><a class="btn" href="/contribute/new-edition">Propose a missing release</a></div>
        <h2>Your proposals</h2>
        ${mine.length
          ? html`<div class="table-wrap"><table class="compact"><thead><tr><th>#</th><th>Type</th><th>Release</th><th>Status</th><th>Submitted</th></tr></thead><tbody>
              ${mine.filter((p) => p.proposed_by === u.id).map((p) => html`<tr><td><a href="/proposals/${p.id}">#${p.id}</a></td><td>${p.kind === "new_edition" ? "New release" : "Correction"}</td><td>${p.release_title}</td><td>${statusBadge(p.status)}</td><td class="small">${p.created_at.slice(0, 10)}</td></tr>`)}
            </tbody></table></div>`
          : html`<div class="empty"><p>You haven't proposed anything yet.</p></div>`}`,
    });
  });

  const renderNew = (req: Request, res: Response, v: Record<string, any>, errors?: FieldErrors, dups?: DuplicateCandidate[]) => {
    requireRole(req.state.user, "contributor");
    const masters = listMastersBrief(ctx.db);
    page(req, res, {
      title: "Propose a missing release",
      nav: "contribute",
      body: html`<h1>Propose a missing release (version)</h1>
        <form method="post" action="/contribute/new-edition" enctype="multipart/form-data" class="form-narrow" novalidate>
          ${csrf(req)}${errorSummary(errors)}
          ${dups?.length ? duplicatePanel(dups) : ""}
          ${selectField({ label: "Master", name: "master_id", value: v.master_id, options: masters.map((r: any) => ({ value: String(r.id), label: `${r.artist} — ${r.title}` })), blank: "Choose the master this is a version of…", errors, required: true, hint: "Brand-new masters (not just versions) are a later milestone." })}
          ${releaseFields(v, errors, listLabels(ctx.db), facetValues(ctx.db).countries)}
          ${sourceFields(v, errors)}
          <div class="actions"><button class="btn btn-primary" type="submit">${dups?.length ? "Submit for review anyway" : "Check for duplicates and submit"}</button></div>
        </form>`,
    }, errors || dups ? 422 : 200);
  };

  app.get("/contribute/new-edition", (req, res) => renderNew(req, res, { master_id: req.query.master_id ?? req.query.release_id }));

  app.post("/contribute/new-edition", (req, res) => {
    const user = requireRole(req.state.user, "contributor");
    const masterId = Number(req.body.master_id);
    if (!masterId) return renderNew(req, res, req.body, { master_id: "Choose the master this is a version of." });
    try {
      const imagePaths = saveImages(ctx.config.uploadDir, "proposals", req.files as Express.Multer.File[]).map((path) => ({ path, caption: null }));
      const r = submitProposal(ctx.db, ctx.clock, user, { kind: "new_edition", master_id: masterId, target_release_id: null, body: req.body, imagePaths });
      if (!r.ok) return renderNew(req, res, req.body, undefined, r.duplicates);
      addFlash(req, "success", `Proposal #${r.proposalId} submitted. It is pending until a moderator reviews it.`);
      res.redirect(303, `/proposals/${r.proposalId}`);
    } catch (e) {
      if (e instanceof ValidationError) return renderNew(req, res, req.body, e.fields);
      throw e;
    }
  });

  const renderCorrection = (req: Request, res: Response, releaseId: number, v: Record<string, any>, errors?: FieldErrors) => {
    requireRole(req.state.user, "contributor");
    const e = getReleaseSummary(ctx.db, releaseId);
    if (!e) throw notFound("Release");
    const title = e.title;
    page(req, res, {
      title: "Propose a correction",
      nav: "contribute",
      body: html`<nav class="crumbs"><a href="/releases/${e.id}">${title} <span class="catno">${e.catalog_number ?? ""}</span></a> / <span>Correction</span></nav>
        <h1>Propose a correction</h1>
        <p class="muted">Edit the fields that are wrong. Only changed fields are recorded. Collectors' private notes and sellers' listing descriptions are never affected by archive edits.</p>
        <form method="post" action="/contribute/correction?release_id=${e.id}" enctype="multipart/form-data" class="form-narrow" novalidate>
          ${csrf(req)}${errorSummary(errors)}
          ${releaseFields(v, errors, [], facetValues(ctx.db).countries)}
          ${sourceFields(v, errors)}
          <div class="actions"><button class="btn btn-primary" type="submit">Submit correction for review</button><a class="btn btn-quiet" href="/releases/${e.id}">Cancel</a></div>
        </form>`,
    }, errors ? 422 : 200);
  };

  app.get("/contribute/correction", (req, res) => {
    const id = Number(req.query.release_id ?? req.query.edition_id);
    renderCorrection(req, res, id, releaseAsPayload(ctx.db, id));
  });

  app.post("/contribute/correction", (req, res) => {
    const user = requireRole(req.state.user, "contributor");
    const releaseId = Number(req.query.release_id ?? req.query.edition_id);
    const e = getReleaseSummary(ctx.db, releaseId);
    if (!e || !e.master_id) throw notFound("Release");
    try {
      const imagePaths = saveImages(ctx.config.uploadDir, "proposals", req.files as Express.Multer.File[]).map((path) => ({ path, caption: null }));
      const r = submitProposal(ctx.db, ctx.clock, user, { kind: "correction", master_id: e.master_id, target_release_id: releaseId, body: req.body, imagePaths });
      if (r.ok) {
        addFlash(req, "success", `Correction #${r.proposalId} submitted. The release is unchanged until a moderator accepts it.`);
        res.redirect(303, `/proposals/${r.proposalId}`);
      }
    } catch (err) {
      if (err instanceof ValidationError) return renderCorrection(req, res, releaseId, req.body, err.fields);
      throw err;
    }
  });

  // ───────── Review ─────────
  app.get("/proposals/:id", (req, res) => {
    const p = getProposal(ctx.db, req.state.user, idParam(req));
    const u = req.state.user!;
    const canReview = u.roles.includes("moderator") && p.status === "pending" && p.proposed_by !== u.id;
    const fmt = (v: unknown) => (v == null || v === "" ? "—" : String(v));
    page(req, res, {
      title: `Proposal #${p.id}`,
      nav: u.roles.includes("moderator") ? "moderate" : "contribute",
      body: html`<nav class="crumbs"><a href="${u.roles.includes("moderator") ? "/moderate" : "/contribute"}">${u.roles.includes("moderator") ? "Moderation queue" : "Contribute"}</a> / <span>Proposal #${p.id}</span></nav>
        <h1>${p.kind === "new_edition" ? "New release" : "Correction"} for ${p.release_title} ${statusBadge(p.status)}</h1>
        <p>Proposed by <strong>${p.proposed_by_name}</strong> on ${p.created_at.slice(0, 16).replace("T", " ")} UTC.
          ${p.reviewed_by_name ? html` ${p.status === "accepted" ? "Accepted" : "Rejected"} by <strong>${p.reviewed_by_name}</strong> on ${p.reviewed_at.slice(0, 16).replace("T", " ")} UTC.` : ""}</p>
        ${p.review_note ? html`<p class="panel"><strong>Moderator note:</strong> ${p.review_note}</p>` : ""}
        ${p.kind === "correction" ? html`<p><a href="/releases/${p.target_release_id}">View the current release</a></p>` : ""}
        ${p.resulting_release_id ? html`<p><a class="btn btn-quiet" href="/releases/${p.resulting_release_id}">View the release</a></p>` : ""}
        ${p.duplicate_ids.length ? html`<p class="panel dup">The contributor was shown possible duplicates and confirmed this is different: ${p.duplicate_ids.map((id: number) => html`<a href="/releases/${id}">release #${id}</a> `)}</p>` : ""}
        <h2>${p.status === "pending" && p.kind === "correction" ? "Proposed changes (compared with the current entry)" : "Proposed values"}</h2>
        ${p.changes.length
          ? html`<div class="table-wrap"><table class="diff compact"><thead><tr><th>Field</th>${p.kind === "correction" ? html`<th>Current</th>` : ""}<th>Proposed</th></tr></thead><tbody>
            ${p.changes.map((c: any) => html`<tr><th scope="row">${(PAYLOAD_FIELD_LABELS as any)[c.field]}</th>${p.kind === "correction" ? html`<td class="before">${fmt(c.before)}</td>` : ""}<td class="after">${fmt(c.after)}</td></tr>`)}
          </tbody></table></div>`
          : html`<p class="muted">${p.status === "pending" ? "No differences from the current entry (it may already have been corrected)." : "Changes are recorded in the release's revision history."}</p>`}
        <h2>Evidence</h2>
        <dl class="facts"><dt>Source type</dt><dd>${SOURCE_KINDS[p.source.source_kind]}</dd><dt>Citation</dt><dd>${p.source.source_citation}</dd>
          ${p.source.source_url ? html`<dt>URL</dt><dd>${p.source.source_url}</dd>` : ""}<dt>Notes</dt><dd>${p.source_notes}</dd></dl>
        ${p.images.length ? html`<div class="gallery">${p.images.map((im: any) => html`<img src="/media/proposal-image/${im.id}" alt="Supporting image for proposal ${p.id}" class="cover">`)}</div>` : html`<p class="muted small">No supporting images.</p>`}
        ${canReview
          ? html`<div class="panel"><h2>Review</h2>
              <p class="small">Accepting marks this release “Moderator-reviewed” against the cited source. It does not claim the entry is certain.</p>
              <form method="post" action="/proposals/${p.id}/accept">${csrf(req)}${textField({ label: "Note (optional)", name: "review_note" })}<button class="btn btn-primary" type="submit">Accept and apply</button></form>
              <form method="post" action="/proposals/${p.id}/reject">${csrf(req)}${textField({ label: "Reason for rejection", name: "review_note", required: true })}<button class="btn btn-danger" type="submit">Reject</button></form></div>`
          : p.status === "pending" && p.proposed_by === u.id && u.roles.includes("moderator")
            ? html`<p class="muted">You proposed this, so another moderator must review it.</p>`
            : ""}`,
    });
  });

  app.get("/moderate", (req, res) => {
    const u = requireRole(req.state.user, "moderator");
    const status = ["pending", "accepted", "rejected", ""].includes(String(req.query.status ?? "pending")) ? String(req.query.status ?? "pending") : "pending";
    const list = listProposals(ctx.db, u, status);
    page(req, res, {
      title: "Moderation queue",
      nav: "moderate",
      body: html`<h1>Moderation queue</h1>
        <p class="segmented">${["pending", "accepted", "rejected", ""].map((s) => html`<a href="/moderate?status=${s}" aria-current="${s === status}">${s || "all"}</a>`)}</p>
        ${list.length
          ? html`<div class="table-wrap"><table class="compact"><thead><tr><th>#</th><th>Type</th><th>Release</th><th>Proposed by</th><th>Status</th><th>Submitted</th></tr></thead><tbody>
              ${list.map((p) => html`<tr><td><a href="/proposals/${p.id}">#${p.id}</a></td><td>${p.kind === "new_edition" ? "New release" : "Correction"}</td><td>${p.release_title}</td><td>${p.proposed_by_name}${p.proposed_by === u.id ? raw(' <span class="muted small">(you)</span>') : ""}</td><td>${statusBadge(p.status)}</td><td class="small">${p.created_at.slice(0, 10)}</td></tr>`)}
            </tbody></table></div>`
          : html`<div class="empty"><h2>Nothing ${status || "here"}</h2><p>The queue is clear.</p></div>`}`,
    });
  });

  app.post("/proposals/:id/accept", (req, res) => {
    const releaseId = acceptProposal(ctx.db, ctx.clock, req.state.user, idParam(req), String(req.body.review_note ?? "").trim() || null);
    addFlash(req, "success", "Proposal accepted and applied. The revision is recorded.");
    res.redirect(303, `/releases/${releaseId}`);
  });

  app.post("/proposals/:id/reject", (req, res) => {
    rejectProposal(ctx.db, ctx.clock, req.state.user, idParam(req), String(req.body.review_note ?? ""));
    addFlash(req, "success", "Proposal rejected. The contributor can see your reason.");
    res.redirect(303, `/proposals/${req.params.id}`);
  });
}

