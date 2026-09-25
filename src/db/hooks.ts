/**
 * Data steps that SQL alone can't do well (Unicode normalisation, splitting text, building the
 * search index), run inside the same transaction as their migration. `guards` run before a
 * down migration and refuse it when reversing would lose data.
 */
import type { DB } from "./index.js";
import { normalizeCode, normalizeName } from "../services/catalog-api/normalize.js";
import { reindexAll } from "../services/search/index.js";

export const afterUp: Record<string, (db: DB) => void> = {
  "003_catalog_foundation.sql": (db) => {
    for (const [table, src, dst] of [["artists", "name", "normalized_name"], ["labels", "name", "normalized_name"], ["masters", "title", "normalized_title"], ["releases", "title", "normalized_title"]]) {
      const upd = db.prepare(`UPDATE ${table} SET ${dst} = ? WHERE id = ?`);
      for (const r of db.prepare(`SELECT id, ${src} AS v FROM ${table}`).all() as any[]) upd.run(normalizeName(r.v), r.id);
    }
    const updCat = db.prepare("UPDATE release_labels SET catalog_number_norm = ? WHERE id = ?");
    for (const r of db.prepare("SELECT id, catalog_number FROM release_labels").all() as any[]) updCat.run(normalizeCode(r.catalog_number), r.id);
    // Split the old free-text format details ("12\", 33 ⅓ RPM, Repress") into format descriptions.
    const ins = db.prepare("INSERT INTO release_format_descriptions (format_id, description, position) VALUES (?, ?, ?)");
    for (const f of db.prepare("SELECT rf.id, r.format_details FROM release_formats rf JOIN releases r ON r.id = rf.release_id WHERE r.format_details IS NOT NULL").all() as any[]) {
      String(f.format_details).split(",").map((s) => s.trim()).filter(Boolean).forEach((d, i) => ins.run(f.id, d, i));
    }
    reindexAll(db);
  },
};

export const guards: Record<string, (db: DB) => string | null> = {
  "003_catalog_foundation.sql": (db) => {
    const imported = (db.prepare("SELECT COUNT(*) AS n FROM releases WHERE discogs_release_id IS NOT NULL OR master_id IS NULL").get() as { n: number }).n
      + (db.prepare("SELECT COUNT(*) AS n FROM artists WHERE discogs_artist_id IS NOT NULL").get() as { n: number }).n;
    if (imported) return `The catalog contains ${imported} imported or master-less records that the pre-003 schema cannot represent.`;
    const dupLabels = (db.prepare("SELECT COUNT(*) AS n FROM (SELECT name FROM labels GROUP BY name HAVING COUNT(*) > 1)").get() as { n: number }).n;
    if (dupLabels) return `${dupLabels} label names are duplicated; the pre-003 schema requires unique label names.`;
    return null;
  },
  "005_release_series.sql": (db) => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM release_series").get() as { n: number }).n;
    return n ? `${n} release series rows would be lost (re-importing the releases dump after reverting would not restore them).` : null;
  },
};
