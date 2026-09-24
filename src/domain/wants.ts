/**
 * Wants: a desire for music in any acceptable format, a specific release (pressing), or a specific
 * collectible configuration. Wants are never holdings; the wantlist is private.
 */
import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { notFound } from "../lib/errors.js";
import { optionalInt, optionalText, parse, requiredText } from "../lib/validation.js";
import { creditForRelease, masterCredits } from "./catalog.js";
import { FORMAT_GROUPS } from "./library.js";

export const WANT_KIND_LABELS: Record<string, string> = {
  any_format: "Any format",
  edition: "Specific release (pressing)",
  configuration: "Specific configuration",
};

/**
 * Adds a want linked to the catalog: a whole master (any version) or one specific release.
 * `masterId` may be null for a release that has no master.
 */
export function addWant(db: DB, clock: Clock, userId: number, masterId: number | null, releaseId: number | null) {
  if (releaseId != null) {
    const e = db.prepare("SELECT master_id FROM releases WHERE id = ?").get(releaseId) as { master_id: number | null } | undefined;
    if (!e || (masterId != null && e.master_id !== masterId)) throw notFound("Release");
    masterId = e.master_id;
  } else if (masterId == null || !db.prepare("SELECT 1 FROM masters WHERE id = ?").get(masterId)) throw notFound("Master");
  const now = iso(clock.now());
  const exists = db.prepare("SELECT id FROM wants WHERE user_id = ? AND IFNULL(master_id, 0) = ? AND IFNULL(release_id, 0) = ? AND want_kind != 'configuration' AND source_entry_id IS NULL")
    .get(userId, masterId ?? 0, releaseId ?? 0);
  if (exists) return;
  // Master-less release wants store descriptive text so the want stays meaningful on its own.
  const r = releaseId != null && masterId == null ? (db.prepare("SELECT title FROM releases WHERE id = ?").get(releaseId) as { title: string }) : null;
  db.prepare("INSERT INTO wants (user_id, want_kind, master_id, release_id, artist_text, title_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    userId, releaseId == null ? "any_format" : "edition", masterId, releaseId, r ? creditForRelease(db, { id: releaseId!, master_id: null }) : null, r?.title ?? null, now, now);
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

export function hasWant(db: DB, userId: number, masterId: number | null, releaseId: number | null): number | null {
  const r = db
    .prepare("SELECT id FROM wants WHERE user_id = ? AND IFNULL(master_id, 0) = ? AND IFNULL(release_id, 0) = ? AND want_kind != 'configuration'")
    .get(userId, masterId ?? 0, releaseId ?? 0) as { id: number } | undefined;
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
      `SELECT w.*, COALESCE(w.title_text, e.title, r.title) AS title, COALESCE(w.catno_text, e.catalog_number) AS catno, COALESCE(w.label_text, lb.name) AS label,
         COALESCE(w.format_raw, e.format) AS format, COALESCE(w.release_year, e.year) AS year,
         (SELECT json_extract(se.data, '$.release_id') FROM source_entries se WHERE se.id = w.source_entry_id) AS discogs_release_id,
         CASE WHEN w.master_id IS NULL AND w.release_id IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM listings li JOIN releases e2 ON e2.id = li.release_id
            WHERE li.status = 'available' AND li.seller_id != w.user_id
              AND (CASE WHEN w.release_id IS NULL THEN e2.master_id = w.master_id ELSE e2.id = w.release_id END)) END AS for_sale,
         CASE WHEN w.master_id IS NULL AND w.release_id IS NULL THEN NULL ELSE (SELECT MIN(li.price_cents) FROM listings li JOIN releases e2 ON e2.id = li.release_id
            WHERE li.status = 'available' AND li.seller_id != w.user_id
              AND (CASE WHEN w.release_id IS NULL THEN e2.master_id = w.master_id ELSE e2.id = w.release_id END)) END AS min_price
       FROM wants w LEFT JOIN masters r ON r.id = w.master_id LEFT JOIN releases e ON e.id = w.release_id LEFT JOIN labels lb ON lb.id = e.label_id
       WHERE w.user_id = ?${extra} ORDER BY w.id DESC`,
    )
    .all(...args) as any[];
  const credits = masterCredits(db, rows.filter((r) => r.master_id).map((r) => r.master_id));
  for (const r of rows) r.artist = r.artist_text ?? (r.master_id ? credits.get(r.master_id) : r.release_id ? creditForRelease(db, { id: r.release_id, master_id: null }) : null) ?? "Unknown artist";
  return rows;
}
