/**
 * Wants: a desire for music in any acceptable format, a specific edition, or a specific
 * collectible configuration. Wants are never holdings; the wantlist is private.
 */
import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { notFound } from "../lib/errors.js";
import { optionalInt, optionalText, parse, requiredText } from "../lib/validation.js";
import { artistCredits } from "./catalog.js";
import { FORMAT_GROUPS } from "./library.js";

export const WANT_KIND_LABELS: Record<string, string> = {
  any_format: "Any format",
  edition: "Specific edition",
  configuration: "Specific configuration",
};

/** Adds a want linked to the archive (from a release or edition page). */
export function addWant(db: DB, clock: Clock, userId: number, releaseId: number, editionId: number | null) {
  if (editionId != null) {
    const e = db.prepare("SELECT release_id FROM editions WHERE id = ?").get(editionId) as { release_id: number } | undefined;
    if (!e || e.release_id !== releaseId) throw notFound("Edition");
  } else if (!db.prepare("SELECT 1 FROM releases WHERE id = ?").get(releaseId)) throw notFound("Release");
  const now = iso(clock.now());
  db.prepare("INSERT OR IGNORE INTO wants (user_id, want_kind, release_id, edition_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    userId, editionId == null ? "any_format" : "edition", releaseId, editionId, now, now);
}

export const manualWantSchema = z
  .object({
    want_kind: z.enum(["any_format", "edition", "configuration"], { error: "Choose what kind of want this is." }),
    artist_text: requiredText("Artist", 300),
    title_text: requiredText("Title", 300),
    label_text: optionalText(200),
    catno_text: optionalText(80),
    format_group: z.string().optional().transform((v) => v || null).refine((v) => v == null || (FORMAT_GROUPS as readonly string[]).includes(v), "Choose a format."),
    format_raw: optionalText(200),
    release_year: optionalInt("Year", 1900, 2100),
    configuration_note: optionalText(500),
    note: optionalText(2000),
  })
  .refine((w) => w.want_kind !== "configuration" || !!w.configuration_note, { message: "Describe the configuration you want (e.g. first press, black vinyl, with poster).", path: ["configuration_note"] });

export function addManualWant(db: DB, clock: Clock, userId: number, raw: unknown): number {
  const w = parse(manualWantSchema, raw);
  const now = iso(clock.now());
  return Number(
    db.prepare(
      `INSERT INTO wants (user_id, want_kind, artist_text, title_text, label_text, catno_text, format_group, format_raw, release_year, configuration_note, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, w.want_kind, w.artist_text, w.title_text, w.label_text, w.catno_text, w.format_group, w.format_raw, w.release_year, w.configuration_note, w.note, now, now).lastInsertRowid,
  );
}

export function updateWantNote(db: DB, clock: Clock, userId: number, wantId: number, note: unknown) {
  const n = parse(optionalText(2000), typeof note === "string" ? note : undefined);
  const now = iso(clock.now());
  const r = db.prepare("UPDATE wants SET note = ?, updated_at = ?, user_edited_at = ? WHERE id = ? AND user_id = ?").run(n, now, now, wantId, userId);
  if (r.changes !== 1) throw notFound("Want");
}

export function removeWant(db: DB, userId: number, wantId: number) {
  db.prepare("DELETE FROM wants WHERE id = ? AND user_id = ?").run(wantId, userId);
}

export function hasWant(db: DB, userId: number, releaseId: number, editionId: number | null): number | null {
  const r = db
    .prepare("SELECT id FROM wants WHERE user_id = ? AND release_id = ? AND IFNULL(edition_id, 0) = ? AND want_kind != 'configuration'")
    .get(userId, releaseId, editionId ?? 0) as { id: number } | undefined;
  return r?.id ?? null;
}

export function listWants(db: DB, userId: number, opts: { q?: string } = {}) {
  const args: unknown[] = [userId];
  let extra = "";
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim()}%`;
    extra = " AND (COALESCE(w.title_text, r.title) LIKE ? OR COALESCE(w.artist_text, '') LIKE ? OR COALESCE(w.catno_text, e.catalog_number, '') LIKE ?)";
    args.push(like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT w.*, COALESCE(w.title_text, r.title) AS title, COALESCE(w.catno_text, e.catalog_number) AS catno, COALESCE(w.label_text, lb.name) AS label,
         COALESCE(w.format_raw, e.format) AS format, COALESCE(w.release_year, e.release_year) AS year,
         (SELECT json_extract(se.data, '$.release_id') FROM source_entries se WHERE se.id = w.source_entry_id) AS discogs_release_id,
         CASE WHEN w.release_id IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM listings li JOIN editions e2 ON e2.id = li.edition_id
            WHERE li.status = 'available' AND li.seller_id != w.user_id
              AND (CASE WHEN w.edition_id IS NULL THEN e2.release_id = w.release_id ELSE e2.id = w.edition_id END)) END AS for_sale,
         CASE WHEN w.release_id IS NULL THEN NULL ELSE (SELECT MIN(li.price_cents) FROM listings li JOIN editions e2 ON e2.id = li.edition_id
            WHERE li.status = 'available' AND li.seller_id != w.user_id
              AND (CASE WHEN w.edition_id IS NULL THEN e2.release_id = w.release_id ELSE e2.id = w.edition_id END)) END AS min_price
       FROM wants w LEFT JOIN releases r ON r.id = w.release_id LEFT JOIN editions e ON e.id = w.edition_id LEFT JOIN labels lb ON lb.id = e.label_id
       WHERE w.user_id = ?${extra} ORDER BY w.id DESC`,
    )
    .all(...args) as any[];
  const credits = artistCredits(db, [...new Set(rows.filter((r) => r.release_id).map((r) => r.release_id))]);
  for (const r of rows) r.artist = r.artist_text ?? credits.get(r.release_id) ?? "Unknown artist";
  return rows;
}
