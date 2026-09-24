import type { Express } from "express";
import type { AppContext } from "../context.js";
import { notFound } from "../lib/errors.js";
import { COUNTRY_CODES } from "../lib/reference.js";
import { browseCatalog } from "../domain/catalog.js";
import { getPublicListing, offersForRelease } from "../domain/listings.js";
import {
  artistReleases, companyReleases, findByDiscogsId, getArtist, getCompany, getLabel, getMasterRecord, getReleaseRecord, labelReleases, unifiedSearch,
} from "../services/catalog-api/index.js";
import type { EntityType } from "../services/search/index.js";
import { parseSearch } from "./catalog.js";
import { idParam } from "./helpers.js";

/**
 * Read-only public JSON API. Versioned under /api/v1. It only exposes catalog data and public
 * listing views, built from explicit column lists, so private user data can't leak through it.
 * List endpoints use cursor pagination (`?after=<last id>&limit=`).
 */
export function registerApiRoutes(app: Express, ctx: AppContext) {
  const cursor = (q: any) => ({ after: Math.max(0, Number(q.after) || 0), limit: Math.min(200, Math.max(1, Number(q.limit) || 50)) });
  const page = <T extends { id: number }>(items: T[], limit: number) => ({ items, next_after: items.length === limit ? items[items.length - 1].id : null });

  app.get("/api/v1/search", (req, res) => {
    const types = String(req.query.type ?? "").split(",").filter((t) => ["artist", "label", "master", "release"].includes(t)) as EntityType[];
    const q = String(req.query.q ?? "").slice(0, 200);
    res.json({ query: q, results: q ? unifiedSearch(ctx.db, q, { types, limit: Math.min(100, Number(req.query.limit) || 20), offset: Math.max(0, Number(req.query.offset) || 0) }) : [] });
  });

  app.get("/api/v1/releases/discogs/:id", (req, res) => {
    const id = findByDiscogsId(ctx.db, "release", idParam(req));
    if (!id) throw notFound("Release");
    res.json(getReleaseRecord(ctx.db, id));
  });
  app.get("/api/v1/releases/:id", (req, res) => {
    const r = getReleaseRecord(ctx.db, idParam(req));
    if (!r) throw notFound("Release");
    res.json(r);
  });
  app.get("/api/v1/masters/discogs/:id", (req, res) => {
    const id = findByDiscogsId(ctx.db, "master", idParam(req));
    if (!id) throw notFound("Master");
    res.json(getMasterRecord(ctx.db, id));
  });
  app.get("/api/v1/masters/:id", (req, res) => {
    const m = getMasterRecord(ctx.db, idParam(req));
    if (!m) throw notFound("Master");
    res.json(m);
  });
  app.get("/api/v1/artists/:id", (req, res) => {
    const a = getArtist(ctx.db, idParam(req));
    if (!a) throw notFound("Artist");
    res.json(a);
  });
  app.get("/api/v1/artists/:id/releases", (req, res) => {
    const c = cursor(req.query);
    res.json(page(artistReleases(ctx.db, idParam(req), c), c.limit));
  });
  app.get("/api/v1/labels/:id", (req, res) => {
    const l = getLabel(ctx.db, idParam(req));
    if (!l) throw notFound("Label");
    res.json(l);
  });
  app.get("/api/v1/labels/:id/releases", (req, res) => {
    const c = cursor(req.query);
    res.json(page(labelReleases(ctx.db, idParam(req), c), c.limit));
  });
  app.get("/api/v1/companies/:id", (req, res) => {
    const co = getCompany(ctx.db, idParam(req));
    if (!co) throw notFound("Company");
    res.json(co);
  });
  app.get("/api/v1/companies/:id/releases", (req, res) => {
    const c = cursor(req.query);
    res.json(page(companyReleases(ctx.db, idParam(req), { ...c, role: typeof req.query.role === "string" ? req.query.role : undefined }), c.limit));
  });
  app.get("/api/v1/releases/:id/offers", (req, res) => {
    const dest = COUNTRY_CODES.includes(String(req.query.dest)) ? String(req.query.dest) : null;
    res.json({ currency: "USD", currency_note: "Demo currency; taxes excluded; totals are estimates.", offers: offersForRelease(ctx.db, idParam(req), dest) });
  });
  app.get("/api/v1/listings/:id", (req, res) => {
    const l = getPublicListing(ctx.db, idParam(req));
    if (!l) throw notFound("Listing");
    res.json(l);
  });

  // Unversioned aliases kept for earlier clients and tests.
  app.get("/api/search", (req, res) => res.json(browseCatalog(ctx.db, parseSearch(req.query))));
  app.get("/api/listings/:id", (req, res) => {
    const l = getPublicListing(ctx.db, idParam(req));
    if (!l) throw notFound("Listing");
    res.json(l);
  });
  app.get(["/api/editions/:id/offers", "/api/releases/:id/offers"], (req, res) => {
    const dest = COUNTRY_CODES.includes(String(req.query.dest)) ? String(req.query.dest) : null;
    res.json({ currency: "USD", currency_note: "Demo currency; taxes excluded; totals are estimates.", offers: offersForRelease(ctx.db, idParam(req), dest) });
  });
}
