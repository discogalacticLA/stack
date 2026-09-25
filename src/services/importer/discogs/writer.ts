/**
 * Writes normalised Discogs records into the catalog, one batch per transaction (the caller owns
 * the transaction). Per batch, every referenced Discogs id is resolved with a few `IN (…)` lookups
 * instead of one query per relationship. Records are matched by Discogs id, so:
 *   new → INSERT · changed (content hash differs) → UPDATE + replace child rows · unchanged → skip.
 * Internal ids never change, so user copies, wants and listings that reference them are preserved.
 * Records with local editorial edits (`local_edited_at`) are not overwritten; a conflict is logged.
 * Missing referenced entities (e.g. an artist not imported yet) are stored as NULL + Discogs id and
 * resolved later by `reconcileReferences`.
 */
import crypto from "node:crypto";
import type { DB } from "../../../db/index.js";
import { normalizeCode, normalizeName } from "../../catalog-api/normalize.js";
import { searchBackend, type SearchBackend, type SearchDocument } from "../../search/index.js";
import { joinText, releasePrimary, type ArtistRecord, type Credit, type LabelRecord, type MasterRecord, type ReleaseRecord, type TrackRecord } from "./normalize.js";

export interface BatchResult {
  created: number;
  updated: number;
  unchanged: number;
  skippedLocal: number;
  unresolved: number;
  conflicts: { externalId: string; message: string }[];
  lastExternalId: string | null;
}

const hashOf = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const empty = (): BatchResult => ({ created: 0, updated: 0, unchanged: 0, skippedLocal: 0, unresolved: 0, conflicts: [], lastExternalId: null });

/** Deduplicates by Discogs id within a batch (last occurrence wins; earlier ones count as unchanged). */
function dedupe<T extends { discogs_id: number }>(records: T[], res: BatchResult): T[] {
  const byId = new Map<number, T>();
  for (const r of records) {
    if (byId.has(r.discogs_id)) res.unchanged++;
    byId.set(r.discogs_id, r);
  }
  return [...byId.values()];
}

function lookup(db: DB, table: string, col: string, ids: (number | null)[], extra = ""): Map<number, any> {
  const unique = [...new Set(ids.filter((x): x is number => x != null))];
  const out = new Map<number, any>();
  for (let i = 0; i < unique.length; i += 500) {
    const part = unique.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id, ${col} AS ext${extra} FROM ${table} WHERE ${col} IN (${part.map(() => "?").join(",")})`).all(...part) as any[]) out.set(r.ext, r);
  }
  return out;
}

/** Milliseconds spent per phase inside the writer (for benchmarking; see docs/DISCOGS_IMPORT.md). */
export interface WriterTimings { lookup: number; hash: number; provenance: number; search: number; total: number }

export interface WriterOptions {
  /**
   * Where search documents go. `null` = deferred: no documents are built or written during the
   * import, and the caller rebuilds the index afterwards with `reindexAll()`. Any SearchBackend
   * works (SQLite FTS today, Postgres/OpenSearch later).
   */
  search?: SearchBackend | null;
  /** Time every prepared statement the writer runs (small overhead; for benchmarks). */
  profile?: boolean;
}

export interface StatementTime { sql: string; ms: number; calls: number }

export class DiscogsCatalogWriter {
  private sourceId: number;
  private stmts: Record<string, any> = {};
  private search: SearchBackend | null;
  readonly timings: WriterTimings = { lookup: 0, hash: 0, provenance: 0, search: 0, total: 0 };
  readonly statementTimes = new Map<string, StatementTime>();
  private profile: boolean;
  constructor(private db: DB, private runId: number, private now: () => string, opts: WriterOptions = {}) {
    this.sourceId = (db.prepare("SELECT id FROM catalog_sources WHERE name = 'discogs'").get() as { id: number }).id;
    this.search = opts.search === undefined ? searchBackend(db) : opts.search;
    this.profile = !!opts.profile;
    db.exec("CREATE TEMP TABLE IF NOT EXISTS reconcile_scope (entity TEXT NOT NULL, ext INTEGER NOT NULL, PRIMARY KEY (entity, ext)) WITHOUT ROWID");
  }

  /** Records the batch's Discogs ids so the run's reconcile only looks at rows pointing at them. */
  private scope(entity: ScopeEntity, ids: number[]) {
    this.st("INSERT OR IGNORE INTO temp.reconcile_scope (entity, ext) SELECT ?, value FROM json_each(?)").run(entity, JSON.stringify(ids));
  }

  private timed<T>(phase: keyof WriterTimings, fn: () => T): T {
    const t = performance.now();
    try { return fn(); } finally { this.timings[phase] += performance.now() - t; }
  }

  private lookup(table: string, col: string, ids: (number | null)[], extra = "") {
    return this.timed("lookup", () => lookup(this.db, table, col, ids, extra));
  }

  private hash(v: unknown) {
    return this.timed("hash", () => hashOf(v));
  }

  private index(docs: SearchDocument[] | null) {
    if (docs && this.search) this.timed("search", () => this.search!.upsert(docs));
  }

  private st(sql: string) {
    return (this.stmts[sql] ??= this.profile ? this.timedStatement(sql) : this.db.prepare(sql));
  }

  private timedStatement(sql: string) {
    const stmt = this.db.prepare(sql);
    const key = sql.replace(/\s+/g, " ").trim().slice(0, 100);
    const rec = this.statementTimes.get(key) ?? { sql: key, ms: 0, calls: 0 };
    this.statementTimes.set(key, rec);
    const wrap = <F extends (...a: any[]) => any>(f: F) => ((...a: any[]) => {
      const t = performance.now();
      try { return f.apply(stmt, a); } finally { rec.ms += performance.now() - t; rec.calls++; }
    }) as F;
    return { run: wrap(stmt.run), get: wrap(stmt.get), all: wrap(stmt.all) };
  }

  private provenance(entity: string, ids: number[]): Map<number, string> {
    return this.timed("provenance", () => this.provenanceLookup(entity, ids));
  }

  private provenanceLookup(entity: string, ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of this.db.prepare(`SELECT entity_id, content_hash FROM catalog_provenance WHERE entity_type = ? AND source_id = ? AND entity_id IN (${part.map(() => "?").join(",")})`)
        .all(entity, this.sourceId, ...part) as any[]) out.set(r.entity_id, r.content_hash);
    }
    return out;
  }

  private touch(entity: string, id: number, hash: string, now: string) {
    const t = performance.now();
    this.st(`INSERT INTO catalog_provenance (entity_type, entity_id, source_id, content_hash, import_run_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (entity_type, entity_id, source_id) DO UPDATE SET content_hash = excluded.content_hash, import_run_id = excluded.import_run_id, last_seen_at = excluded.last_seen_at`)
      .run(entity, id, this.sourceId, hash, this.runId, now, now);
    this.timings.provenance += performance.now() - t;
  }

  private externalId(entity: string, id: number, ext: number, now: string) {
    const t = performance.now();
    this.st("INSERT OR IGNORE INTO external_identifiers (entity_type, entity_id, source_id, external_id, created_at) VALUES (?, ?, ?, ?, ?)").run(entity, id, this.sourceId, String(ext), now);
    this.timings.provenance += performance.now() - t;
  }

  /** Decides what to do with a record; returns the internal id when it should be written. */
  private classify(entity: string, existing: any, provHash: string | undefined, hash: string, discogsId: number, res: BatchResult, now: string): "insert" | "update" | "skip" {
    if (!existing) return "insert";
    if (provHash === hash) {
      res.unchanged++;
      this.touch(entity, existing.id, hash, now);
      return "skip";
    }
    if (existing.local_edited_at) {
      res.skippedLocal++;
      res.conflicts.push({ externalId: String(discogsId), message: `Local editorial edits (since ${existing.local_edited_at}) were kept; the Discogs update for this ${entity} was not applied.` });
      return "skip";
    }
    return "update";
  }

  // ───────────────────────── Artists ─────────────────────────
  writeArtists(input: ArtistRecord[]): BatchResult {
    return this.timed("total", () => this.writeArtistsBatch(input));
  }

  private writeArtistsBatch(input: ArtistRecord[]): BatchResult {
    const res = empty();
    const records = dedupe(input, res);
    this.scope("artist", records.map((r) => r.discogs_id));
    const now = this.now();
    const existing = this.lookup("artists", "discogs_artist_id", records.map((r) => r.discogs_id), ", local_edited_at");
    const prov = this.provenance("artist", [...existing.values()].map((e) => e.id));
    const refs = this.lookup("artists", "discogs_artist_id", records.flatMap((r) => [...r.aliases, ...r.members].map((x) => x.discogs_id)));
    const docs: SearchDocument[] | null = this.search ? [] : null;
    for (const r of records) {
      const hash = this.hash(r);
      const ex = existing.get(r.discogs_id);
      const action = this.classify("artist", ex, prov.get(ex?.id), hash, r.discogs_id, res, now);
      res.lastExternalId = String(r.discogs_id);
      if (action === "skip") continue;
      let id: number;
      if (action === "insert") {
        id = Number(this.st(`INSERT INTO artists (discogs_artist_id, name, sort_name, normalized_name, real_name, profile, urls, data_quality, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.discogs_id, r.name, r.name, r.normalized_name, r.real_name, r.profile, JSON.stringify(r.urls), r.data_quality, now, now).lastInsertRowid);
        this.externalId("artist", id, r.discogs_id, now);
        res.created++;
      } else {
        id = ex.id;
        this.st("UPDATE artists SET name = ?, normalized_name = ?, real_name = ?, profile = ?, urls = ?, data_quality = ?, updated_at = ? WHERE id = ?")
          .run(r.name, r.normalized_name, r.real_name, r.profile, JSON.stringify(r.urls), r.data_quality, now, id);
        for (const t of ["artist_aliases", "artist_name_variations"]) this.st(`DELETE FROM ${t} WHERE artist_id = ?`).run(id);
        this.st("DELETE FROM artist_members WHERE group_artist_id = ?").run(id);
        res.updated++;
      }
      for (const a of r.aliases) {
        const aliasId = a.discogs_id != null ? refs.get(a.discogs_id)?.id ?? null : null;
        if (a.discogs_id != null && aliasId == null) res.unresolved++;
        this.st("INSERT INTO artist_aliases (artist_id, alias_artist_id, discogs_alias_id, name) VALUES (?, ?, ?, ?)").run(id, aliasId, a.discogs_id, a.name);
      }
      for (const v of r.name_variations) this.st("INSERT INTO artist_name_variations (artist_id, name) VALUES (?, ?)").run(id, v);
      for (const m of r.members) {
        const memberId = m.discogs_id != null ? refs.get(m.discogs_id)?.id ?? null : null;
        if (m.discogs_id != null && memberId == null) res.unresolved++;
        this.st("INSERT INTO artist_members (group_artist_id, member_artist_id, discogs_member_id, name) VALUES (?, ?, ?, ?)").run(id, memberId, m.discogs_id, m.name);
      }
      this.touch("artist", id, hash, now);
      docs?.push({ type: "artist", id, title: r.name, people: [r.real_name, ...r.name_variations, ...r.aliases.map((a) => a.name)].filter(Boolean).join(" ") });
    }
    this.index(docs);
    return res;
  }

  // ───────────────────────── Labels ─────────────────────────
  writeLabels(input: LabelRecord[]): BatchResult {
    return this.timed("total", () => this.writeLabelsBatch(input));
  }

  private writeLabelsBatch(input: LabelRecord[]): BatchResult {
    const res = empty();
    const records = dedupe(input, res);
    this.scope("label", records.map((r) => r.discogs_id));
    const now = this.now();
    const existing = this.lookup("labels", "discogs_label_id", records.map((r) => r.discogs_id), ", local_edited_at");
    const prov = this.provenance("label", [...existing.values()].map((e) => e.id));
    const parents = this.lookup("labels", "discogs_label_id", records.map((r) => r.parent_discogs_id));
    const docs: SearchDocument[] | null = this.search ? [] : null;
    for (const r of records) {
      const hash = this.hash(r);
      const ex = existing.get(r.discogs_id);
      const action = this.classify("label", ex, prov.get(ex?.id), hash, r.discogs_id, res, now);
      res.lastExternalId = String(r.discogs_id);
      if (action === "skip") continue;
      const parentId = r.parent_discogs_id != null ? parents.get(r.parent_discogs_id)?.id ?? null : null;
      if (r.parent_discogs_id != null && parentId == null) res.unresolved++;
      let id: number;
      if (action === "insert") {
        id = Number(this.st(`INSERT INTO labels (discogs_label_id, name, normalized_name, profile, contact_info, urls, parent_label_id, parent_discogs_label_id, data_quality, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.discogs_id, r.name, r.normalized_name, r.profile, r.contact_info, JSON.stringify(r.urls), parentId, r.parent_discogs_id, r.data_quality, now, now).lastInsertRowid);
        this.externalId("label", id, r.discogs_id, now);
        res.created++;
      } else {
        id = ex.id;
        this.st("UPDATE labels SET name = ?, normalized_name = ?, profile = ?, contact_info = ?, urls = ?, parent_label_id = ?, parent_discogs_label_id = ?, data_quality = ?, updated_at = ? WHERE id = ?")
          .run(r.name, r.normalized_name, r.profile, r.contact_info, JSON.stringify(r.urls), parentId, r.parent_discogs_id, r.data_quality, now, id);
        res.updated++;
      }
      this.touch("label", id, hash, now);
      docs?.push({ type: "label", id, title: r.name });
    }
    this.index(docs);
    return res;
  }

  // ───────────────────────── Masters ─────────────────────────
  writeMasters(input: MasterRecord[]): BatchResult {
    return this.timed("total", () => this.writeMastersBatch(input));
  }

  private writeMastersBatch(input: MasterRecord[]): BatchResult {
    const res = empty();
    const records = dedupe(input, res);
    this.scope("master", records.map((r) => r.discogs_id));
    const now = this.now();
    const existing = this.lookup("masters", "discogs_master_id", records.map((r) => r.discogs_id), ", local_edited_at");
    const prov = this.provenance("master", [...existing.values()].map((e) => e.id));
    const artists = this.lookup("artists", "discogs_artist_id", records.flatMap((r) => r.artists.map((a) => a.discogs_artist_id)));
    const mains = this.lookup("releases", "discogs_release_id", records.map((r) => r.main_release_discogs_id));
    const docs: SearchDocument[] | null = this.search ? [] : null;
    for (const r of records) {
      const hash = this.hash(r);
      const ex = existing.get(r.discogs_id);
      const action = this.classify("master", ex, prov.get(ex?.id), hash, r.discogs_id, res, now);
      res.lastExternalId = String(r.discogs_id);
      if (action === "skip") continue;
      const mainId = r.main_release_discogs_id != null ? mains.get(r.main_release_discogs_id)?.id ?? null : null;
      let id: number;
      if (action === "insert") {
        id = Number(this.st(`INSERT INTO masters (discogs_master_id, title, normalized_title, release_type, year, main_release_discogs_id, main_release_id, data_quality, notes, created_at, updated_at)
          VALUES (?, ?, ?, 'other', ?, ?, ?, ?, ?, ?, ?)`).run(r.discogs_id, r.title, r.normalized_title, r.year, r.main_release_discogs_id, mainId, r.data_quality, r.notes, now, now).lastInsertRowid);
        this.externalId("master", id, r.discogs_id, now);
        res.created++;
      } else {
        id = ex.id;
        this.st("UPDATE masters SET title = ?, normalized_title = ?, year = ?, main_release_discogs_id = ?, main_release_id = ?, data_quality = ?, notes = ?, updated_at = ? WHERE id = ?")
          .run(r.title, r.normalized_title, r.year, r.main_release_discogs_id, mainId, r.data_quality, r.notes, now, id);
        for (const t of ["master_artists", "master_genres", "master_styles"]) this.st(`DELETE FROM ${t} WHERE master_id = ?`).run(id);
        res.updated++;
      }
      r.artists.forEach((a, i) => {
        const aid = a.discogs_artist_id != null ? artists.get(a.discogs_artist_id)?.id ?? null : null;
        if (a.discogs_artist_id != null && aid == null) res.unresolved++;
        this.st("INSERT INTO master_artists (master_id, artist_id, discogs_artist_id, name, anv, join_text, role, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, aid, a.discogs_artist_id, a.name, a.anv, joinText(a.join), a.role, i);
      });
      for (const g of r.genres) this.st("INSERT INTO master_genres (master_id, genre) VALUES (?, ?)").run(id, g);
      for (const s of r.styles) this.st("INSERT INTO master_styles (master_id, style) VALUES (?, ?)").run(id, s);
      this.touch("master", id, hash, now);
      docs?.push({ type: "master", id, title: r.title, people: creditLine(r.artists), extra: r.year ? String(r.year) : "" });
    }
    this.index(docs);
    return res;
  }

  // ───────────────────────── Releases ─────────────────────────
  writeReleases(input: ReleaseRecord[]): BatchResult {
    return this.timed("total", () => this.writeReleasesBatch(input));
  }

  private writeReleasesBatch(input: ReleaseRecord[]): BatchResult {
    const res = empty();
    const records = dedupe(input, res);
    this.scope("release", records.map((r) => r.discogs_id));
    const now = this.now();
    const existing = this.lookup("releases", "discogs_release_id", records.map((r) => r.discogs_id), ", local_edited_at");
    const prov = this.provenance("release", [...existing.values()].map((e) => e.id));
    const allCredits = (r: ReleaseRecord) => [...r.artists, ...r.extra_artists, ...flatTracks(r.tracks).flatMap((t) => [...t.artists, ...t.extra_artists])];
    const artists = this.lookup("artists", "discogs_artist_id", records.flatMap((r) => allCredits(r).map((a) => a.discogs_artist_id)));
    const labels = this.lookup("labels", "discogs_label_id", records.flatMap((r) => [...r.labels, ...r.series].map((l) => l.discogs_id)));
    const masters = this.lookup("masters", "discogs_master_id", records.map((r) => r.master_discogs_id));
    const companies = this.lookup("companies", "discogs_company_id", records.flatMap((r) => r.companies.map((c) => c.discogs_id)));
    const docs: SearchDocument[] | null = this.search ? [] : null;
    const artistRef = (a: Credit) => {
      const id = a.discogs_artist_id != null ? artists.get(a.discogs_artist_id)?.id ?? null : null;
      if (a.discogs_artist_id != null && id == null) res.unresolved++;
      return id;
    };

    for (const r of records) {
      const hash = this.hash(r);
      const ex = existing.get(r.discogs_id);
      const action = this.classify("release", ex, prov.get(ex?.id), hash, r.discogs_id, res, now);
      res.lastExternalId = String(r.discogs_id);
      if (action === "skip") continue;
      const primary = releasePrimary(r);
      const masterId = r.master_discogs_id != null ? masters.get(r.master_discogs_id)?.id ?? null : null;
      if (r.master_discogs_id != null && masterId == null) res.unresolved++;
      const primaryLabelId = r.labels[0]?.discogs_id != null ? labels.get(r.labels[0].discogs_id!)?.id ?? null : null;
      const vals = [masterId, r.master_discogs_id, r.title, r.normalized_title, r.year, r.released, r.country, r.status, r.notes, r.data_quality,
        primaryLabelId, primary.catalog_number, primary.catalog_number_norm, primary.format, primary.format_details];
      let id: number;
      if (action === "insert") {
        id = Number(this.st(`INSERT INTO releases (master_id, discogs_master_id, title, normalized_title, year, released_date, country, status, notes, data_quality,
            label_id, catalog_number, catalog_number_norm, format, format_details, discogs_release_id, verification_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sourced', ?, ?)`).run(...vals, r.discogs_id, now, now).lastInsertRowid);
        this.externalId("release", id, r.discogs_id, now);
        res.created++;
      } else {
        id = ex.id;
        this.st(`UPDATE releases SET master_id = ?, discogs_master_id = ?, title = ?, normalized_title = ?, year = ?, released_date = ?, country = ?, status = ?,
            notes = ?, data_quality = ?, label_id = ?, catalog_number = ?, catalog_number_norm = ?, format = ?, format_details = ?, updated_at = ? WHERE id = ?`).run(...vals, now, id);
        for (const t of ["release_artists", "release_extra_artists", "release_labels", "release_series", "release_companies", "release_formats", "release_tracks", "release_identifiers", "release_genres", "release_styles"]) {
          this.st(`DELETE FROM ${t} WHERE release_id = ?`).run(id);
        }
        this.st("DELETE FROM release_media_links WHERE release_id = ? AND source_id = ?").run(id, this.sourceId);
        res.updated++;
      }
      r.artists.forEach((a, i) => this.st("INSERT INTO release_artists (release_id, artist_id, discogs_artist_id, name, anv, join_text, role, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, artistRef(a), a.discogs_artist_id, a.name, a.anv, joinText(a.join), a.role, i));
      r.extra_artists.forEach((a, i) => this.st("INSERT INTO release_extra_artists (release_id, artist_id, discogs_artist_id, name, anv, role, tracks, join_text, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, artistRef(a), a.discogs_artist_id, a.name, a.anv, a.role ?? "", a.tracks, joinText(a.join), i));
      r.labels.forEach((l, i) => {
        const lid = l.discogs_id != null ? labels.get(l.discogs_id)?.id ?? null : null;
        if (l.discogs_id != null && lid == null) res.unresolved++;
        this.st("INSERT INTO release_labels (release_id, label_id, discogs_label_id, name, catalog_number, catalog_number_norm, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, lid, l.discogs_id, l.name, l.catno, normalizeCode(l.catno), i);
      });
      r.series.forEach((x, i) => {
        const lid = x.discogs_id != null ? labels.get(x.discogs_id)?.id ?? null : null;
        if (x.discogs_id != null && lid == null) res.unresolved++;
        this.st("INSERT INTO release_series (release_id, label_id, discogs_label_id, name, catalog_number, catalog_number_norm, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, lid, x.discogs_id, x.name, x.catno, normalizeCode(x.catno), i);
      });
      r.companies.forEach((c, i) => {
        let cid: number | null = null;
        if (c.discogs_id != null) {
          cid = companies.get(c.discogs_id)?.id ?? null;
          if (cid == null) {
            cid = Number(this.st("INSERT INTO companies (discogs_company_id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(c.discogs_id, c.name, normalizeName(c.name), now, now).lastInsertRowid);
            companies.set(c.discogs_id, { id: cid });
          }
        } else {
          const found = this.st("SELECT id FROM companies WHERE discogs_company_id IS NULL AND name = ? LIMIT 1").get(c.name) as { id: number } | undefined;
          cid = found?.id ?? Number(this.st("INSERT INTO companies (name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(c.name, normalizeName(c.name), now, now).lastInsertRowid);
        }
        this.st("INSERT INTO release_companies (release_id, company_id, role, entity_type, catalog_number, position) VALUES (?, ?, ?, ?, ?, ?)").run(id, cid, c.role, c.entity_type, c.catno, i);
      });
      r.formats.forEach((f, i) => {
        const fid = Number(this.st("INSERT INTO release_formats (release_id, name, quantity, text, position) VALUES (?, ?, ?, ?, ?)").run(id, f.name, f.qty, f.text, i).lastInsertRowid);
        f.descriptions.forEach((d, j) => this.st("INSERT INTO release_format_descriptions (format_id, description, position) VALUES (?, ?, ?)").run(fid, d, j));
      });
      let seq = 0;
      const writeTrack = (t: TrackRecord, parent: number | null) => {
        const tid = Number(this.st(`INSERT INTO release_tracks (release_id, parent_track_id, track_type, position, title, duration, duration_seconds, artist_credit, sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, parent, t.track_type, t.position, t.title || "(untitled)", t.duration, t.duration_seconds, t.artists.length ? creditLine(t.artists) : null, seq++).lastInsertRowid);
        t.artists.forEach((a, i) => this.st("INSERT INTO release_track_artists (track_id, artist_id, discogs_artist_id, name, anv, join_text, position) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(tid, artistRef(a), a.discogs_artist_id, a.name, a.anv, joinText(a.join), i));
        t.extra_artists.forEach((a, i) => this.st("INSERT INTO release_extra_artists (release_id, track_id, artist_id, discogs_artist_id, name, anv, role, tracks, join_text, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, tid, artistRef(a), a.discogs_artist_id, a.name, a.anv, a.role ?? "", a.tracks, joinText(a.join), i));
        for (const s of t.sub_tracks) writeTrack(s, tid);
      };
      for (const t of r.tracks) writeTrack(t, null);
      for (const i of r.identifiers) this.st("INSERT INTO release_identifiers (release_id, identifier_type, value, description, normalized_value) VALUES (?, ?, ?, ?, ?)").run(id, i.type, i.value, i.description, normalizeCode(i.value));
      for (const g of r.genres) this.st("INSERT INTO release_genres (release_id, genre) VALUES (?, ?)").run(id, g);
      for (const s of r.styles) this.st("INSERT INTO release_styles (release_id, style) VALUES (?, ?)").run(id, s);
      for (const v of r.videos) {
        this.st("INSERT INTO release_media_links (release_id, provider, external_id, title, source_id, created_at) VALUES (?, 'youtube', ?, ?, ?, ?)").run(id, v.youtube_id, v.title, this.sourceId, now);
      }
      this.touch("release", id, hash, now);
      if (!docs) continue;
      const codes = new Set<string>();
      for (const l of [...r.labels, ...r.series]) if (l.catno) { codes.add(l.catno); const n = normalizeCode(l.catno); if (n) codes.add(n); }
      for (const i of r.identifiers) if (["Barcode", "Matrix / Runout", "Label Code"].includes(i.type)) { codes.add(i.value); const n = normalizeCode(i.value); if (n) codes.add(n); }
      docs.push({ type: "release", id, title: r.title, people: creditLine(r.artists), codes: [...codes].join(" "), extra: [r.labels.map((l) => l.name).join(" "), r.series.map((x) => x.name).join(" "), r.year, r.country, primary.format].filter(Boolean).join(" ") });
    }
    this.index(docs);
    return res;
  }
}

function flatTracks(ts: TrackRecord[]): TrackRecord[] {
  return ts.flatMap((t) => [t, ...flatTracks(t.sub_tracks)]);
}

function creditLine(cs: Credit[]): string {
  return cs.map((c) => (c.anv || c.name) + joinText(c.join)).join("").replace(/\s+/g, " ").trim();
}

export type ScopeEntity = "artist" | "label" | "master" | "release";

/** Per-connection list of Discogs ids written by the current run, used to scope reconciliation. */
export function resetReconcileScope(db: DB) {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS reconcile_scope (entity TEXT NOT NULL, ext INTEGER NOT NULL, PRIMARY KEY (entity, ext)) WITHOUT ROWID");
  db.exec("DELETE FROM temp.reconcile_scope");
}

/**
 * Links rows whose referenced entity has since been imported (e.g. releases imported before their
 * master, credits for artists imported later). Safe to run repeatedly. Returns rows resolved.
 *
 * - Full (no scope): every unresolved row in the catalog, after repairing any stale id/FK pairs.
 *   Cost grows with the number of unresolved rows (165 s at 1M real releases), so it's for
 *   `catalog reconcile`, resumed runs and tests.
 * - Scoped (`{ scope: "artist" }` etc.): only rows pointing at the ids this run wrote (recorded in
 *   temp.reconcile_scope by the writer). References to entities imported by *earlier* runs were
 *   already resolved when the rows were written, so this is complete for a normal run.
 */
export function reconcileReferences(db: DB, opts: { scope?: ScopeEntity } = {}): Record<string, number> {
  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a).changes;
  const scope = opts.scope;
  const inScope = (col: string, entity: ScopeEntity) => (scope ? ` AND ${col} IN (SELECT ext FROM temp.reconcile_scope WHERE entity = '${entity}')` : "");
  // In scoped mode, pin each UPDATE to its unresolved-reference index. Otherwise SQLite's planner
  // tends to pick the FK index (fk IS NULL), which walks every unresolved row: the catalog-wide
  // scan this mode exists to avoid. (SQLite-specific; see docs/POSTGRES_READINESS.md.)
  const UNRESOLVED_INDEX: Record<string, string> = {
    release_artists: "release_artists_unresolved", release_extra_artists: "release_extra_artists_unresolved",
    release_track_artists: "release_track_artists_unresolved", master_artists: "master_artists_unresolved",
    artist_aliases: "artist_aliases_unresolved", artist_members: "artist_members_unresolved", release_labels: "release_labels_unresolved",
    release_series: "release_series_unresolved", labels: "labels_unresolved_parent", releases: "releases_unresolved_master", masters: "masters_unresolved_main_release",
  };
  const tbl = (t: string) => (scope ? `${t} INDEXED BY ${UNRESOLVED_INDEX[t]}` : t);
  const want = (entity: ScopeEntity) => !scope || scope === entity;
  return db.transaction(() => {
    const out: Record<string, number> = {};
    // Repair first (full mode only): an internal link that no longer matches its Discogs id is
    // cleared, so the resolve steps below can link it to the right entity (or leave it NULL until
    // it's imported). Only Discogs-sourced rows without local edits are touched. Heals rows written
    // before the writer stopped using COALESCE(?, fk) on these pairs.
    if (!scope) Object.assign(out, repairStaleReferences(db));
    if (want("master")) {
      out.release_master = run(`UPDATE ${tbl("releases")} SET master_id = (SELECT m.id FROM masters m WHERE m.discogs_master_id = releases.discogs_master_id)
        WHERE master_id IS NULL AND discogs_master_id IS NOT NULL${inScope("discogs_master_id", "master")} AND EXISTS (SELECT 1 FROM masters m WHERE m.discogs_master_id = releases.discogs_master_id)`);
    }
    if (want("release")) {
      out.master_main_release = run(`UPDATE ${tbl("masters")} SET main_release_id = (SELECT r.id FROM releases r WHERE r.discogs_release_id = masters.main_release_discogs_id)
        WHERE main_release_id IS NULL AND main_release_discogs_id IS NOT NULL${inScope("main_release_discogs_id", "release")} AND EXISTS (SELECT 1 FROM releases r WHERE r.discogs_release_id = masters.main_release_discogs_id)`);
    }
    if (want("artist")) {
      for (const t of ["release_artists", "release_extra_artists", "release_track_artists", "master_artists"]) {
        out[t] = run(`UPDATE ${tbl(t)} SET artist_id = (SELECT a.id FROM artists a WHERE a.discogs_artist_id = ${t}.discogs_artist_id)
          WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL${inScope("discogs_artist_id", "artist")} AND EXISTS (SELECT 1 FROM artists a WHERE a.discogs_artist_id = ${t}.discogs_artist_id)`);
      }
      out.artist_aliases = run(`UPDATE ${tbl("artist_aliases")} SET alias_artist_id = (SELECT a.id FROM artists a WHERE a.discogs_artist_id = artist_aliases.discogs_alias_id)
        WHERE alias_artist_id IS NULL AND discogs_alias_id IS NOT NULL${inScope("discogs_alias_id", "artist")} AND EXISTS (SELECT 1 FROM artists a WHERE a.discogs_artist_id = artist_aliases.discogs_alias_id)`);
      out.artist_members = run(`UPDATE ${tbl("artist_members")} SET member_artist_id = (SELECT a.id FROM artists a WHERE a.discogs_artist_id = artist_members.discogs_member_id)
        WHERE member_artist_id IS NULL AND discogs_member_id IS NOT NULL${inScope("discogs_member_id", "artist")} AND EXISTS (SELECT 1 FROM artists a WHERE a.discogs_artist_id = artist_members.discogs_member_id)`);
    }
    if (want("label")) {
      // Primary label first, while the position-0 release_labels row is still in the unresolved index.
      out.release_primary_label = run(scope
        ? `UPDATE releases SET label_id = (SELECT l.id FROM release_labels rl JOIN labels l ON l.discogs_label_id = rl.discogs_label_id WHERE rl.release_id = releases.id AND rl.position = 0)
            WHERE label_id IS NULL AND id IN (SELECT release_id FROM release_labels INDEXED BY release_labels_unresolved WHERE label_id IS NULL AND position = 0${inScope("discogs_label_id", "label")})
            AND EXISTS (SELECT 1 FROM release_labels rl JOIN labels l ON l.discogs_label_id = rl.discogs_label_id WHERE rl.release_id = releases.id AND rl.position = 0)`
        : `UPDATE releases SET label_id = (SELECT l.id FROM release_labels rl JOIN labels l ON l.discogs_label_id = rl.discogs_label_id WHERE rl.release_id = releases.id AND rl.position = 0)
            WHERE label_id IS NULL AND discogs_release_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM release_labels rl JOIN labels l ON l.discogs_label_id = rl.discogs_label_id WHERE rl.release_id = releases.id AND rl.position = 0)`);
      for (const [t, fk] of [["release_labels", "label_id"], ["release_series", "label_id"]]) {
        out[t] = run(`UPDATE ${tbl(t)} SET ${fk} = (SELECT l.id FROM labels l WHERE l.discogs_label_id = ${t}.discogs_label_id)
          WHERE ${fk} IS NULL AND discogs_label_id IS NOT NULL${inScope("discogs_label_id", "label")} AND EXISTS (SELECT 1 FROM labels l WHERE l.discogs_label_id = ${t}.discogs_label_id)`);
      }
      out.label_parent = run(`UPDATE ${tbl("labels")} SET parent_label_id = (SELECT p.id FROM labels p WHERE p.discogs_label_id = labels.parent_discogs_label_id)
        WHERE parent_label_id IS NULL AND parent_discogs_label_id IS NOT NULL${inScope("parent_discogs_label_id", "label")} AND EXISTS (SELECT 1 FROM labels p WHERE p.discogs_label_id = labels.parent_discogs_label_id)`);
    }
    return out;
  })();
}

/**
 * Every paired (Discogs id, internal FK) column must agree: the FK is either NULL or the internal id
 * of the entity carrying that Discogs id. These are the only pairs stored on parent rows; child
 * tables (credits, labels, aliases, members) are deleted and rewritten on every update.
 */
const STALE_PAIRS = {
  stale_release_master: {
    where: `releases.discogs_release_id IS NOT NULL AND releases.local_edited_at IS NULL AND releases.master_id IS NOT NULL
      AND (releases.discogs_master_id IS NULL OR NOT EXISTS (SELECT 1 FROM masters m WHERE m.id = releases.master_id AND m.discogs_master_id = releases.discogs_master_id))`,
    table: "releases", fk: "master_id",
  },
  stale_master_main_release: {
    where: `masters.discogs_master_id IS NOT NULL AND masters.local_edited_at IS NULL AND masters.main_release_id IS NOT NULL
      AND (masters.main_release_discogs_id IS NULL OR NOT EXISTS (SELECT 1 FROM releases r WHERE r.id = masters.main_release_id AND r.discogs_release_id = masters.main_release_discogs_id))`,
    table: "masters", fk: "main_release_id",
  },
  stale_label_parent: {
    where: `labels.discogs_label_id IS NOT NULL AND labels.local_edited_at IS NULL AND labels.parent_label_id IS NOT NULL
      AND (labels.parent_discogs_label_id IS NULL OR NOT EXISTS (SELECT 1 FROM labels p WHERE p.id = labels.parent_label_id AND p.discogs_label_id = labels.parent_discogs_label_id))`,
    table: "labels", fk: "parent_label_id",
  },
} as const;

function repairStaleReferences(db: DB): Record<string, number> {
  return Object.fromEntries(Object.entries(STALE_PAIRS).map(([k, p]) => [k, db.prepare(`UPDATE ${p.table} SET ${p.fk} = NULL WHERE ${p.where}`).run().changes]));
}

/** Rows whose internal FK disagrees with their Discogs id (should always be 0). */
export function staleReferenceCounts(db: DB): Record<string, number> {
  return Object.fromEntries(Object.entries(STALE_PAIRS).map(([k, p]) => [k, (db.prepare(`SELECT COUNT(*) AS n FROM ${p.table} WHERE ${p.where}`).get() as { n: number }).n]));
}

/** Counts rows that still point at entities not present in the catalog (by Discogs id). */
export function unresolvedCounts(db: DB): Record<string, number> {
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    releases_without_master: q("SELECT COUNT(*) AS n FROM releases WHERE master_id IS NULL AND discogs_master_id IS NOT NULL"),
    release_artist_credits: q("SELECT COUNT(*) AS n FROM release_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL"),
    extra_artist_credits: q("SELECT COUNT(*) AS n FROM release_extra_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL"),
    release_labels: q("SELECT COUNT(*) AS n FROM release_labels WHERE label_id IS NULL AND discogs_label_id IS NOT NULL"),
    release_series: q("SELECT COUNT(*) AS n FROM release_series WHERE label_id IS NULL AND discogs_label_id IS NOT NULL"),
    master_artist_credits: q("SELECT COUNT(*) AS n FROM master_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL"),
    track_artist_credits: q("SELECT COUNT(*) AS n FROM release_track_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL"),
    artist_aliases: q("SELECT COUNT(*) AS n FROM artist_aliases WHERE alias_artist_id IS NULL AND discogs_alias_id IS NOT NULL"),
    artist_members: q("SELECT COUNT(*) AS n FROM artist_members WHERE member_artist_id IS NULL AND discogs_member_id IS NOT NULL"),
    label_parents: q("SELECT COUNT(*) AS n FROM labels WHERE parent_label_id IS NULL AND parent_discogs_label_id IS NOT NULL"),
    masters_main_release: q("SELECT COUNT(*) AS n FROM masters WHERE main_release_id IS NULL AND main_release_discogs_id IS NOT NULL"),
  };
}
