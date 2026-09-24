import type { Express } from "express";
import type { AppContext } from "../context.js";
import { notFound } from "../lib/errors.js";
import { COUNTRY_CODES } from "../lib/reference.js";
import { getRelease, searchReleases } from "../domain/catalog.js";
import { getPublicListing, offersForEdition } from "../domain/listings.js";
import { parseSearch } from "./catalog.js";
import { idParam } from "./helpers.js";

/**
 * Read-only public JSON API. It uses the same public serializers as the HTML pages, which
 * makes privacy easy to test: nothing here can include private copy fields.
 */
export function registerApiRoutes(app: Express, ctx: AppContext) {
  app.get("/api/search", (req, res) => {
    const p = parseSearch(req.query);
    res.json(searchReleases(ctx.db, p));
  });

  app.get("/api/releases/:id", (req, res) => {
    const r = getRelease(ctx.db, idParam(req));
    if (!r) throw notFound("Release");
    res.json(r);
  });

  app.get("/api/listings/:id", (req, res) => {
    const l = getPublicListing(ctx.db, idParam(req));
    if (!l) throw notFound("Listing");
    res.json(l);
  });

  app.get("/api/editions/:id/offers", (req, res) => {
    const dest = COUNTRY_CODES.includes(String(req.query.dest)) ? String(req.query.dest) : null;
    res.json({ currency: "USD", currency_note: "Demo currency; taxes excluded; totals are estimates.", offers: offersForEdition(ctx.db, idParam(req), dest) });
  });
}
