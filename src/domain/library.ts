/**
 * The private library: physical copies (`copies`) and digital holdings (`digital_holdings`),
 * browsed together through the `library_items` view. Everything here is owner-scoped: every
 * function takes the owner's id and never returns another user's rows.
 */
import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, notFound } from "../lib/errors.js";
import { DEMO_CURRENCY } from "../lib/money.js";
import { MEDIA_CODES, SLEEVE_CODES } from "../lib/reference.js";
import { asArray, isoDateOptional, moneyField, optionalInt, optionalText, parse, requiredText, trimmed } from "../lib/validation.js";

export const SUGGESTED_TAGS = [
  "warm-up", "peak-time", "closing", "sunday-brunch", "vocal", "instrumental", "percussion-heavy", "inherited-collection", "duplicates",
];
export const FORMAT_GROUPS = ["Vinyl", "CD", "Cassette", "Digital", "Other"] as const;

// ───────────────────────── Item references ─────────────────────────
export type ItemType = "physical" | "digital";
export interface ItemRef { type: ItemType; id: number }

export const refKey = (r: ItemRef) => `${r.type === "physical" ? "p" : "d"}:${r.id}`;
export function parseRef(s: unknown): ItemRef | null {
  const m = /^([pd]):(\d{1,12})$/.exec(String(s ?? ""));
  return m ? { type: m[1] === "p" ? "physical" : "digital", id: Number(m[2]) } : null;
}
export const parseRefs = (v: unknown): ItemRef[] => asArray(v).map(parseRef).filter((r): r is ItemRef => !!r);

/** Keeps only refs the owner actually owns (foreign or unknown ids are dropped). */
export function ownedRefs(db: DB, ownerId: number, refs: ItemRef[]): ItemRef[] {
  const out: ItemRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    const table = r.type === "physical" ? "copies" : "digital_holdings";
    if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND owner_id = ?`).get(r.id, ownerId)) out.push(r);
  }
  return out;
}

// ───────────────────────── Physical copies ─────────────────────────
const conditionFields = {
  media_condition: z.string().refine((v) => MEDIA_CODES.includes(v), "Choose a media condition."),
  sleeve_condition: z.string().refine((v) => SLEEVE_CODES.includes(v), "Choose a sleeve condition."),
};
const privateFields = {
  private_notes: optionalText(4000),
  storage_location: optionalText(200),
  acquired_on: isoDateOptional,
  acquired_from: optionalText(200),
  acquisition_cost: moneyField("Acquisition cost", { required: false }),
  dj_energy: optionalInt("Energy", 1, 5),
  dj_bpm_notes: optionalText(200),
  tags: trimmed(500).optional().transform((v) => parseTagList(v ?? "")),
  crate_id: z.string().optional().transform((v) => (v ? Number(v) : null)),
};
const descriptiveFields = {
  artist_text: requiredText("Artist", 300),
  title_text: requiredText("Title", 300),
  label_text: optionalText(200),
  catno_text: optionalText(80),
  format_group: z.string().refine((v) => (FORMAT_GROUPS as readonly string[]).includes(v), "Choose a format."),
  format_raw: optionalText(200),
  release_year: optionalInt("Year", 1900, 2100),
  genre_text: optionalText(120),
};

export const copySchema = z.object({ ...conditionFields, ...privateFields });
export const manualCopySchema = z.object({ ...descriptiveFields, ...conditionFields, ...privateFields });

export function parseTagList(s: string): string[] {
  const out = new Set<string>();
  for (const part of s.split(",")) {
    const t = part.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
    if (t) out.add(t);
  }
  return [...out].slice(0, 30);
}

function assertCrateOwned(db: DB, ownerId: number, crateId: number | null) {
  if (crateId == null) return;
  if (!db.prepare("SELECT 1 FROM crates WHERE id = ? AND owner_id = ?").get(crateId, ownerId)) throw new DomainError("That crate does not exist.", 422);
}

function insertCopy(db: DB, clock: Clock, ownerId: number, editionId: number | null, input: any, extra: Record<string, unknown> = {}): number {
  const now = iso(clock.now());
  const cols: Record<string, unknown> = {
    owner_id: ownerId, edition_id: editionId,
    artist_text: input.artist_text ?? null, title_text: input.title_text ?? null, label_text: input.label_text ?? null,
    catno_text: input.catno_text ?? null, format_group: input.format_group ?? null, format_raw: input.format_raw ?? null,
    release_year: input.release_year ?? null, genre_text: input.genre_text ?? null,
    media_condition: input.media_condition, sleeve_condition: input.sleeve_condition,
    private_notes: input.private_notes ?? null, storage_location: input.storage_location ?? null, acquired_on: input.acquired_on ?? null,
    acquired_from: input.acquired_from ?? null, acquisition_cost_cents: input.acquisition_cost ?? null,
    acquisition_currency: input.acquisition_cost == null ? null : DEMO_CURRENCY, dj_energy: input.dj_energy ?? null, dj_bpm_notes: input.dj_bpm_notes ?? null,
    date_added: now, created_at: now, updated_at: now, ...extra,
  };
  const keys = Object.keys(cols);
  return Number(db.prepare(`INSERT INTO copies (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => cols[k])).lastInsertRowid);
}

/** Adds a copy of an archive edition. Private by default and not for sale. */
export function createCopy(db: DB, clock: Clock, ownerId: number, editionId: number, raw: unknown): number {
  const input = parse(copySchema, raw);
  if (!db.prepare("SELECT 1 FROM editions WHERE id = ?").get(editionId)) throw notFound("Edition");
  return db.transaction(() => {
    assertCrateOwned(db, ownerId, input.crate_id);
    const id = insertCopy(db, clock, ownerId, editionId, input);
    setTags(db, ownerId, { type: "physical", id }, input.tags);
    if (input.crate_id) addToCrate(db, clock, ownerId, input.crate_id, [{ type: "physical", id }]);
    return id;
  })();
}

/** Manual entry without an archive edition: descriptive fields stay private to the owner. */
export function createManualCopy(db: DB, clock: Clock, ownerId: number, raw: unknown): number {
  const input = parse(manualCopySchema, raw);
  return db.transaction(() => {
    assertCrateOwned(db, ownerId, input.crate_id);
    const id = insertCopy(db, clock, ownerId, null, input);
    setTags(db, ownerId, { type: "physical", id }, input.tags);
    if (input.crate_id) addToCrate(db, clock, ownerId, input.crate_id, [{ type: "physical", id }]);
    return id;
  })();
}

export function updateCopy(db: DB, clock: Clock, ownerId: number, copyId: number, raw: unknown) {
  db.transaction(() => {
    const existing = getOwnCopy(db, ownerId, copyId);
    const unresolved = existing.edition_id == null;
    const input: any = parse(unresolved ? manualCopySchema : copySchema, raw);
    const now = iso(clock.now());
    db.prepare(
      `UPDATE copies SET media_condition = ?, sleeve_condition = ?, private_notes = ?, storage_location = ?, acquired_on = ?, acquired_from = ?,
         acquisition_cost_cents = ?, acquisition_currency = ?, dj_energy = ?, dj_bpm_notes = ?, updated_at = ?, user_edited_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).run(input.media_condition, input.sleeve_condition, input.private_notes, input.storage_location, input.acquired_on, input.acquired_from,
      input.acquisition_cost, input.acquisition_cost == null ? null : DEMO_CURRENCY, input.dj_energy, input.dj_bpm_notes, now, now, copyId, ownerId);
    if (unresolved) {
      db.prepare(
        `UPDATE copies SET artist_text = ?, title_text = ?, label_text = ?, catno_text = ?, format_group = ?, format_raw = ?, release_year = ?, genre_text = ?
         WHERE id = ? AND owner_id = ?`,
      ).run(input.artist_text, input.title_text, input.label_text, input.catno_text, input.format_group, input.format_raw, input.release_year, input.genre_text, copyId, ownerId);
    }
    setTags(db, ownerId, { type: "physical", id: copyId }, input.tags);
  })();
}

/** A physical copy, only if `ownerId` owns it. Others get 404 (existence is private too). */
export function getOwnCopy(db: DB, ownerId: number, copyId: number) {
  const copy = db
    .prepare(
      `SELECT c.*, li.artist, li.title, li.label, li.catno, li.format_group AS display_format_group, li.format_raw AS display_format_raw,
         li.year, li.genre, li.release_id, e.catalog_number, e.format, e.format_details, e.country, e.release_year AS edition_year,
         lb.name AS edition_label, r.title AS release_title
       FROM copies c JOIN library_items li ON li.item_type = 'physical' AND li.item_id = c.id
       LEFT JOIN editions e ON e.id = c.edition_id LEFT JOIN releases r ON r.id = e.release_id LEFT JOIN labels lb ON lb.id = e.label_id
       WHERE c.id = ? AND c.owner_id = ?`,
    )
    .get(copyId, ownerId) as any;
  if (!copy) throw notFound("Copy");
  copy.release_title = copy.release_title ?? copy.title;
  copy.tags = itemTags(db, { type: "physical", id: copyId });
  copy.crates = itemCrates(db, ownerId, { type: "physical", id: copyId });
  copy.photos = db.prepare("SELECT * FROM copy_photos WHERE copy_id = ? AND deleted_at IS NULL ORDER BY id").all(copyId);
  copy.listing = db.prepare("SELECT * FROM listings WHERE copy_id = ? AND status != 'withdrawn' ORDER BY id DESC LIMIT 1").get(copyId) ?? null;
  copy.source = copy.source_entry_id ? sourceInfo(db, copy.source_entry_id) : null;
  return copy;
}

/** Links an unresolved copy to an archive edition — only by explicit user choice. */
export function linkCopyToEdition(db: DB, clock: Clock, ownerId: number, copyId: number, editionId: number) {
  getOwnCopy(db, ownerId, copyId);
  if (!db.prepare("SELECT 1 FROM editions WHERE id = ?").get(editionId)) throw notFound("Edition");
  const now = iso(clock.now());
  db.prepare("UPDATE copies SET edition_id = ?, updated_at = ?, user_edited_at = ? WHERE id = ? AND owner_id = ?").run(editionId, now, now, copyId, ownerId);
}

// ───────────────────────── Digital holdings ─────────────────────────
const bpmField = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    const m = /^(\d{2,3})(?:\.(\d{1,2}))?$/.exec(v);
    if (!m || Number(m[1]) < 20 || Number(m[1]) > 300) {
      ctx.addIssue({ code: "custom", message: "BPM must be a number like 124 or 123.5." });
      return z.NEVER;
    }
    return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  });

export const digitalSchema = z.object({
  granularity: z.enum(["track", "release"], { error: "Choose track or release." }),
  holding_kind: z.enum(["purchased", "personal", "linked_to_physical", "unspecified"]).default("unspecified"),
  artist_text: requiredText("Artist", 300),
  title_text: requiredText("Title", 300),
  version_text: optionalText(120),
  album_text: optionalText(300),
  label_text: optionalText(200),
  catno_text: optionalText(80),
  genre_text: optionalText(120),
  release_year: optionalInt("Year", 1900, 2100),
  file_format: optionalText(20),
  bitrate_kbps: optionalInt("Bitrate", 8, 9999),
  sample_rate_hz: optionalInt("Sample rate", 8000, 768000),
  bit_depth: optionalInt("Bit depth", 8, 64),
  bpm: bpmField,
  musical_key: optionalText(12),
  private_notes: optionalText(4000),
  acquisition_source: optionalText(200),
  acquired_on: isoDateOptional,
  linked_copy_id: z.string().optional().transform((v) => (v ? Number(v) : null)),
  tags: trimmed(500).optional().transform((v) => parseTagList(v ?? "")),
});

function assertLinkedCopy(db: DB, ownerId: number, copyId: number | null) {
  if (copyId == null) return;
  if (!db.prepare("SELECT 1 FROM copies WHERE id = ? AND owner_id = ?").get(copyId, ownerId)) throw new DomainError("You can only link to one of your own physical copies.", 422);
}

export function createDigital(db: DB, clock: Clock, ownerId: number, raw: unknown, extra: Record<string, unknown> = {}): number {
  const d = parse(digitalSchema, raw);
  return db.transaction(() => {
    assertLinkedCopy(db, ownerId, d.linked_copy_id);
    const now = iso(clock.now());
    const cols: Record<string, unknown> = {
      owner_id: ownerId, granularity: d.granularity, holding_kind: d.holding_kind, artist_text: d.artist_text, title_text: d.title_text,
      version_text: d.version_text, album_text: d.album_text, label_text: d.label_text, catno_text: d.catno_text, genre_text: d.genre_text,
      release_year: d.release_year, file_format: d.file_format, bitrate_kbps: d.bitrate_kbps, sample_rate_hz: d.sample_rate_hz,
      bit_depth: d.bit_depth, bpm_x100: d.bpm, musical_key: d.musical_key, private_notes: d.private_notes, acquisition_source: d.acquisition_source,
      acquired_on: d.acquired_on, linked_copy_id: d.linked_copy_id, date_added: now, created_at: now, updated_at: now, ...extra,
    };
    const keys = Object.keys(cols);
    const id = Number(db.prepare(`INSERT INTO digital_holdings (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => cols[k])).lastInsertRowid);
    setTags(db, ownerId, { type: "digital", id }, d.tags);
    return id;
  })();
}

export function updateDigital(db: DB, clock: Clock, ownerId: number, id: number, raw: unknown) {
  const d = parse(digitalSchema, raw);
  db.transaction(() => {
    getOwnDigital(db, ownerId, id);
    assertLinkedCopy(db, ownerId, d.linked_copy_id);
    const now = iso(clock.now());
    db.prepare(
      `UPDATE digital_holdings SET granularity = ?, holding_kind = ?, artist_text = ?, title_text = ?, version_text = ?, album_text = ?, label_text = ?,
         catno_text = ?, genre_text = ?, release_year = ?, file_format = ?, bitrate_kbps = ?, sample_rate_hz = ?, bit_depth = ?, bpm_x100 = ?,
         musical_key = ?, private_notes = ?, acquisition_source = ?, acquired_on = ?, linked_copy_id = ?, updated_at = ?, user_edited_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).run(d.granularity, d.holding_kind, d.artist_text, d.title_text, d.version_text, d.album_text, d.label_text, d.catno_text, d.genre_text,
      d.release_year, d.file_format, d.bitrate_kbps, d.sample_rate_hz, d.bit_depth, d.bpm, d.musical_key, d.private_notes, d.acquisition_source,
      d.acquired_on, d.linked_copy_id, now, now, id, ownerId);
    setTags(db, ownerId, { type: "digital", id }, d.tags);
  })();
}

export function getOwnDigital(db: DB, ownerId: number, id: number) {
  const d = db.prepare("SELECT * FROM digital_holdings WHERE id = ? AND owner_id = ?").get(id, ownerId) as any;
  if (!d) throw notFound("Digital holding");
  d.tags = itemTags(db, { type: "digital", id });
  d.crates = itemCrates(db, ownerId, { type: "digital", id });
  d.source = d.source_entry_id ? sourceInfo(db, d.source_entry_id) : null;
  d.playlists = d.source_entry_id
    ? db.prepare(
        `SELECT DISTINCT sp.id, sp.path FROM source_playlist_items spi JOIN current_source_playlists sp ON sp.id = spi.playlist_id
         WHERE spi.source_entry_id = ? ORDER BY sp.path`,
      ).all(d.source_entry_id)
    : [];
  d.linked_copy = d.linked_copy_id ? db.prepare("SELECT item_id, artist, title, format_raw FROM library_items WHERE item_type = 'physical' AND item_id = ?").get(d.linked_copy_id) : null;
  return d;
}

function sourceInfo(db: DB, entryId: number) {
  const e = db
    .prepare("SELECT se.*, sl.kind, sl.name AS library_name FROM source_entries se JOIN source_libraries sl ON sl.id = se.source_library_id WHERE se.id = ?")
    .get(entryId) as any;
  if (!e) return null;
  return { ...e, data: JSON.parse(e.data) };
}

/**
 * Other holdings and wants connected to this item — ONLY through confirmed links: the same
 * archive release (via user-confirmed edition links) or an explicit digital→physical link.
 */
export function relatedHoldings(db: DB, ownerId: number, ref: ItemRef) {
  const row = db.prepare("SELECT release_id FROM library_items WHERE item_type = ? AND item_id = ? AND owner_id = ?").get(ref.type, ref.id, ownerId) as { release_id: number | null } | undefined;
  const items: any[] = [];
  if (row?.release_id) {
    items.push(...(db.prepare(
      "SELECT item_type, item_id, format_group, format_raw, catno FROM library_items WHERE owner_id = ? AND release_id = ? AND NOT (item_type = ? AND item_id = ?)",
    ).all(ownerId, row.release_id, ref.type, ref.id) as any[]).map((r) => ({ ...r, via: "same archive release" })));
  }
  if (ref.type === "physical") {
    items.push(...(db.prepare("SELECT 'digital' AS item_type, id AS item_id, 'Digital' AS format_group, file_format AS format_raw, NULL AS catno FROM digital_holdings WHERE owner_id = ? AND linked_copy_id = ?")
      .all(ownerId, ref.id) as any[]).map((r) => ({ ...r, via: "you linked this digital copy" })));
  } else {
    const d = db.prepare("SELECT linked_copy_id FROM digital_holdings WHERE id = ?").get(ref.id) as any;
    if (d?.linked_copy_id) items.push({ ...(db.prepare("SELECT item_type, item_id, format_group, format_raw, catno FROM library_items WHERE item_type = 'physical' AND item_id = ?").get(d.linked_copy_id) as any), via: "you linked this to a physical copy" });
  }
  const unique = new Map(items.map((i) => [`${i.item_type}:${i.item_id}`, i]));
  const wants = row?.release_id
    ? (db.prepare(
        `SELECT w.id, w.want_kind, w.configuration_note, e.catalog_number, e.format FROM wants w LEFT JOIN editions e ON e.id = w.edition_id
         WHERE w.user_id = ? AND w.release_id = ?`,
      ).all(ownerId, row.release_id) as any[])
    : [];
  return { items: [...unique.values()], wants };
}

// ───────────────────────── Tags ─────────────────────────
function tagId(db: DB, ownerId: number, name: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (owner_id, name) VALUES (?, ?)").run(ownerId, name);
  return (db.prepare("SELECT id FROM tags WHERE owner_id = ? AND name = ?").get(ownerId, name) as { id: number }).id;
}
const tagTable = (r: ItemRef) => (r.type === "physical" ? { table: "copy_tags", col: "copy_id" } : { table: "digital_tags", col: "digital_id" });

export function setTags(db: DB, ownerId: number, ref: ItemRef, names: string[]) {
  const { table, col } = tagTable(ref);
  db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(ref.id);
  for (const n of names) db.prepare(`INSERT OR IGNORE INTO ${table} (${col}, tag_id) VALUES (?, ?)`).run(ref.id, tagId(db, ownerId, n));
}

export function itemTags(db: DB, ref: ItemRef): string[] {
  const { table, col } = tagTable(ref);
  return db.prepare(`SELECT t.name FROM ${table} x JOIN tags t ON t.id = x.tag_id WHERE x.${col} = ? ORDER BY t.name`).all(ref.id).map((r: any) => r.name);
}

export function listTags(db: DB, ownerId: number) {
  return db
    .prepare(
      `SELECT t.id, t.name, (SELECT COUNT(*) FROM copy_tags WHERE tag_id = t.id) + (SELECT COUNT(*) FROM digital_tags WHERE tag_id = t.id) AS n
       FROM tags t WHERE t.owner_id = ? ORDER BY t.name`,
    )
    .all(ownerId) as { id: number; name: string; n: number }[];
}

// ───────────────────────── Crates (manual, ordered) ─────────────────────────
export const crateSchema = z.object({
  name: z.string().trim().min(1, "Give the crate a name.").max(60, "Keep crate names under 60 characters."),
  description: optionalText(1000),
});

export function createCrate(db: DB, clock: Clock, ownerId: number, raw: unknown): number {
  const c = parse(crateSchema, typeof raw === "string" ? { name: raw } : raw);
  if (db.prepare("SELECT 1 FROM crates WHERE owner_id = ? AND name = ?").get(ownerId, c.name)) throw new DomainError(`You already have a crate called “${c.name}”.`, 422);
  const now = iso(clock.now());
  return Number(db.prepare("INSERT INTO crates (owner_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(ownerId, c.name, c.description, now, now).lastInsertRowid);
}

export function updateCrate(db: DB, clock: Clock, ownerId: number, crateId: number, raw: unknown) {
  const c = parse(crateSchema, raw);
  getOwnCrate(db, ownerId, crateId);
  const clash = db.prepare("SELECT 1 FROM crates WHERE owner_id = ? AND name = ? AND id != ?").get(ownerId, c.name, crateId);
  if (clash) throw new DomainError(`You already have a crate called “${c.name}”.`, 422);
  db.prepare("UPDATE crates SET name = ?, description = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(c.name, c.description, iso(clock.now()), crateId, ownerId);
}

export function deleteCrate(db: DB, ownerId: number, crateId: number) {
  getOwnCrate(db, ownerId, crateId);
  db.prepare("DELETE FROM crates WHERE id = ? AND owner_id = ?").run(crateId, ownerId); // items cascade; holdings untouched
}

export function getOwnCrate(db: DB, ownerId: number, crateId: number) {
  const c = db.prepare("SELECT * FROM crates WHERE id = ? AND owner_id = ?").get(crateId, ownerId) as any;
  if (!c) throw notFound("Crate");
  return c;
}

export function crateItems(db: DB, ownerId: number, crateId: number) {
  getOwnCrate(db, ownerId, crateId);
  return db
    .prepare(
      `SELECT ci.id AS crate_item_id, ci.position, li.* FROM crate_items ci
       JOIN library_items li ON (li.item_type = 'physical' AND li.item_id = ci.copy_id) OR (li.item_type = 'digital' AND li.item_id = ci.digital_id)
       WHERE ci.crate_id = ? ORDER BY ci.position, ci.id`,
    )
    .all(crateId) as any[];
}

export function listCrates(db: DB, ownerId: number) {
  return db
    .prepare(
      `SELECT cr.id, cr.name, cr.description, cr.updated_at, COUNT(ci.id) AS n FROM crates cr LEFT JOIN crate_items ci ON ci.crate_id = cr.id
       WHERE cr.owner_id = ? GROUP BY cr.id ORDER BY cr.name COLLATE NOCASE`,
    )
    .all(ownerId) as { id: number; name: string; description: string | null; updated_at: string; n: number }[];
}

export function itemCrates(db: DB, ownerId: number, ref: ItemRef) {
  const col = ref.type === "physical" ? "copy_id" : "digital_id";
  return db
    .prepare(`SELECT cr.id, cr.name FROM crate_items ci JOIN crates cr ON cr.id = ci.crate_id WHERE ci.${col} = ? AND cr.owner_id = ? ORDER BY cr.name`)
    .all(ref.id, ownerId) as { id: number; name: string }[];
}

/** Appends owned items to the end of a crate, skipping ones already in it. Returns number added. */
export function addToCrate(db: DB, clock: Clock, ownerId: number, crateId: number, refs: ItemRef[]): number {
  return db.transaction(() => {
    getOwnCrate(db, ownerId, crateId);
    const owned = ownedRefs(db, ownerId, refs);
    let pos = (db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM crate_items WHERE crate_id = ?").get(crateId) as { p: number }).p;
    let added = 0;
    const now = iso(clock.now());
    for (const r of owned) {
      const col = r.type === "physical" ? "copy_id" : "digital_id";
      if (db.prepare(`SELECT 1 FROM crate_items WHERE crate_id = ? AND ${col} = ?`).get(crateId, r.id)) continue;
      db.prepare(`INSERT INTO crate_items (crate_id, position, ${col}, added_at) VALUES (?, ?, ?, ?)`).run(crateId, ++pos, r.id, now);
      added++;
    }
    db.prepare("UPDATE crates SET updated_at = ? WHERE id = ?").run(now, crateId);
    return added;
  })();
}

export function removeFromCrate(db: DB, clock: Clock, ownerId: number, crateId: number, refs: ItemRef[]): number {
  return db.transaction(() => {
    getOwnCrate(db, ownerId, crateId);
    let removed = 0;
    for (const r of ownedRefs(db, ownerId, refs)) {
      const col = r.type === "physical" ? "copy_id" : "digital_id";
      removed += db.prepare(`DELETE FROM crate_items WHERE crate_id = ? AND ${col} = ?`).run(crateId, r.id).changes;
    }
    renumberCrate(db, crateId);
    db.prepare("UPDATE crates SET updated_at = ? WHERE id = ?").run(iso(clock.now()), crateId);
    return removed;
  })();
}

function renumberCrate(db: DB, crateId: number) {
  const ids = db.prepare("SELECT id FROM crate_items WHERE crate_id = ? ORDER BY position, id").all(crateId) as { id: number }[];
  ids.forEach((r, i) => db.prepare("UPDATE crate_items SET position = ? WHERE id = ?").run(i + 1, r.id));
}

/** Moves one crate item to a 1-based position (clamped). Used by up/down/top/bottom/"move to" controls. */
export function moveCrateItem(db: DB, clock: Clock, ownerId: number, crateId: number, crateItemId: number, target: "up" | "down" | "top" | "bottom" | number) {
  db.transaction(() => {
    getOwnCrate(db, ownerId, crateId);
    const ids = (db.prepare("SELECT id FROM crate_items WHERE crate_id = ? ORDER BY position, id").all(crateId) as { id: number }[]).map((r) => r.id);
    const from = ids.indexOf(crateItemId);
    if (from === -1) throw notFound("Crate item");
    let to = typeof target === "number" ? target - 1 : target === "up" ? from - 1 : target === "down" ? from + 1 : target === "top" ? 0 : ids.length - 1;
    to = Math.max(0, Math.min(ids.length - 1, to));
    ids.splice(to, 0, ...ids.splice(from, 1));
    ids.forEach((id, i) => db.prepare("UPDATE crate_items SET position = ? WHERE id = ?").run(i + 1, id));
    db.prepare("UPDATE crates SET updated_at = ? WHERE id = ?").run(iso(clock.now()), crateId);
  })();
}

// ───────────────────────── Browsing the library ─────────────────────────
export interface LibraryFilters {
  q: string;
  type: "" | "physical" | "digital";
  format: string;
  genre: string;
  tag: string;
  crate: string;
  folder: string;        // Discogs folder name, or "pl:<playlist id>" for a Rekordbox playlist
  resolved: "" | "yes" | "no";
  batch: string;
  status: "" | "private" | "listed" | "sold";
}
export type LibrarySort = "artist" | "title" | "year" | "date_added";
export type LibraryGroup = "" | "format" | "genre" | "artist" | "label" | "folder";

export const SORT_LABELS: Record<LibrarySort, string> = { artist: "Artist", title: "Title", year: "Release year", date_added: "Date added" };
export const GROUP_LABELS: Record<LibraryGroup, string> = { "": "No grouping", format: "Format", genre: "Genre", artist: "Artist", label: "Label", folder: "Imported folder / playlist" };

export function parseLibraryFilters(q: Record<string, unknown>): LibraryFilters {
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T => (allowed.includes(String(v ?? "") as T) ? (String(v ?? "") as T) : allowed[0]);
  return {
    q: String(q.q ?? "").slice(0, 200),
    type: pick(q.type, ["", "physical", "digital"] as const),
    format: String(q.format ?? "").slice(0, 40),
    genre: String(q.genre ?? "").slice(0, 120),
    tag: String(q.tag ?? "").slice(0, 40),
    crate: /^\d*$/.test(String(q.crate ?? "")) ? String(q.crate ?? "") : "",
    folder: String(q.folder ?? "").slice(0, 200),
    resolved: pick(q.resolved, ["", "yes", "no"] as const),
    batch: /^\d*$/.test(String(q.batch ?? "")) ? String(q.batch ?? "") : "",
    status: pick(q.status, ["", "private", "listed", "sold"] as const),
  };
}

export function filterQuery(f: LibraryFilters, extra: Record<string, string | null | undefined> = {}): URLSearchParams {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) u.set(k, String(v));
  return u;
}

function whereFor(ownerId: number, f: LibraryFilters) {
  const where = ["li.owner_id = ?"];
  const args: unknown[] = [ownerId];
  for (const token of f.q.trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const like = `%${token.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    where.push(`(li.artist LIKE ? ESCAPE '\\' OR li.title LIKE ? ESCAPE '\\' OR li.label LIKE ? ESCAPE '\\' OR li.catno LIKE ? ESCAPE '\\' OR li.version LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like, like);
  }
  if (f.type) { where.push("li.item_type = ?"); args.push(f.type); }
  if (f.format) { where.push("li.format_group = ?"); args.push(f.format); }
  if (f.genre === "(none)") where.push("li.genre IS NULL");
  else if (f.genre) { where.push("(',' || REPLACE(li.genre, ', ', ',') || ',') LIKE ?"); args.push(`%,${f.genre},%`); }
  if (f.tag) {
    where.push(`((li.item_type = 'physical' AND EXISTS (SELECT 1 FROM copy_tags x JOIN tags t ON t.id = x.tag_id WHERE x.copy_id = li.item_id AND t.name = ? AND t.owner_id = li.owner_id))
      OR (li.item_type = 'digital' AND EXISTS (SELECT 1 FROM digital_tags x JOIN tags t ON t.id = x.tag_id WHERE x.digital_id = li.item_id AND t.name = ? AND t.owner_id = li.owner_id)))`);
    args.push(f.tag, f.tag);
  }
  if (f.crate) {
    where.push("EXISTS (SELECT 1 FROM crate_items ci WHERE ci.crate_id = ? AND ((li.item_type = 'physical' AND ci.copy_id = li.item_id) OR (li.item_type = 'digital' AND ci.digital_id = li.item_id)))");
    args.push(Number(f.crate));
  }
  if (f.folder.startsWith("pl:")) {
    where.push("li.item_type = 'digital' AND li.source_entry_id IN (SELECT spi.source_entry_id FROM source_playlist_items spi WHERE spi.playlist_id = ?)");
    args.push(Number(f.folder.slice(3)));
  } else if (f.folder === "(none)") where.push("li.folder IS NULL AND li.item_type = 'physical'");
  else if (f.folder) { where.push("li.folder = ?"); args.push(f.folder); }
  if (f.resolved === "yes") where.push("li.edition_id IS NOT NULL");
  if (f.resolved === "no") where.push("li.edition_id IS NULL");
  if (f.batch) { where.push("li.created_by_batch_id = ?"); args.push(Number(f.batch)); }
  const active = "SELECT 1 FROM listings l WHERE l.copy_id = li.item_id AND l.status";
  if (f.status === "private") where.push(`NOT (li.item_type = 'physical' AND EXISTS (${active} IN ('draft','available','reserved','sold')))`);
  if (f.status === "listed") where.push(`li.item_type = 'physical' AND EXISTS (${active} IN ('draft','available','reserved'))`);
  if (f.status === "sold") where.push(`li.item_type = 'physical' AND EXISTS (${active} = 'sold')`);
  return { sql: `FROM library_items li WHERE ${where.join(" AND ")}`, args };
}

const ORDER: Record<LibrarySort, string> = {
  artist: "li.artist COLLATE NOCASE, li.title COLLATE NOCASE",
  title: "li.title COLLATE NOCASE, li.artist COLLATE NOCASE",
  year: "li.year IS NULL, li.year, li.artist COLLATE NOCASE",
  date_added: "li.date_added",
};

export function listLibrary(db: DB, ownerId: number, f: LibraryFilters, sort: LibrarySort, dir: "asc" | "desc", page: number, pageSize: number) {
  const { sql, args } = whereFor(ownerId, f);
  const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n;
  const order = ORDER[sort] ?? ORDER.artist;
  const orderSql = dir === "desc" ? order.split(", ").map((p) => (p.endsWith("IS NULL") ? p : `${p} DESC`)).join(", ") : order;
  const rows = db
    .prepare(
      `SELECT li.*, (SELECT ai.id FROM archive_images ai WHERE ai.edition_id = li.edition_id ORDER BY ai.kind = 'front' DESC, ai.id LIMIT 1) AS image_id,
         CASE WHEN li.item_type = 'physical' THEN (SELECT l.status FROM listings l WHERE l.copy_id = li.item_id AND l.status != 'withdrawn' ORDER BY l.id DESC LIMIT 1) END AS listing_status
       ${sql} ORDER BY ${orderSql}, li.item_type, li.item_id LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize) as any[];
  for (const r of rows) r.tags = itemTags(db, { type: r.item_type, id: r.item_id });
  return { total, rows };
}

export function matchingRefs(db: DB, ownerId: number, f: LibraryFilters): ItemRef[] {
  const { sql, args } = whereFor(ownerId, f);
  return (db.prepare(`SELECT li.item_type, li.item_id ${sql} ORDER BY li.item_type, li.item_id`).all(...args) as any[]).map((r) => ({ type: r.item_type, id: r.item_id }));
}

/** Group headers with counts; each group links to a filtered view. */
export function groupCounts(db: DB, ownerId: number, f: LibraryFilters, group: Exclude<LibraryGroup, "">) {
  const { sql, args } = whereFor(ownerId, f);
  if (group === "folder") {
    const folders = db.prepare(`SELECT COALESCE(li.folder, '(none)') AS key, COUNT(*) AS n ${sql} AND li.item_type = 'physical' GROUP BY key ORDER BY key`).all(...args) as any[];
    const playlists = db
      .prepare(
        `SELECT 'pl:' || sp.id AS key, sp.path AS label, COUNT(DISTINCT li.item_id) AS n FROM current_source_playlists sp
         JOIN source_playlist_items spi ON spi.playlist_id = sp.id
         JOIN library_items li ON li.item_type = 'digital' AND li.source_entry_id = spi.source_entry_id
         ${sql.replace("FROM library_items li WHERE", "WHERE")} AND sp.node_type = 'playlist' GROUP BY sp.id ORDER BY sp.path`,
      )
      .all(...args) as any[];
    return [
      ...folders.map((r) => ({ key: r.key, label: r.key === "(none)" ? "Physical — no imported folder" : `Discogs folder: ${r.key}`, n: r.n })),
      ...playlists.map((r) => ({ key: r.key, label: `Rekordbox playlist: ${r.label}`, n: r.n })),
    ];
  }
  if (group === "genre") {
    const rows = db.prepare(`SELECT li.genre ${sql}`).all(...args) as { genre: string | null }[];
    const counts = new Map<string, number>();
    for (const r of rows) for (const g of r.genre ? r.genre.split(", ") : ["(none)"]) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, n]) => ({ key, label: key === "(none)" ? "No genre recorded" : key, n }));
  }
  const col = group === "format" ? "li.format_group" : group === "artist" ? "li.artist" : "li.label";
  return (db.prepare(`SELECT COALESCE(${col}, '(none)') AS key, COUNT(*) AS n ${sql} GROUP BY key ORDER BY key COLLATE NOCASE`).all(...args) as any[])
    .map((r) => ({ key: r.key, label: r.key === "(none)" ? "Not recorded" : r.key, n: r.n }));
}

export function libraryCounts(db: DB, ownerId: number) {
  return db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM copies WHERE owner_id = ?) AS physical_copies,
        (SELECT COUNT(DISTINCT edition_id) FROM copies WHERE owner_id = ? AND edition_id IS NOT NULL) AS physical_editions,
        (SELECT COUNT(*) FROM copies WHERE owner_id = ? AND edition_id IS NULL) AS physical_unresolved,
        (SELECT COUNT(DISTINCT release_id) FROM library_items WHERE owner_id = ? AND release_id IS NOT NULL) AS releases_linked,
        (SELECT COUNT(*) FROM digital_holdings WHERE owner_id = ? AND granularity = 'track') AS digital_tracks,
        (SELECT COUNT(*) FROM digital_holdings WHERE owner_id = ? AND granularity = 'release') AS digital_releases,
        (SELECT COUNT(*) FROM wants WHERE user_id = ?) AS wants,
        (SELECT COUNT(*) FROM crates WHERE owner_id = ?) AS crates`,
    )
    .get(ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId) as Record<string, number>;
}

export function libraryFacets(db: DB, ownerId: number) {
  const genres = new Set<string>();
  for (const r of db.prepare("SELECT DISTINCT genre FROM library_items WHERE owner_id = ? AND genre IS NOT NULL").all(ownerId) as any[]) for (const g of String(r.genre).split(", ")) genres.add(g);
  return {
    formats: (db.prepare("SELECT DISTINCT format_group FROM library_items WHERE owner_id = ? ORDER BY format_group").all(ownerId) as any[]).map((r) => r.format_group as string),
    genres: [...genres].sort(),
    folders: (db.prepare("SELECT DISTINCT folder FROM library_items WHERE owner_id = ? AND folder IS NOT NULL ORDER BY folder").all(ownerId) as any[]).map((r) => r.folder as string),
    playlists: db.prepare(
      `SELECT sp.id, sp.path FROM current_source_playlists sp JOIN source_libraries sl ON sl.id = sp.source_library_id WHERE sl.owner_id = ? AND sp.node_type = 'playlist' ORDER BY sp.path`,
    ).all(ownerId) as { id: number; path: string }[],
  };
}

// ───────────────────────── Bulk actions ─────────────────────────
export type BulkScope = "selected" | "page" | "all_matching";
export interface BulkRequest { scope: BulkScope; selected: ItemRef[]; page: ItemRef[]; filters: LibraryFilters }

export function bulkRequestFromBody(body: Record<string, unknown>): BulkRequest {
  const scope = String(body.scope ?? "selected");
  const f: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (k.startsWith("f_")) f[k.slice(2)] = v;
  return {
    scope: (["selected", "page", "all_matching"].includes(scope) ? scope : "selected") as BulkScope,
    selected: parseRefs(body.refs),
    page: parseRefs(body.page_refs),
    filters: parseLibraryFilters(f),
  };
}

/** Resolves exactly which items a bulk action affects. "all_matching" is recomputed server-side. */
export function resolveBulkScope(db: DB, ownerId: number, req: BulkRequest): ItemRef[] {
  if (req.scope === "all_matching") return matchingRefs(db, ownerId, req.filters);
  return ownedRefs(db, ownerId, req.scope === "page" ? req.page : req.selected);
}

export type BulkAction =
  | { kind: "add_tag"; tag: string }
  | { kind: "remove_tag"; tag: string }
  | { kind: "add_to_crate"; crateId: number }
  | { kind: "remove_from_crate"; crateId: number };

export function parseBulkAction(body: Record<string, unknown>): BulkAction {
  const kind = String(body.action ?? "");
  if (kind === "add_tag" || kind === "remove_tag") {
    const [tag] = parseTagList(String(body.tag ?? ""));
    if (!tag) throw new DomainError("Enter a tag name.", 422);
    return { kind, tag };
  }
  if (kind === "add_to_crate" || kind === "remove_from_crate") {
    const crateId = Number(body.crate_id);
    if (!crateId) throw new DomainError("Choose a crate.", 422);
    return { kind, crateId };
  }
  throw new DomainError("Choose a bulk action.", 422);
}

export function describeBulkAction(db: DB, ownerId: number, a: BulkAction): string {
  if (a.kind === "add_tag") return `Add tag “${a.tag}”`;
  if (a.kind === "remove_tag") return `Remove tag “${a.tag}”`;
  const c = db.prepare("SELECT name FROM crates WHERE id = ? AND owner_id = ?").get(a.crateId, ownerId) as { name: string } | undefined;
  return `${a.kind === "add_to_crate" ? "Add to" : "Remove from"} crate “${c?.name ?? "?"}”`;
}

export function applyBulkAction(db: DB, clock: Clock, ownerId: number, refs: ItemRef[], action: BulkAction): number {
  return db.transaction(() => {
    const owned = ownedRefs(db, ownerId, refs);
    if (action.kind === "add_to_crate") return addToCrate(db, clock, ownerId, action.crateId, owned);
    if (action.kind === "remove_from_crate") return removeFromCrate(db, clock, ownerId, action.crateId, owned);
    let changed = 0;
    const tag = action.tag;
    for (const r of owned) {
      const { table, col } = tagTable(r);
      if (action.kind === "add_tag") changed += db.prepare(`INSERT OR IGNORE INTO ${table} (${col}, tag_id) VALUES (?, ?)`).run(r.id, tagId(db, ownerId, tag)).changes;
      else changed += db.prepare(`DELETE FROM ${table} WHERE ${col} = ? AND tag_id = (SELECT id FROM tags WHERE owner_id = ? AND name = ?)`).run(r.id, ownerId, tag).changes;
    }
    return changed;
  })();
}

// ───────────────────────── Photos (physical copies only) ─────────────────────────
export function addCopyPhoto(db: DB, clock: Clock, ownerId: number, copyId: number, photo: { storage_path?: string; placeholder_seed?: string; caption?: string | null }) {
  getOwnCopy(db, ownerId, copyId);
  return Number(
    db.prepare("INSERT INTO copy_photos (copy_id, storage_path, placeholder_seed, caption, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(copyId, photo.storage_path ?? null, photo.placeholder_seed ?? null, photo.caption ?? null, iso(clock.now())).lastInsertRowid,
  );
}

export function deleteCopyPhoto(db: DB, clock: Clock, ownerId: number, photoId: number) {
  const row = db.prepare("SELECT p.id FROM copy_photos p JOIN copies c ON c.id = p.copy_id WHERE p.id = ? AND c.owner_id = ? AND p.deleted_at IS NULL").get(photoId, ownerId);
  if (!row) throw notFound("Photo");
  const inActive = db.prepare("SELECT 1 FROM listing_photos lp JOIN listings l ON l.id = lp.listing_id WHERE lp.copy_photo_id = ? AND l.status IN ('available','reserved')").get(photoId);
  if (inActive) throw new DomainError("This photo is shown on a published listing. Edit or withdraw the listing first.");
  db.prepare("UPDATE copy_photos SET deleted_at = ? WHERE id = ?").run(iso(clock.now()), photoId);
}

// ───────────────────────── Saved view preferences (server-side) ─────────────────────────
export function getPref<T>(db: DB, userId: number, key: string, fallback: T): T {
  const r = db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined;
  if (!r) return fallback;
  try { return { ...fallback, ...JSON.parse(r.value) }; } catch { return fallback; }
}
export function setPref(db: DB, userId: number, key: string, value: unknown) {
  db.prepare("INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value").run(userId, key, JSON.stringify(value));
}
