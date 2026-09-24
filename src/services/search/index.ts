/**
 * Catalog search. The domain talks to `SearchBackend`, never to a specific engine, so SQLite
 * FTS5 (today) can be replaced by PostgreSQL full-text, Meilisearch or OpenSearch without
 * changing importers or pages. Documents are small, denormalised views of catalog entities.
 */
import type { DB } from "../../db/index.js";
import { normalizeCode } from "../catalog-api/normalize.js";

export type EntityType = "artist" | "label" | "master" | "release";
export const ENTITY_CODES: Record<EntityType, number> = { artist: 1, label: 2, master: 3, release: 4 };
const CODE_TYPES = Object.fromEntries(Object.entries(ENTITY_CODES).map(([k, v]) => [v, k])) as Record<number, EntityType>;
const SHIFT = 2 ** 40;

export interface SearchDocument {
  type: EntityType;
  id: number;
  title: string;          // name or title
  people?: string;        // artists / credits
  codes?: string;         // catalog numbers, barcodes (raw and normalised)
  extra?: string;         // year, country, label, genres
}

export interface SearchHit { type: EntityType; id: number; score: number }

export interface SearchBackend {
  upsert(docs: SearchDocument[]): void;
  remove(refs: { type: EntityType; id: number }[]): void;
  search(query: string, opts?: { types?: EntityType[]; limit?: number; offset?: number }): SearchHit[];
  clear(): void;
}

/** Builds an FTS5 query: every word must match (prefix match on the last word). User syntax is neutralised. */
export function ftsQuery(q: string): string | null {
  const words = q.normalize("NFKC").split(/\s+/).map((w) => w.replace(/["*^():{}[\]\\]/g, "")).filter(Boolean).slice(0, 12);
  if (!words.length) return null;
  return words.map((w, i) => {
    const alts = [`"${w}"${i === words.length - 1 ? "*" : ""}`];
    const code = normalizeCode(w);
    if (code && code.length >= 3 && code !== w.toUpperCase()) alts.push(`"${code.toLowerCase()}"*`);
    return alts.length > 1 ? `(${alts.join(" OR ")})` : alts[0];
  }).join(" AND ");
}

export class SqliteFtsBackend implements SearchBackend {
  constructor(private db: DB) {}
  upsert(docs: SearchDocument[]) {
    const del = this.db.prepare("DELETE FROM catalog_search WHERE rowid = ?");
    const ins = this.db.prepare("INSERT INTO catalog_search (rowid, entity_type, entity_id, title, people, codes, extra) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const d of docs) {
      const rowid = ENTITY_CODES[d.type] * SHIFT + d.id;
      del.run(rowid);
      ins.run(rowid, d.type, d.id, d.title, d.people ?? "", d.codes ?? "", d.extra ?? "");
    }
  }
  remove(refs: { type: EntityType; id: number }[]) {
    const del = this.db.prepare("DELETE FROM catalog_search WHERE rowid = ?");
    for (const r of refs) del.run(ENTITY_CODES[r.type] * SHIFT + r.id);
  }
  search(query: string, opts: { types?: EntityType[]; limit?: number; offset?: number } = {}): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const types = opts.types?.length ? opts.types : (Object.keys(ENTITY_CODES) as EntityType[]);
    const ranges = types.map((t) => `(rowid BETWEEN ${ENTITY_CODES[t] * SHIFT} AND ${(ENTITY_CODES[t] + 1) * SHIFT - 1})`).join(" OR ");
    // Weight title highest, then codes (catalog numbers / barcodes), then people.
    const rows = this.db
      .prepare(`SELECT rowid AS r, bm25(catalog_search, 0, 0, 10.0, 3.0, 6.0, 1.0) AS score FROM catalog_search WHERE catalog_search MATCH ? AND (${ranges}) ORDER BY score LIMIT ? OFFSET ?`)
      .all(match, opts.limit ?? 20, opts.offset ?? 0) as { r: number; score: number }[];
    return rows.map((x) => ({ type: CODE_TYPES[Math.floor(x.r / SHIFT)], id: x.r % SHIFT, score: x.score }));
  }
  clear() {
    this.db.prepare("DELETE FROM catalog_search").run();
  }
}

export const searchBackend = (db: DB): SearchBackend => new SqliteFtsBackend(db);

// ───────────────────────── Document builders (read the catalog tables) ─────────────────────────
const joinCredits = (rows: { name: string; anv: string | null; join_text: string }[]) =>
  rows.map((r) => (r.anv || r.name) + (r.join_text ? ` ${r.join_text.trim()} ` : " ")).join("").replace(/\s+/g, " ").trim();

export function releaseDocuments(db: DB, ids: number[]): SearchDocument[] {
  const artistsQ = db.prepare("SELECT name, anv, join_text FROM release_artists WHERE release_id = ? ORDER BY position");
  const labelsQ = db.prepare("SELECT name, catalog_number FROM release_labels WHERE release_id = ? ORDER BY position");
  const idsQ = db.prepare("SELECT value, normalized_value FROM release_identifiers WHERE release_id = ? AND identifier_type IN ('Barcode', 'Matrix / Runout', 'Label Code')");
  const relQ = db.prepare("SELECT id, title, year, country, catalog_number, format FROM releases WHERE id = ?");
  const out: SearchDocument[] = [];
  for (const id of ids) {
    const r = relQ.get(id) as any;
    if (!r) continue;
    const labels = labelsQ.all(id) as any[];
    const codes = new Set<string>();
    for (const l of labels) if (l.catalog_number) { codes.add(l.catalog_number); const n = normalizeCode(l.catalog_number); if (n) codes.add(n); }
    if (r.catalog_number) { codes.add(r.catalog_number); const n = normalizeCode(r.catalog_number); if (n) codes.add(n); }
    for (const i of idsQ.all(id) as any[]) { codes.add(i.value); if (i.normalized_value) codes.add(i.normalized_value); }
    out.push({
      type: "release", id, title: r.title,
      people: joinCredits(artistsQ.all(id) as any[]),
      codes: [...codes].join(" "),
      extra: [labels.map((l) => l.name).join(" "), r.year, r.country, r.format].filter(Boolean).join(" "),
    });
  }
  return out;
}

export function masterDocuments(db: DB, ids: number[]): SearchDocument[] {
  const q = db.prepare("SELECT id, title, year FROM masters WHERE id = ?");
  const a = db.prepare("SELECT name, anv, join_text FROM master_artists WHERE master_id = ? ORDER BY position");
  return ids.map((id) => q.get(id) as any).filter(Boolean).map((m) => ({ type: "master" as const, id: m.id, title: m.title, people: joinCredits(a.all(m.id) as any[]), extra: m.year ? String(m.year) : "" }));
}

export function artistDocuments(db: DB, ids: number[]): SearchDocument[] {
  const q = db.prepare("SELECT id, name, real_name FROM artists WHERE id = ?");
  const v = db.prepare("SELECT name FROM artist_name_variations WHERE artist_id = ? LIMIT 20");
  const al = db.prepare("SELECT name FROM artist_aliases WHERE artist_id = ? LIMIT 20");
  return ids.map((id) => q.get(id) as any).filter(Boolean).map((x) => ({
    type: "artist" as const, id: x.id, title: x.name,
    people: [x.real_name, ...(v.all(x.id) as any[]).map((r) => r.name), ...(al.all(x.id) as any[]).map((r) => r.name)].filter(Boolean).join(" "),
  }));
}

export function labelDocuments(db: DB, ids: number[]): SearchDocument[] {
  const q = db.prepare("SELECT id, name FROM labels WHERE id = ?");
  return ids.map((id) => q.get(id) as any).filter(Boolean).map((x) => ({ type: "label" as const, id: x.id, title: x.name }));
}

/** Rebuilds the whole index from catalog tables (used after migrations and by `catalog search:reindex`). */
export function reindexAll(db: DB, backend: SearchBackend = searchBackend(db), batch = 5000): number {
  backend.clear();
  let n = 0;
  const each = (table: string, build: (db: DB, ids: number[]) => SearchDocument[]) => {
    let last = 0;
    for (;;) {
      const ids = (db.prepare(`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`).all(last, batch) as { id: number }[]).map((r) => r.id);
      if (!ids.length) break;
      db.transaction(() => backend.upsert(build(db, ids)))();
      n += ids.length;
      last = ids[ids.length - 1];
    }
  };
  each("artists", artistDocuments);
  each("labels", labelDocuments);
  each("masters", masterDocuments);
  each("releases", releaseDocuments);
  return n;
}
