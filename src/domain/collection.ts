import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, notFound } from "../lib/errors.js";
import { DEMO_CURRENCY } from "../lib/money.js";
import { MEDIA_CODES, SLEEVE_CODES } from "../lib/reference.js";
import { asArray, isoDateOptional, moneyField, optionalInt, optionalText, parse, trimmed } from "../lib/validation.js";
import { artistCredits } from "./catalog.js";

// Suggested personal DJ tags — users can create any others.
export const SUGGESTED_DJ_TAGS = ["warm-up", "peak-time", "closing", "vocal", "instrumental", "dub", "tool", "edit-worthy"];

export const copySchema = z.object({
  media_condition: z.string().refine((v) => MEDIA_CODES.includes(v), "Choose a media condition."),
  sleeve_condition: z.string().refine((v) => SLEEVE_CODES.includes(v), "Choose a sleeve condition."),
  private_notes: optionalText(4000),
  storage_location: optionalText(200),
  acquired_on: isoDateOptional,
  acquired_from: optionalText(200),
  acquisition_cost: moneyField("Acquisition cost", { required: false }),
  crate_id: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : null)),
  dj_energy: optionalInt("Energy", 1, 5),
  dj_bpm_notes: optionalText(200),
  tags: trimmed(500).optional().transform((v) => parseTagList(v ?? "")),
});
export type CopyInput = z.infer<typeof copySchema>;

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
  const ok = db.prepare("SELECT 1 FROM crates WHERE id = ? AND owner_id = ?").get(crateId, ownerId);
  if (!ok) throw new DomainError("That crate does not exist.", 422);
}

export function createCopy(db: DB, clock: Clock, ownerId: number, editionId: number, raw: unknown): number {
  const input = parse(copySchema, raw);
  if (!db.prepare("SELECT 1 FROM editions WHERE id = ?").get(editionId)) throw notFound("Edition");
  return db.transaction(() => {
    assertCrateOwned(db, ownerId, input.crate_id);
    const now = iso(clock.now());
    const id = Number(
      db
        .prepare(
          `INSERT INTO copies (owner_id, edition_id, media_condition, sleeve_condition, crate_id, private_notes, storage_location,
            acquired_on, acquired_from, acquisition_cost_cents, acquisition_currency, dj_energy, dj_bpm_notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ownerId,
          editionId,
          input.media_condition,
          input.sleeve_condition,
          input.crate_id,
          input.private_notes,
          input.storage_location,
          input.acquired_on,
          input.acquired_from,
          input.acquisition_cost,
          input.acquisition_cost == null ? null : DEMO_CURRENCY,
          input.dj_energy,
          input.dj_bpm_notes,
          now,
          now,
        ).lastInsertRowid,
    );
    setCopyTags(db, ownerId, id, input.tags);
    return id;
  })();
}

export function updateCopy(db: DB, clock: Clock, ownerId: number, copyId: number, raw: unknown) {
  const input = parse(copySchema, raw);
  db.transaction(() => {
    getOwnCopy(db, ownerId, copyId);
    assertCrateOwned(db, ownerId, input.crate_id);
    db.prepare(
      `UPDATE copies SET media_condition = ?, sleeve_condition = ?, crate_id = ?, private_notes = ?, storage_location = ?,
        acquired_on = ?, acquired_from = ?, acquisition_cost_cents = ?, acquisition_currency = ?, dj_energy = ?, dj_bpm_notes = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    ).run(
      input.media_condition,
      input.sleeve_condition,
      input.crate_id,
      input.private_notes,
      input.storage_location,
      input.acquired_on,
      input.acquired_from,
      input.acquisition_cost,
      input.acquisition_cost == null ? null : DEMO_CURRENCY,
      input.dj_energy,
      input.dj_bpm_notes,
      iso(clock.now()),
      copyId,
      ownerId,
    );
    setCopyTags(db, ownerId, copyId, input.tags);
  })();
}

/** Returns the copy only if `ownerId` owns it. Other users get a 404 (existence is private too). */
export function getOwnCopy(db: DB, ownerId: number, copyId: number) {
  const copy = db
    .prepare(
      `SELECT c.*, e.release_id, e.catalog_number, e.format, e.format_details, e.country, e.release_year, l.name AS label,
         r.title AS release_title, cr.name AS crate_name
       FROM copies c JOIN editions e ON e.id = c.edition_id JOIN releases r ON r.id = e.release_id
       LEFT JOIN labels l ON l.id = e.label_id LEFT JOIN crates cr ON cr.id = c.crate_id
       WHERE c.id = ? AND c.owner_id = ?`,
    )
    .get(copyId, ownerId) as any;
  if (!copy) throw notFound("Copy");
  copy.artist = artistCredits(db, [copy.release_id]).get(copy.release_id);
  copy.tags = copyTags(db, copyId);
  copy.photos = db.prepare("SELECT * FROM copy_photos WHERE copy_id = ? AND deleted_at IS NULL ORDER BY id").all(copyId);
  copy.listing = db
    .prepare("SELECT * FROM listings WHERE copy_id = ? AND status != 'withdrawn' ORDER BY id DESC LIMIT 1")
    .get(copyId) ?? null;
  return copy;
}

export function copyTags(db: DB, copyId: number): string[] {
  return db
    .prepare("SELECT t.name FROM copy_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.copy_id = ? ORDER BY t.name")
    .all(copyId)
    .map((r: any) => r.name);
}

function tagId(db: DB, ownerId: number, name: string): number {
  db.prepare("INSERT OR IGNORE INTO tags (owner_id, name) VALUES (?, ?)").run(ownerId, name);
  return (db.prepare("SELECT id FROM tags WHERE owner_id = ? AND name = ?").get(ownerId, name) as { id: number }).id;
}

export function setCopyTags(db: DB, ownerId: number, copyId: number, names: string[]) {
  db.prepare("DELETE FROM copy_tags WHERE copy_id = ?").run(copyId);
  for (const n of names) db.prepare("INSERT OR IGNORE INTO copy_tags (copy_id, tag_id) VALUES (?, ?)").run(copyId, tagId(db, ownerId, n));
}

export function listTags(db: DB, ownerId: number) {
  return db
    .prepare(
      `SELECT t.id, t.name, COUNT(ct.copy_id) AS n FROM tags t LEFT JOIN copy_tags ct ON ct.tag_id = t.id
       WHERE t.owner_id = ? GROUP BY t.id ORDER BY t.name`,
    )
    .all(ownerId) as { id: number; name: string; n: number }[];
}

export function listCrates(db: DB, ownerId: number) {
  return db
    .prepare(
      `SELECT cr.id, cr.name, COUNT(c.id) AS n FROM crates cr LEFT JOIN copies c ON c.crate_id = cr.id
       WHERE cr.owner_id = ? GROUP BY cr.id ORDER BY cr.name COLLATE NOCASE`,
    )
    .all(ownerId) as { id: number; name: string; n: number }[];
}

export function createCrate(db: DB, clock: Clock, ownerId: number, rawName: unknown): number {
  const name = parse(z.string().trim().min(1, "Give the crate a name.").max(60, "Keep crate names under 60 characters."), rawName ?? "");
  const exists = db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = ?").get(ownerId, name);
  if (exists) throw new DomainError(`You already have a crate called “${name}”.`, 422);
  return Number(db.prepare("INSERT INTO crates (owner_id, name, created_at) VALUES (?, ?, ?)").run(ownerId, name, iso(clock.now())).lastInsertRowid);
}

// ───────────────────────── Listing the collection ─────────────────────────
export interface CollectionFilters {
  q: string;
  crate: string; // "" = any, "none" = not in a crate, or crate id
  tag: string; // "" = any, or tag name
  status: "" | "private" | "listed" | "sold";
}

export function parseCollectionFilters(q: Record<string, unknown>): CollectionFilters {
  const status = String(q.status ?? "");
  return {
    q: String(q.q ?? "").slice(0, 100),
    crate: String(q.crate ?? ""),
    tag: String(q.tag ?? ""),
    status: (["private", "listed", "sold"].includes(status) ? status : "") as CollectionFilters["status"],
  };
}

function filterSql(ownerId: number, f: CollectionFilters) {
  const where = ["c.owner_id = ?"];
  const args: unknown[] = [ownerId];
  if (f.q.trim()) {
    const like = `%${f.q.trim()}%`;
    where.push(`(r.title LIKE ? OR e.catalog_number LIKE ? OR l.name LIKE ? OR c.private_notes LIKE ? OR c.storage_location LIKE ?
      OR EXISTS (SELECT 1 FROM release_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.release_id = r.id AND a.name LIKE ?))`);
    args.push(like, like, like, like, like, like);
  }
  if (f.crate === "none") where.push("c.crate_id IS NULL");
  else if (f.crate) {
    where.push("c.crate_id = ?");
    args.push(Number(f.crate));
  }
  if (f.tag) {
    where.push("EXISTS (SELECT 1 FROM copy_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.copy_id = c.id AND t.name = ?)");
    args.push(f.tag);
  }
  const activeListing = "SELECT 1 FROM listings li WHERE li.copy_id = c.id AND li.status";
  if (f.status === "private") where.push(`NOT EXISTS (${activeListing} IN ('draft','available','reserved','sold'))`);
  if (f.status === "listed") where.push(`EXISTS (${activeListing} IN ('draft','available','reserved'))`);
  if (f.status === "sold") where.push(`EXISTS (${activeListing} = 'sold')`);
  return {
    sql: `FROM copies c JOIN editions e ON e.id = c.edition_id JOIN releases r ON r.id = e.release_id
          LEFT JOIN labels l ON l.id = e.label_id LEFT JOIN crates cr ON cr.id = c.crate_id
          WHERE ${where.join(" AND ")}`,
    args,
  };
}

export const COLLECTION_PAGE_SIZE = 20;

export function listCopies(db: DB, ownerId: number, f: CollectionFilters, page: number, pageSize = COLLECTION_PAGE_SIZE) {
  const { sql, args } = filterSql(ownerId, f);
  const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT c.id, c.edition_id, c.media_condition, c.sleeve_condition, c.storage_location, c.dj_energy, c.dj_bpm_notes,
         e.release_id, e.catalog_number, e.format, e.format_details, e.country, e.release_year, l.name AS label, r.title AS release_title,
         cr.name AS crate_name,
         (SELECT li.status FROM listings li WHERE li.copy_id = c.id AND li.status != 'withdrawn' ORDER BY li.id DESC LIMIT 1) AS listing_status,
         (SELECT ai.id FROM archive_images ai WHERE ai.edition_id = c.edition_id ORDER BY ai.id LIMIT 1) AS image_id
       ${sql} ORDER BY r.title COLLATE NOCASE, c.id LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize) as any[];
  const credits = artistCredits(db, [...new Set(rows.map((r) => r.release_id))]);
  for (const r of rows) {
    r.artist = credits.get(r.release_id);
    r.tags = copyTags(db, r.id);
  }
  return { total, rows };
}

export function matchingCopyIds(db: DB, ownerId: number, f: CollectionFilters): number[] {
  const { sql, args } = filterSql(ownerId, f);
  return db
    .prepare(`SELECT c.id ${sql} ORDER BY c.id`)
    .all(...args)
    .map((r: any) => r.id);
}

// ───────────────────────── Bulk actions ─────────────────────────
export type BulkScope = "selected" | "page" | "all_matching";

export interface BulkRequest {
  scope: BulkScope;
  selectedIds: number[];
  pageIds: number[];
  filters: CollectionFilters;
}

/**
 * Resolves exactly which copies a bulk action applies to. IDs submitted by the browser are
 * intersected with the user's own copies, so foreign IDs are silently dropped.
 * "all_matching" is recomputed server-side from the filters.
 */
export function resolveBulkScope(db: DB, ownerId: number, req: BulkRequest): number[] {
  let ids: number[];
  if (req.scope === "all_matching") ids = matchingCopyIds(db, ownerId, req.filters);
  else ids = req.scope === "page" ? req.pageIds : req.selectedIds;
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  return db
    .prepare(`SELECT id FROM copies WHERE owner_id = ? AND id IN (${unique.map(() => "?").join(",")}) ORDER BY id`)
    .all(ownerId, ...unique)
    .map((r: any) => r.id);
}

export type BulkAction =
  | { kind: "add_tag"; tag: string }
  | { kind: "remove_tag"; tag: string }
  | { kind: "move_crate"; crateId: number | null };

export function parseBulkAction(body: Record<string, unknown>): BulkAction {
  const kind = String(body.action ?? "");
  if (kind === "add_tag" || kind === "remove_tag") {
    const [tag] = parseTagList(String(body.tag ?? ""));
    if (!tag) throw new DomainError("Enter a tag name.", 422);
    return { kind, tag };
  }
  if (kind === "move_crate") {
    const v = String(body.crate_id ?? "");
    if (v === "") throw new DomainError("Choose a destination crate.", 422);
    return { kind, crateId: v === "none" ? null : Number(v) };
  }
  throw new DomainError("Choose a bulk action.", 422);
}

export function describeBulkAction(db: DB, a: BulkAction): string {
  if (a.kind === "add_tag") return `Add tag “${a.tag}”`;
  if (a.kind === "remove_tag") return `Remove tag “${a.tag}”`;
  if (a.crateId == null) return "Remove from crate (no crate)";
  const c = db.prepare("SELECT name FROM crates WHERE id = ?").get(a.crateId) as { name: string } | undefined;
  return `Move to crate “${c?.name ?? "?"}”`;
}

export function applyBulkAction(db: DB, clock: Clock, ownerId: number, ids: number[], action: BulkAction): number {
  return db.transaction(() => {
    const owned = resolveBulkScope(db, ownerId, { scope: "selected", selectedIds: ids, pageIds: [], filters: parseCollectionFilters({}) });
    if (action.kind === "move_crate") assertCrateOwned(db, ownerId, action.crateId);
    const now = iso(clock.now());
    let changed = 0;
    for (const id of owned) {
      if (action.kind === "add_tag") {
        changed += db.prepare("INSERT OR IGNORE INTO copy_tags (copy_id, tag_id) VALUES (?, ?)").run(id, tagId(db, ownerId, action.tag)).changes;
      } else if (action.kind === "remove_tag") {
        changed += db
          .prepare("DELETE FROM copy_tags WHERE copy_id = ? AND tag_id = (SELECT id FROM tags WHERE owner_id = ? AND name = ?)")
          .run(id, ownerId, action.tag).changes;
      } else {
        changed += db
          .prepare("UPDATE copies SET crate_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND crate_id IS NOT ?")
          .run(action.crateId, now, id, ownerId, action.crateId).changes;
      }
    }
    return changed;
  })();
}

export function bulkRequestFromBody(body: Record<string, unknown>): BulkRequest {
  const scope = String(body.scope ?? "selected");
  const filters = parseCollectionFilters({ q: body.f_q, crate: body.f_crate, tag: body.f_tag, status: body.f_status });
  return {
    scope: (["selected", "page", "all_matching"].includes(scope) ? scope : "selected") as BulkScope,
    selectedIds: asArray(body.ids).map(Number).filter(Number.isSafeInteger),
    pageIds: asArray(body.page_ids).map(Number).filter(Number.isSafeInteger),
    filters,
  };
}

export function addCopyPhoto(db: DB, clock: Clock, ownerId: number, copyId: number, photo: { storage_path?: string; placeholder_seed?: string; caption?: string | null }) {
  getOwnCopy(db, ownerId, copyId);
  return Number(
    db
      .prepare("INSERT INTO copy_photos (copy_id, storage_path, placeholder_seed, caption, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(copyId, photo.storage_path ?? null, photo.placeholder_seed ?? null, photo.caption ?? null, iso(clock.now())).lastInsertRowid,
  );
}

export function deleteCopyPhoto(db: DB, clock: Clock, ownerId: number, photoId: number) {
  const row = db
    .prepare("SELECT p.id FROM copy_photos p JOIN copies c ON c.id = p.copy_id WHERE p.id = ? AND c.owner_id = ? AND p.deleted_at IS NULL")
    .get(photoId, ownerId);
  if (!row) throw notFound("Photo");
  const inActiveListing = db
    .prepare(
      "SELECT 1 FROM listing_photos lp JOIN listings l ON l.id = lp.listing_id WHERE lp.copy_photo_id = ? AND l.status IN ('available','reserved')",
    )
    .get(photoId);
  if (inActiveListing) throw new DomainError("This photo is shown on a published listing. Edit or withdraw the listing first.");
  db.prepare("UPDATE copy_photos SET deleted_at = ? WHERE id = ?").run(iso(clock.now()), photoId);
}
