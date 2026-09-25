/**
 * Catalog read service: entities by internal id or Discogs id, relationships, and unified search.
 * Returns plain objects; never includes user-owned data (collections, notes, locations, paths).
 * Used by the versioned JSON API (/api/v1/…) and by the artist/label/company pages.
 */
import type { DB } from "../../db/index.js";
import { searchBackend, type EntityType } from "../search/index.js";
import { artistCredit, creditForRelease } from "../../domain/catalog.js";

export interface SearchResultItem {
  type: EntityType;
  id: number;
  title: string;
  artist?: string | null;
  year?: number | null;
  country?: string | null;
  label?: string | null;
  catalog_number?: string | null;
  format?: string | null;
  url: string;
}

const URL: Record<EntityType, (id: number) => string> = {
  artist: (id) => `/artists/${id}`, label: (id) => `/labels/${id}`, master: (id) => `/masters/${id}`, release: (id) => `/releases/${id}`,
};

/** One search box across artists, masters, releases and labels (catalog numbers and barcodes match releases). */
export function unifiedSearch(db: DB, q: string, opts: { types?: EntityType[]; limit?: number; offset?: number } = {}): SearchResultItem[] {
  const hits = searchBackend(db).search(q, opts);
  const out: SearchResultItem[] = [];
  for (const h of hits) {
    if (h.type === "release") {
      const r = db.prepare("SELECT e.id, e.title, e.year, e.country, e.catalog_number, e.format, e.master_id, l.name AS label FROM releases e LEFT JOIN labels l ON l.id = e.label_id WHERE e.id = ?").get(h.id) as any;
      if (r) out.push({ type: "release", id: r.id, title: r.title, artist: creditForRelease(db, r), year: r.year, country: r.country, label: r.label, catalog_number: r.catalog_number, format: r.format, url: URL.release(r.id) });
    } else if (h.type === "master") {
      const m = db.prepare("SELECT id, title, year FROM masters WHERE id = ?").get(h.id) as any;
      if (m) out.push({ type: "master", id: m.id, title: m.title, year: m.year, artist: artistCredit(db, m.id), url: URL.master(m.id) });
    } else if (h.type === "artist") {
      const a = db.prepare("SELECT id, name FROM artists WHERE id = ?").get(h.id) as any;
      if (a) out.push({ type: "artist", id: a.id, title: a.name, url: URL.artist(a.id) });
    } else {
      const l = db.prepare("SELECT id, name FROM labels WHERE id = ?").get(h.id) as any;
      if (l) out.push({ type: "label", id: l.id, title: l.name, url: URL.label(l.id) });
    }
  }
  return out;
}

const json = (s: string | null) => (s ? JSON.parse(s) : []);

export function getArtist(db: DB, id: number) {
  const a = db.prepare("SELECT id, discogs_artist_id, name, real_name, profile, urls, data_quality, created_at, updated_at FROM artists WHERE id = ?").get(id) as any;
  if (!a) return null;
  return {
    ...a,
    urls: json(a.urls),
    aliases: db.prepare("SELECT alias_artist_id, discogs_alias_id, name FROM artist_aliases WHERE artist_id = ? ORDER BY name").all(id),
    name_variations: db.prepare("SELECT name FROM artist_name_variations WHERE artist_id = ? ORDER BY name").all(id).map((r: any) => r.name),
    members: db.prepare("SELECT member_artist_id, discogs_member_id, name FROM artist_members WHERE group_artist_id = ? ORDER BY name").all(id),
    groups: db.prepare("SELECT am.group_artist_id, a.name FROM artist_members am JOIN artists a ON a.id = am.group_artist_id WHERE am.member_artist_id = ? ORDER BY a.name").all(id),
  };
}

/** Releases an artist appears on, as main artist or credited contributor (with the role). Cursor-paginated by release id. */
export function artistReleases(db: DB, artistId: number, opts: { after?: number; limit?: number } = {}) {
  return db.prepare(
    `SELECT e.id, e.title, e.year, e.country, e.catalog_number, e.format, e.master_id, x.role FROM (
       SELECT release_id, 'Main artist' AS role FROM release_artists WHERE artist_id = ?
       UNION SELECT release_id, role FROM release_extra_artists WHERE artist_id = ?
     ) x JOIN releases e ON e.id = x.release_id WHERE e.id > ? ORDER BY e.id LIMIT ?`,
  ).all(artistId, artistId, opts.after ?? 0, opts.limit ?? 50) as any[];
}

export function getLabel(db: DB, id: number) {
  const l = db.prepare("SELECT id, discogs_label_id, name, profile, contact_info, urls, parent_label_id, data_quality, created_at, updated_at FROM labels WHERE id = ?").get(id) as any;
  if (!l) return null;
  return {
    ...l,
    urls: json(l.urls),
    parent: l.parent_label_id ? db.prepare("SELECT id, name FROM labels WHERE id = ?").get(l.parent_label_id) : null,
    sublabels: db.prepare("SELECT id, name FROM labels WHERE parent_label_id = ? ORDER BY name LIMIT 200").all(id),
  };
}

export function labelReleases(db: DB, labelId: number, opts: { after?: number; limit?: number } = {}) {
  return db.prepare(
    `SELECT e.id, e.title, e.year, e.country, rl.catalog_number, e.format, e.master_id FROM release_labels rl JOIN releases e ON e.id = rl.release_id
     WHERE rl.label_id = ? AND e.id > ? ORDER BY e.id LIMIT ?`,
  ).all(labelId, opts.after ?? 0, opts.limit ?? 50) as any[];
}

export function getCompany(db: DB, id: number) {
  return (db.prepare("SELECT id, discogs_company_id, name, company_type, country, created_at, updated_at FROM companies WHERE id = ?").get(id) as any) ?? null;
}

/** e.g. "everything pressed by X" — grouped by role, cursor-paginated. */
export function companyReleases(db: DB, companyId: number, opts: { role?: string; after?: number; limit?: number } = {}) {
  return db.prepare(
    `SELECT e.id, e.title, e.year, e.country, e.catalog_number, e.format, e.master_id, rc.role FROM release_companies rc JOIN releases e ON e.id = rc.release_id
     WHERE rc.company_id = ? AND (? IS NULL OR rc.role = ?) AND e.id > ? ORDER BY e.id LIMIT ?`,
  ).all(companyId, opts.role ?? null, opts.role ?? null, opts.after ?? 0, opts.limit ?? 50) as any[];
}

export function companyRoles(db: DB, companyId: number) {
  return db.prepare("SELECT role, COUNT(*) AS n FROM release_companies WHERE company_id = ? GROUP BY role ORDER BY n DESC").all(companyId) as { role: string; n: number }[];
}

export function getMasterRecord(db: DB, id: number) {
  const m = db.prepare("SELECT id, discogs_master_id, title, year, main_release_id, main_release_discogs_id, data_quality, notes, created_at, updated_at FROM masters WHERE id = ?").get(id) as any;
  if (!m) return null;
  return {
    ...m,
    artists: db.prepare("SELECT artist_id, discogs_artist_id, name, anv, join_text, role FROM master_artists WHERE master_id = ? ORDER BY position").all(id),
    genres: db.prepare("SELECT genre FROM master_genres WHERE master_id = ?").all(id).map((r: any) => r.genre),
    styles: db.prepare("SELECT style FROM master_styles WHERE master_id = ?").all(id).map((r: any) => r.style),
    release_ids: db.prepare("SELECT id FROM releases WHERE master_id = ? ORDER BY year, id").all(id).map((r: any) => r.id),
  };
}

/** Full normalised release record with all relationships (the shape the JSON API returns). */
export function getReleaseRecord(db: DB, id: number) {
  const r = db.prepare(
    "SELECT id, discogs_release_id, master_id, discogs_master_id, title, year, released_date, country, status, notes, data_quality, verification_status, created_at, updated_at FROM releases WHERE id = ?",
  ).get(id) as any;
  if (!r) return null;
  const tracks = db.prepare("SELECT id, parent_track_id, track_type, position, title, duration, duration_seconds, artist_credit, sequence FROM release_tracks WHERE release_id = ? ORDER BY sequence, id").all(id) as any[];
  const trackArtists = db.prepare("SELECT artist_id, discogs_artist_id, name, anv, join_text FROM release_track_artists WHERE track_id = ? ORDER BY position");
  const trackCredits = db.prepare("SELECT artist_id, discogs_artist_id, name, anv, role FROM release_extra_artists WHERE track_id = ? ORDER BY position");
  return {
    ...r,
    artists: db.prepare("SELECT artist_id, discogs_artist_id, name, anv, join_text, role FROM release_artists WHERE release_id = ? ORDER BY position").all(id),
    extra_artists: db.prepare("SELECT artist_id, discogs_artist_id, name, anv, role, tracks FROM release_extra_artists WHERE release_id = ? AND track_id IS NULL ORDER BY position").all(id),
    labels: db.prepare("SELECT label_id, discogs_label_id, name, catalog_number FROM release_labels WHERE release_id = ? ORDER BY position").all(id),
    series: db.prepare("SELECT label_id, discogs_label_id, name, catalog_number FROM release_series WHERE release_id = ? ORDER BY position").all(id),
    companies: db.prepare("SELECT rc.company_id, c.discogs_company_id, c.name, rc.role, rc.entity_type, rc.catalog_number FROM release_companies rc LEFT JOIN companies c ON c.id = rc.company_id WHERE rc.release_id = ? ORDER BY rc.position").all(id),
    formats: (db.prepare("SELECT id, name, quantity, text FROM release_formats WHERE release_id = ? ORDER BY position").all(id) as any[]).map((f) => ({
      name: f.name, quantity: f.quantity, text: f.text,
      descriptions: db.prepare("SELECT description FROM release_format_descriptions WHERE format_id = ? ORDER BY position").all(f.id).map((d: any) => d.description),
    })),
    genres: db.prepare("SELECT genre FROM release_genres WHERE release_id = ?").all(id).map((x: any) => x.genre),
    styles: db.prepare("SELECT style FROM release_styles WHERE release_id = ?").all(id).map((x: any) => x.style),
    identifiers: db.prepare("SELECT identifier_type AS type, value, description FROM release_identifiers WHERE release_id = ? ORDER BY id").all(id),
    tracks: tracks.map((t) => ({ ...t, artists: trackArtists.all(t.id), extra_artists: trackCredits.all(t.id) })),
    external_ids: db.prepare("SELECT cs.name AS source, ei.external_id FROM external_identifiers ei JOIN catalog_sources cs ON cs.id = ei.source_id WHERE ei.entity_type = 'release' AND ei.entity_id = ?").all(id),
  };
}

export function findByDiscogsId(db: DB, type: EntityType, discogsId: number): number | null {
  const col = { artist: ["artists", "discogs_artist_id"], label: ["labels", "discogs_label_id"], master: ["masters", "discogs_master_id"], release: ["releases", "discogs_release_id"] }[type];
  const r = db.prepare(`SELECT id FROM ${col[0]} WHERE ${col[1]} = ?`).get(discogsId) as { id: number } | undefined;
  return r?.id ?? null;
}
