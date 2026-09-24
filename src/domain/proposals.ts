/**
 * Moderated contributions to the catalog: new releases (versions of a master) and corrections.
 * Proposals stay pending until a moderator accepts them. Accepted changes write only catalog
 * tables and are recorded in release_revisions; the release is marked `local_edited_at` so later
 * Discogs dump updates don't silently overwrite local editorial work.
 * (The stored `kind` value for a new release is 'new_edition' for backwards compatibility.)
 */
import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, forbidden, notFound } from "../lib/errors.js";
import { requireRole, type CurrentUser } from "../lib/auth.js";
import { FORMATS, IDENTIFIER_KINDS, SOURCE_KINDS } from "../lib/reference.js";
import { optionalInt, optionalText, parse, requiredText, ValidationError } from "../lib/validation.js";
import { parseMediaLinkLines, serializeMediaLinks } from "../lib/mediaLinks.js";
import { normalizeCode, normalizeName } from "../services/catalog-api/normalize.js";
import { releaseDocuments, searchBackend } from "../services/search/index.js";
import { findDuplicateCandidates, formatDuration, type DuplicateCandidate } from "./catalog.js";

/** Release fields a contribution can set. Tracks, identifiers and links are one-per-line text. */
export const releasePayloadSchema = z.object({
  label_name: optionalText(120),
  catalog_number: optionalText(60),
  format: z.string().refine((v) => (FORMATS as readonly string[]).includes(v), "Choose a format."),
  format_details: optionalText(120),
  country: optionalText(60),
  release_year: optionalInt("Year", 1850, 2100),
  release_month: optionalInt("Month", 1, 12),
  release_day: optionalInt("Day", 1, 31),
  date_note: optionalText(300),
  edition_notes: optionalText(2000),
  tracks: z.string().optional().transform((v, ctx) => {
    try { return serializeTracks(parseTrackLines(v ?? "")); } catch (e: any) { ctx.addIssue({ code: "custom", message: e.message }); return z.NEVER; }
  }),
  identifiers: z.string().optional().transform((v, ctx) => {
    try { return serializeIdentifiers(parseIdentifierLines(v ?? "")); } catch (e: any) { ctx.addIssue({ code: "custom", message: e.message }); return z.NEVER; }
  }),
  listening_links: z.string().optional().transform((v, ctx) => {
    try { return serializeMediaLinks(parseMediaLinkLines(v ?? "")); } catch (e: any) { ctx.addIssue({ code: "custom", message: e.message }); return z.NEVER; }
  }),
});
export type ReleasePayload = z.infer<typeof releasePayloadSchema>;
/** @deprecated old names */
export const editionPayloadSchema = releasePayloadSchema;
export type EditionPayload = ReleasePayload;

export const sourceSchema = z.object({
  source_notes: requiredText("Source notes", 2000).refine((v) => v.length >= 10, "Explain where this information comes from (10+ characters)."),
  source_kind: z.string().refine((v) => v in SOURCE_KINDS, "Choose a source type."),
  source_citation: requiredText("Source citation", 300),
  source_url: z.string().trim().optional().transform((v) => v || null).refine((v) => v == null || /^https?:\/\/\S+$/.test(v), "Use a full http(s) URL, or leave blank."),
});

// ───────── Text formats (kept human-editable on purpose) ─────────
export interface TrackLine { position: string; title: string; artist_credit: string | null; duration_seconds: number | null }

/** "A1 | Title | 6:12"; a different artist credit with " // ". */
export function parseTrackLines(text: string): TrackLine[] {
  const out: TrackLine[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error(`Track line ${i + 1}: use “position | title | duration”.`);
    let duration: number | null = null;
    if (parts[2]) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(parts[2]);
      if (!m) throw new Error(`Track line ${i + 1}: duration must look like 6:12.`);
      duration = Number(m[1]) * 60 + Number(m[2]);
    }
    const [title, artist] = parts[1].split(" // ").map((s) => s.trim());
    out.push({ position: parts[0].slice(0, 10), title: title.slice(0, 200), artist_credit: artist ? artist.slice(0, 200) : null, duration_seconds: duration });
  });
  return out;
}
export function serializeTracks(tracks: TrackLine[]): string {
  return tracks.map((t) => [t.position, t.title + (t.artist_credit ? ` // ${t.artist_credit}` : ""), formatDuration(t.duration_seconds)].filter((x, i) => i < 2 || x).join(" | ")).join("\n");
}

export interface IdentifierLine { type: string; value: string; description: string | null }

/**
 * "Barcode: 5 012345 678900", "Matrix / Runout: LLR-004 A — etched", or any Discogs type such as
 * "SPARS Code: DDD". Short keys (barcode, matrix_runout, label_code, rights_society, other) are accepted.
 */
export function parseIdentifierLines(text: string): IdentifierLine[] {
  const out: IdentifierLine[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const m = /^([^:]{2,40}):\s*(.+)$/.exec(line.trim());
    if (!m) throw new Error(`Identifier line ${i + 1}: use “Type: value”, e.g. “Barcode: 5012345678900” or “Matrix / Runout: …”.`);
    const key = m[1].trim();
    const type = IDENTIFIER_KINDS[key.toLowerCase()] ?? key;
    const [value, description] = m[2].split(" — ").map((s) => s.trim());
    out.push({ type: type.slice(0, 40), value: value.slice(0, 200), description: description ? description.slice(0, 200) : null });
  });
  return out;
}
export function serializeIdentifiers(ids: IdentifierLine[]): string {
  return ids.map((i) => `${i.type}: ${i.value}${i.description ? ` — ${i.description}` : ""}`).join("\n");
}

function splitDate(released: string | null): [number | null, number | null, number | null] {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(released ?? "");
  if (!m) return [null, null, null];
  const n = (v?: string) => (v && v !== "00" ? Number(v) : null);
  return [Number(m[1]), n(m[2]), n(m[3])];
}
function joinDate(y: number | null, mo: number | null, d: number | null): string | null {
  if (!y) return null;
  if (!mo) return String(y);
  return d ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : `${y}-${String(mo).padStart(2, "0")}`;
}

/** Current release as a payload, for prefilling correction forms and computing diffs. */
export function releaseAsPayload(db: DB, releaseId: number): ReleasePayload {
  const e = db.prepare("SELECT e.*, l.name AS label_name FROM releases e LEFT JOIN labels l ON l.id = e.label_id WHERE e.id = ?").get(releaseId) as any;
  if (!e) throw notFound("Release");
  const tracks = db.prepare("SELECT position, title, artist_credit, duration_seconds FROM release_tracks WHERE release_id = ? AND track_type = 'track' ORDER BY sequence, id").all(releaseId) as TrackLine[];
  const ids = (db.prepare("SELECT identifier_type AS type, value, description FROM release_identifiers WHERE release_id = ? ORDER BY identifier_type, id").all(releaseId) as IdentifierLine[]);
  const links = db.prepare("SELECT track_position, external_id FROM release_media_links WHERE release_id = ? ORDER BY id").all(releaseId) as any[];
  const [y, mo, d] = splitDate(e.released_date);
  return {
    label_name: e.label_name ?? null,
    catalog_number: e.catalog_number,
    format: e.format,
    format_details: e.format_details,
    country: e.country,
    release_year: e.year ?? y,
    release_month: mo,
    release_day: d,
    date_note: e.date_note,
    edition_notes: e.notes,
    tracks: serializeTracks(tracks),
    identifiers: serializeIdentifiers(ids),
    listening_links: serializeMediaLinks(links),
  };
}
/** @deprecated old name */
export const editionAsPayload = releaseAsPayload;

export const PAYLOAD_FIELD_LABELS: Record<keyof ReleasePayload, string> = {
  label_name: "Label",
  catalog_number: "Catalog number",
  format: "Format",
  format_details: "Format details",
  country: "Country",
  release_year: "Year",
  release_month: "Month",
  release_day: "Day",
  date_note: "Date note",
  edition_notes: "Notes",
  tracks: "Track listing",
  identifiers: "Identifiers",
  listening_links: "Listening links (YouTube)",
};

export interface FieldChange { field: keyof ReleasePayload; before: string | number | null; after: string | number | null }

export function diffPayload(before: ReleasePayload | null, after: ReleasePayload): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const k of Object.keys(PAYLOAD_FIELD_LABELS) as (keyof ReleasePayload)[]) {
    const b = before ? (before[k] ?? null) : null;
    const a = after[k] ?? null;
    if ((b ?? "") !== (a ?? "")) changes.push({ field: k, before: b, after: a });
  }
  return changes;
}

// ───────────────────────── Submitting ─────────────────────────
export type SubmitResult = { ok: true; proposalId: number } | { ok: false; duplicates: DuplicateCandidate[] };

export function submitProposal(
  db: DB,
  clock: Clock,
  user: CurrentUser | null,
  input: { kind: "new_edition" | "correction"; master_id: number; target_release_id: number | null; body: Record<string, unknown>; imagePaths: { path: string; caption: string | null }[] },
): SubmitResult {
  const u = requireRole(user, "contributor");
  const errors: Record<string, string> = {};
  let payload: ReleasePayload | null = null;
  let source: z.infer<typeof sourceSchema> | null = null;
  try { payload = parse(releasePayloadSchema, input.body); } catch (e) { if (e instanceof ValidationError) Object.assign(errors, e.fields); else throw e; }
  try { source = parse(sourceSchema, input.body); } catch (e) { if (e instanceof ValidationError) Object.assign(errors, e.fields); else throw e; }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  if (!db.prepare("SELECT 1 FROM masters WHERE id = ?").get(input.master_id)) throw notFound("Master");
  if (input.kind === "correction") {
    const t = db.prepare("SELECT master_id FROM releases WHERE id = ?").get(input.target_release_id ?? 0) as { master_id: number | null } | undefined;
    if (!t || t.master_id !== input.master_id) throw notFound("Release");
    if (!diffPayload(releaseAsPayload(db, input.target_release_id!), payload!).length) {
      throw new ValidationError({ _form: "This correction doesn't change anything yet." }, "This correction doesn't change anything yet.");
    }
  }
  const labelId = payload!.label_name ? ((db.prepare("SELECT id FROM labels WHERE name = ? COLLATE NOCASE").get(payload!.label_name) as { id: number } | undefined)?.id ?? null) : null;
  const duplicates = input.kind === "new_edition"
    ? findDuplicateCandidates(db, { master_id: input.master_id, label_id: labelId, catalog_number: payload!.catalog_number, format: payload!.format, country: payload!.country, year: payload!.release_year })
    : [];
  if (duplicates.length && input.body.confirm_not_duplicate !== "yes") return { ok: false, duplicates };

  const now = iso(clock.now());
  const id = db.transaction(() => {
    const pid = Number(
      db.prepare(
        `INSERT INTO proposals (kind, master_id, target_release_id, payload, source_notes, duplicate_ack, status, proposed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(input.kind, input.master_id, input.target_release_id, JSON.stringify({ edition: payload, source }), source!.source_notes,
        duplicates.length ? JSON.stringify(duplicates.map((d) => d.release.id)) : null, u.id, now).lastInsertRowid,
    );
    for (const img of input.imagePaths) db.prepare("INSERT INTO proposal_images (proposal_id, storage_path, caption, created_at) VALUES (?, ?, ?, ?)").run(pid, img.path, img.caption, now);
    return pid;
  })();
  return { ok: true, proposalId: id };
}

// ───────────────────────── Reviewing ─────────────────────────
export function getProposal(db: DB, user: CurrentUser | null, id: number) {
  const u = requireRole(user, "contributor");
  const p = db.prepare(
    `SELECT p.*, pu.display_name AS proposed_by_name, ru.display_name AS reviewed_by_name, m.title AS release_title
     FROM proposals p JOIN users pu ON pu.id = p.proposed_by LEFT JOIN users ru ON ru.id = p.reviewed_by JOIN masters m ON m.id = p.master_id
     WHERE p.id = ?`,
  ).get(id) as any;
  if (!p) throw notFound("Proposal");
  // Contributors see their own proposals; moderators see all.
  if (!u.roles.includes("moderator") && p.proposed_by !== u.id) throw notFound("Proposal");
  const data = JSON.parse(p.payload) as { edition: ReleasePayload; source: z.infer<typeof sourceSchema> };
  p.edition = data.edition;
  p.source = data.source;
  const current = p.kind === "correction" && p.status === "pending" ? releaseAsPayload(db, p.target_release_id) : null;
  p.changes = p.kind === "correction" && current ? diffPayload(current, data.edition) : diffPayload(null, data.edition);
  p.images = db.prepare("SELECT * FROM proposal_images WHERE proposal_id = ? ORDER BY id").all(id);
  p.duplicate_ids = p.duplicate_ack ? JSON.parse(p.duplicate_ack) : [];
  return p;
}

export function listProposals(db: DB, user: CurrentUser | null, status: string) {
  const u = requireRole(user, "contributor");
  const mine = !u.roles.includes("moderator");
  return db.prepare(
    `SELECT p.id, p.kind, p.status, p.created_at, p.reviewed_at, p.target_release_id, p.resulting_release_id, m.title AS release_title,
       pu.display_name AS proposed_by_name, p.proposed_by
     FROM proposals p JOIN masters m ON m.id = p.master_id JOIN users pu ON pu.id = p.proposed_by
     WHERE (? = '' OR p.status = ?) ${mine ? "AND p.proposed_by = ?" : ""} ORDER BY p.status = 'pending' DESC, p.id DESC`,
  ).all(status, status, ...(mine ? [u.id] : [])) as any[];
}

function labelIdFor(db: DB, name: string | null, now: string): number | null {
  if (!name) return null;
  const found = db.prepare("SELECT id FROM labels WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1").get(name) as { id: number } | undefined;
  if (found) return found.id;
  return Number(db.prepare("INSERT INTO labels (name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(name, normalizeName(name), now, now).lastInsertRowid);
}

/** Writes child rows only for parts that actually changed, so imported structure (index tracks, credits) survives unrelated corrections. */
function writeChildren(db: DB, releaseId: number, before: ReleasePayload | null, payload: ReleasePayload, proposerId: number, now: string) {
  if (!before || before.tracks !== payload.tracks) {
    db.prepare("DELETE FROM release_tracks WHERE release_id = ?").run(releaseId);
    parseTrackLines(payload.tracks).forEach((t, i) =>
      db.prepare("INSERT INTO release_tracks (release_id, position, title, duration, duration_seconds, artist_credit, sequence, track_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'track')")
        .run(releaseId, t.position, t.title, t.duration_seconds == null ? null : formatDuration(t.duration_seconds), t.duration_seconds, t.artist_credit, i));
  }
  if (!before || before.identifiers !== payload.identifiers) {
    db.prepare("DELETE FROM release_identifiers WHERE release_id = ?").run(releaseId);
    for (const i of parseIdentifierLines(payload.identifiers)) {
      db.prepare("INSERT INTO release_identifiers (release_id, identifier_type, value, description, normalized_value) VALUES (?, ?, ?, ?, ?)").run(releaseId, i.type, i.value, i.description, normalizeCode(i.value));
    }
  }
  if (!before || before.listening_links !== payload.listening_links) {
    db.prepare("DELETE FROM release_media_links WHERE release_id = ? AND (source_id IS NULL OR source_id = (SELECT id FROM catalog_sources WHERE name = 'user'))").run(releaseId);
    for (const l of parseMediaLinkLines(payload.listening_links)) {
      db.prepare("INSERT INTO release_media_links (release_id, provider, external_id, track_position, added_by, created_at, source_id) VALUES (?, 'youtube', ?, ?, ?, ?, (SELECT id FROM catalog_sources WHERE name = 'user'))")
        .run(releaseId, l.external_id, l.track_position, proposerId, now);
    }
  }
  if (!before || before.format !== payload.format || before.format_details !== payload.format_details) {
    db.prepare("DELETE FROM release_formats WHERE release_id = ?").run(releaseId);
    const fid = Number(db.prepare("INSERT INTO release_formats (release_id, name, quantity, position) VALUES (?, ?, 1, 0)").run(releaseId, payload.format).lastInsertRowid);
    String(payload.format_details ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      .forEach((d, i) => db.prepare("INSERT INTO release_format_descriptions (format_id, description, position) VALUES (?, ?, ?)").run(fid, d, i));
  }
}

function writePrimaryLabel(db: DB, releaseId: number, labelId: number | null, name: string | null, catno: string | null) {
  const primary = db.prepare("SELECT id FROM release_labels WHERE release_id = ? ORDER BY position, id LIMIT 1").get(releaseId) as { id: number } | undefined;
  if (!name && !catno) {
    if (primary) db.prepare("DELETE FROM release_labels WHERE id = ?").run(primary.id);
    return;
  }
  if (primary) db.prepare("UPDATE release_labels SET label_id = ?, name = ?, catalog_number = ?, catalog_number_norm = ? WHERE id = ?").run(labelId, name ?? "Not On Label", catno, normalizeCode(catno), primary.id);
  else db.prepare("INSERT INTO release_labels (release_id, label_id, name, catalog_number, catalog_number_norm, position) VALUES (?, ?, ?, ?, ?, 0)").run(releaseId, labelId, name ?? "Not On Label", catno, normalizeCode(catno));
}

/**
 * Applies a pending proposal. Only catalog tables are written: copies, listings and orders are
 * never touched, so private notes, listing conditions and order snapshots are unaffected.
 */
export function acceptProposal(db: DB, clock: Clock, user: CurrentUser | null, id: number, reviewNote: string | null): number {
  const mod = requireRole(user, "moderator");
  return db.transaction(() => {
    const p = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as any;
    if (!p) throw notFound("Proposal");
    if (p.proposed_by === mod.id) throw forbidden("Moderators can't accept their own proposals. Another moderator must review it.");
    const now = iso(clock.now());
    const claimed = db.prepare("UPDATE proposals SET status = 'accepted', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'").run(mod.id, now, reviewNote, id);
    if (claimed.changes !== 1) throw new DomainError("This proposal has already been reviewed.");
    const { edition: stored, source } = JSON.parse(p.payload) as { edition: ReleasePayload; source: z.infer<typeof sourceSchema> };
    const payload = { ...stored, listening_links: stored.listening_links ?? "" };
    const labelId = labelIdFor(db, payload.label_name, now);
    const released = joinDate(payload.release_year, payload.release_month, payload.release_day);
    let releaseId: number;
    let changes: FieldChange[];
    let before: ReleasePayload | null = null;
    if (p.kind === "new_edition") {
      changes = diffPayload(null, payload);
      const master = db.prepare("SELECT title, normalized_title FROM masters WHERE id = ?").get(p.master_id) as any;
      releaseId = Number(
        db.prepare(
          `INSERT INTO releases (master_id, title, normalized_title, year, released_date, country, notes, label_id, catalog_number, catalog_number_norm, format,
             format_details, date_note, verification_status, local_edited_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?)`,
        ).run(p.master_id, master.title, master.normalized_title, payload.release_year, released, payload.country, payload.edition_notes, labelId, payload.catalog_number,
          normalizeCode(payload.catalog_number), payload.format, payload.format_details, payload.date_note, now, p.proposed_by, now, now).lastInsertRowid,
      );
      db.prepare("INSERT INTO release_artists (release_id, artist_id, discogs_artist_id, name, anv, join_text, role, position) SELECT ?, artist_id, discogs_artist_id, name, anv, join_text, role, position FROM master_artists WHERE master_id = ?").run(releaseId, p.master_id);
      db.prepare("INSERT INTO release_genres (release_id, genre) SELECT ?, genre FROM master_genres WHERE master_id = ?").run(releaseId, p.master_id);
      db.prepare("INSERT INTO release_styles (release_id, style) SELECT ?, style FROM master_styles WHERE master_id = ?").run(releaseId, p.master_id);
    } else {
      releaseId = p.target_release_id;
      before = releaseAsPayload(db, releaseId);
      changes = diffPayload(before, payload);
      db.prepare(
        `UPDATE releases SET label_id = ?, catalog_number = ?, catalog_number_norm = ?, format = ?, format_details = ?, country = ?, year = ?, released_date = ?,
           date_note = ?, notes = ?, local_edited_at = ?, updated_at = ? WHERE id = ?`,
      ).run(labelId, payload.catalog_number, normalizeCode(payload.catalog_number), payload.format, payload.format_details, payload.country,
        payload.release_year, released, payload.date_note, payload.edition_notes, now, now, releaseId);
    }
    writePrimaryLabel(db, releaseId, labelId, payload.label_name, payload.catalog_number);
    writeChildren(db, releaseId, before, payload, p.proposed_by, now);
    db.prepare("INSERT INTO archival_sources (release_id, kind, citation, url, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(releaseId, source.source_kind, source.source_citation, source.source_url, p.proposed_by, now);
    const proposer = db.prepare("SELECT display_name FROM users WHERE id = ?").get(p.proposed_by) as { display_name: string };
    for (const img of db.prepare("SELECT * FROM proposal_images WHERE proposal_id = ?").all(id) as any[]) {
      db.prepare("INSERT INTO archive_images (release_id, kind, storage_path, caption, attribution, created_at) VALUES (?, 'other', ?, ?, ?, ?)").run(
        releaseId, img.storage_path, img.caption, `Contributed by ${proposer.display_name}; accepted by ${mod.display_name} (proposal #${id})`, now);
    }
    // A moderator has now reviewed the entry against at least one cited source.
    db.prepare("UPDATE releases SET verification_status = CASE WHEN verification_status = 'disputed' THEN 'disputed' ELSE 'reviewed' END WHERE id = ?").run(releaseId);
    db.prepare("UPDATE proposals SET resulting_release_id = ? WHERE id = ?").run(releaseId, id);
    db.prepare("INSERT INTO release_revisions (release_id, proposal_id, summary, changes, proposed_by, accepted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      releaseId, id, p.kind === "new_edition" ? "Release created" : `Correction: ${changes.map((c) => PAYLOAD_FIELD_LABELS[c.field]).join(", ")}`,
      JSON.stringify(changes), p.proposed_by, mod.id, now);
    searchBackend(db).upsert(releaseDocuments(db, [releaseId]));
    return releaseId;
  })();
}

export function rejectProposal(db: DB, clock: Clock, user: CurrentUser | null, id: number, reviewNote: string | null) {
  const mod = requireRole(user, "moderator");
  const note = parse(z.string().trim().min(5, "Explain the rejection so the contributor can improve it (5+ characters)."), reviewNote ?? "");
  const p = db.prepare("SELECT proposed_by FROM proposals WHERE id = ?").get(id) as { proposed_by: number } | undefined;
  if (!p) throw notFound("Proposal");
  if (p.proposed_by === mod.id) throw forbidden("Moderators can't review their own proposals.");
  const r = db.prepare("UPDATE proposals SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'").run(mod.id, iso(clock.now()), note, id);
  if (r.changes !== 1) throw new DomainError("This proposal has already been reviewed.");
}
