/**
 * Bulk-load index management. During a first large import, SQLite spends most of its time keeping
 * secondary indexes on scattered values up to date: every batch touches thousands of distinct
 * index pages, all of which must be written at commit. Dropping those indexes for the load and
 * rebuilding each one once (a sort) at the end avoids that.
 *
 * Only indexes nothing reads during an import are deferred. Kept: unique Discogs-id indexes
 * (lookups, duplicate protection), primary keys, owner indexes in release/track order (used when a
 * changed record's child rows are replaced and by FK cascades), and the id-less company lookup.
 *
 * Crash safety: each definition is saved in `deferred_indexes` in the same transaction that drops
 * it. `restoreDeferredIndexes` recreates everything listed there; a normal (non-bulk) import calls
 * it before writing anything.
 */
import type { DB } from "../../../db/index.js";

export const DEFERRABLE_INDEXES = [
  "artists_normalized_name", "artist_aliases_unresolved", "artist_members_member", "artist_members_unresolved",
  "labels_normalized_name", "labels_name", "labels_unresolved_parent", "companies_normalized_name",
  "masters_normalized_title", "masters_unresolved_main_release", "master_artists_artist", "master_artists_unresolved", "master_genres_genre", "master_styles_style",
  "releases_master", "releases_unresolved_master", "releases_catno", "releases_normalized_title", "releases_year", "releases_country",
  "release_artists_artist", "release_artists_unresolved", "release_extra_artists_artist", "release_extra_artists_unresolved",
  "release_track_artists_artist", "release_track_artists_unresolved", "release_labels_label", "release_labels_catno", "release_labels_unresolved",
  "release_series_label", "release_series_unresolved", "release_companies_company", "release_formats_name", "release_genres_genre",
  "release_styles_style", "release_identifiers_value",
] as const;

export function deferredIndexes(db: DB): { name: string; table_name: string; run_id: number | null; dropped_at: string }[] {
  return db.prepare("SELECT name, table_name, run_id, dropped_at FROM deferred_indexes ORDER BY name").all() as any[];
}

/** Drops the deferrable indexes that exist, recording each definition first. Returns names dropped. */
export function dropDeferrableIndexes(db: DB, runId: number | null, now = new Date().toISOString()): string[] {
  const dropped: string[] = [];
  db.transaction(() => {
    for (const name of DEFERRABLE_INDEXES) {
      const row = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { tbl_name: string; sql: string } | undefined;
      if (!row) continue;
      db.prepare("INSERT OR REPLACE INTO deferred_indexes (name, table_name, sql, run_id, dropped_at) VALUES (?, ?, ?, ?, ?)").run(name, row.tbl_name, row.sql, runId, now);
      db.exec(`DROP INDEX ${name}`);
      dropped.push(name);
    }
  })();
  return dropped;
}

/** Recreates every recorded index (each built once from the full table). Returns names and time. */
export function restoreDeferredIndexes(db: DB): { restored: string[]; ms: number } {
  const t = performance.now();
  const rows = db.prepare("SELECT name, sql FROM deferred_indexes ORDER BY name").all() as { name: string; sql: string }[];
  for (const r of rows) {
    // One index per transaction: a crash mid-restore loses at most the index being built.
    db.transaction(() => {
      db.exec(r.sql.replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?/i, (_m, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `));
      db.prepare("DELETE FROM deferred_indexes WHERE name = ?").run(r.name);
    })();
  }
  return { restored: rows.map((r) => r.name), ms: performance.now() - t };
}
