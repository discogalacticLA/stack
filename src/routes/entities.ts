/** Artist, label and company pages: catalog relationships, e.g. “everything pressed by this plant”. */
import type { Express } from "express";
import type { AppContext } from "../context.js";
import { notFound } from "../lib/errors.js";
import { html } from "../lib/html.js";
import { artistReleases, companyReleases, companyRoles, getArtist, getCompany, getLabel, labelReleases } from "../services/catalog-api/index.js";
import { idParam, page } from "./helpers.js";

const releaseRows = (rows: any[]) => html`<div class="table-wrap"><table class="compact"><thead><tr><th>Release</th><th>Cat. no.</th><th>Format</th><th>Country</th><th>Year</th><th>Role</th></tr></thead><tbody>
  ${rows.map((r) => html`<tr><td><a href="/releases/${r.id}">${r.title}</a></td><td><span class="catno">${r.catalog_number ?? "—"}</span></td><td>${r.format}</td><td>${r.country ?? "—"}</td><td>${r.year ?? "—"}</td><td class="small">${r.role ?? ""}</td></tr>`)}
</tbody></table></div>`;

const more = (base: string, rows: any[], limit: number, extra = "") => rows.length === limit ? html`<p><a href="${base}?after=${rows[rows.length - 1].id}${extra}">More →</a></p>` : "";

export function registerEntityRoutes(app: Express, ctx: AppContext) {
  const LIMIT = 50;
  app.get("/artists/:id", (req, res) => {
    const a = getArtist(ctx.db, idParam(req));
    if (!a) throw notFound("Artist");
    const rows = artistReleases(ctx.db, a.id, { after: Number(req.query.after) || 0, limit: LIMIT });
    page(req, res, {
      title: a.name, nav: "discover",
      body: html`<p class="muted small">Artist</p><h1>${a.name}</h1>
        ${a.real_name ? html`<p>Real name: ${a.real_name}</p>` : ""}
        ${a.profile ? html`<p class="prewrap">${a.profile}</p>` : ""}
        ${a.name_variations.length ? html`<p class="small">Also credited as: ${a.name_variations.join(", ")}</p>` : ""}
        ${a.aliases.length ? html`<p class="small">Aliases: ${a.aliases.map((x: any) => (x.alias_artist_id ? html`<a href="/artists/${x.alias_artist_id}">${x.name}</a> ` : html`${x.name} `))}</p>` : ""}
        ${a.members.length ? html`<p class="small">Members: ${a.members.map((x: any) => (x.member_artist_id ? html`<a href="/artists/${x.member_artist_id}">${x.name}</a> ` : html`${x.name} `))}</p>` : ""}
        ${a.groups.length ? html`<p class="small">In groups: ${a.groups.map((x: any) => html`<a href="/artists/${x.group_artist_id}">${x.name}</a> `)}</p>` : ""}
        ${a.discogs_artist_id ? html`<p class="small muted">Discogs artist ${a.discogs_artist_id}</p>` : ""}
        <h2>Releases and credits</h2>${rows.length ? releaseRows(rows) : html`<p class="muted">No releases found.</p>`}${more(`/artists/${a.id}`, rows, LIMIT)}`,
    });
  });

  app.get("/labels/:id", (req, res) => {
    const l = getLabel(ctx.db, idParam(req));
    if (!l) throw notFound("Label");
    const rows = labelReleases(ctx.db, l.id, { after: Number(req.query.after) || 0, limit: LIMIT });
    page(req, res, {
      title: l.name, nav: "discover",
      body: html`<p class="muted small">Label</p><h1>${l.name}</h1>
        ${l.parent ? html`<p class="small">Sublabel of <a href="/labels/${l.parent.id}">${l.parent.name}</a></p>` : ""}
        ${l.profile ? html`<p class="prewrap">${l.profile}</p>` : ""}
        ${l.sublabels.length ? html`<p class="small">Sublabels: ${l.sublabels.map((s: any) => html`<a href="/labels/${s.id}">${s.name}</a> `)}</p>` : ""}
        ${l.discogs_label_id ? html`<p class="small muted">Discogs label ${l.discogs_label_id}</p>` : ""}
        <h2>Releases</h2>${rows.length ? releaseRows(rows) : html`<p class="muted">No releases found.</p>`}${more(`/labels/${l.id}`, rows, LIMIT)}`,
    });
  });

  app.get("/companies/:id", (req, res) => {
    const c = getCompany(ctx.db, idParam(req));
    if (!c) throw notFound("Company");
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const rows = companyReleases(ctx.db, c.id, { role, after: Number(req.query.after) || 0, limit: LIMIT });
    const roles = companyRoles(ctx.db, c.id);
    page(req, res, {
      title: c.name, nav: "discover",
      body: html`<p class="muted small">Company (pressing plant, studio, distributor …)</p><h1>${c.name}</h1>
        <p class="segmented">${[{ role: "", n: roles.reduce((a, r) => a + r.n, 0) }, ...roles].map((r) => html`<a href="/companies/${c.id}${r.role ? `?role=${encodeURIComponent(r.role)}` : ""}" aria-current="${(role ?? "") === r.role}">${r.role || "All roles"} (${r.n})</a>`)}</p>
        ${rows.length ? releaseRows(rows) : html`<p class="muted">No releases found.</p>`}${more(`/companies/${c.id}`, rows, LIMIT, role ? `&role=${encodeURIComponent(role)}` : "")}`,
    });
  });
}
