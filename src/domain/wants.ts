import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { notFound } from "../lib/errors.js";
import { artistCredits } from "./catalog.js";

/** A want targets a whole release (any edition) or one specific edition. */
export function addWant(db: DB, clock: Clock, userId: number, releaseId: number, editionId: number | null) {
  if (editionId != null) {
    const e = db.prepare("SELECT release_id FROM editions WHERE id = ?").get(editionId) as { release_id: number } | undefined;
    if (!e || e.release_id !== releaseId) throw notFound("Edition");
  } else if (!db.prepare("SELECT 1 FROM releases WHERE id = ?").get(releaseId)) throw notFound("Release");
  db.prepare("INSERT OR IGNORE INTO wants (user_id, release_id, edition_id, created_at) VALUES (?, ?, ?, ?)").run(userId, releaseId, editionId, iso(clock.now()));
}

export function removeWant(db: DB, userId: number, wantId: number) {
  db.prepare("DELETE FROM wants WHERE id = ? AND user_id = ?").run(wantId, userId);
}

export function hasWant(db: DB, userId: number, releaseId: number, editionId: number | null): number | null {
  const r = db
    .prepare("SELECT id FROM wants WHERE user_id = ? AND release_id = ? AND IFNULL(edition_id, 0) = ?")
    .get(userId, releaseId, editionId ?? 0) as { id: number } | undefined;
  return r?.id ?? null;
}

export function listWants(db: DB, userId: number) {
  const rows = db
    .prepare(
      `SELECT w.*, r.title, e.catalog_number, e.format, e.country, e.release_year,
         (SELECT COUNT(*) FROM listings li JOIN editions e2 ON e2.id = li.edition_id
            WHERE li.status = 'available' AND li.seller_id != w.user_id
              AND (CASE WHEN w.edition_id IS NULL THEN e2.release_id = w.release_id ELSE e2.id = w.edition_id END)) AS for_sale,
         (SELECT MIN(li.price_cents) FROM listings li JOIN editions e2 ON e2.id = li.edition_id
            WHERE li.status = 'available' AND li.seller_id != w.user_id
              AND (CASE WHEN w.edition_id IS NULL THEN e2.release_id = w.release_id ELSE e2.id = w.edition_id END)) AS min_price
       FROM wants w JOIN releases r ON r.id = w.release_id LEFT JOIN editions e ON e.id = w.edition_id
       WHERE w.user_id = ? ORDER BY w.id DESC`,
    )
    .all(userId) as any[];
  const credits = artistCredits(db, [...new Set(rows.map((r) => r.release_id))]);
  for (const r of rows) r.artist = credits.get(r.release_id);
  return rows;
}
