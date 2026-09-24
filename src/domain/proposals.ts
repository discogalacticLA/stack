import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, forbidden, notFound } from "../lib/errors.js";
import { requireRole, type CurrentUser } from "../lib/auth.js";
import { COUNTRY_CODES, FORMATS, IDENTIFIER_KINDS, SOURCE_KINDS } from "../lib/reference.js";
import { optionalInt, optionalText, parse, requiredText, ValidationError } from "../lib/validation.js";
import { parseMediaLinkLines, serializeMediaLinks } from "../lib/mediaLinks.js";
import { findDuplicateCandidates, formatDuration, normalizeCatno, type DuplicateCandidate } from "./catalog.js";

/** Edition fields a contribution can set. Tracks and identifiers are one-per-line text. */
export const editionPayloadSchema = z.object({
  label_name: optionalText(120),
  catalog_number: optionalText(60),
  format: z.string().refine((v) => (FORMATS as readonly string[]).includes(v), "Choose a format."),
  format_details: optionalText(120),
  country: z
    .string()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v == null || COUNTRY_CODES.includes(v), "Choose a country or “Unknown”."),
  release_year: optionalInt("Year", 1900, 2100),
  release_month: optionalInt("Month", 1, 12),
  release_day: optionalInt("Day", 1, 31),
  date_note: optionalText(300),
  edition_notes: optionalText(2000),
  tracks: z.string().optional().transform((v, ctx) => {
    try {
      return serializeTracks(parseTrackLines(v ?? ""));
    } catch (e: any) {
      ctx.addIssue({ code: "custom", message: e.message });
      return z.NEVER;
    }
  }),
  identifiers: z.string().optional().transform((v, ctx) => {
    try {
      return serializeIdentifiers(parseIdentifierLines(v ?? ""));
    } catch (e: any) {
      ctx.addIssue({ code: "custom", message: e.message });
      return z.NEVER;
    }
  }),
  listening_links: z.string().optional().transform((v, ctx) => {
    try {
      return serializeMediaLinks(parseMediaLinkLines(v ?? ""));
    } catch (e: any) {
      ctx.addIssue({ code: "custom", message: e.message });
      return z.NEVER;
    }
  }),
});
export type EditionPayload = z.infer<typeof editionPayloadSchema>;

export const sourceSchema = z.object({
  source_notes: requiredText("Source notes", 2000).refine((v) => v.length >= 10, "Explain where this information comes from (10+ characters)."),
  source_kind: z.string().refine((v) => v in SOURCE_KINDS, "Choose a source type."),
  source_citation: requiredText("Source citation", 300),
  source_url: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v == null || /^https?:\/\/\S+$/.test(v), "Use a full http(s) URL, or leave blank."),
});

// ───────── Text formats (kept human-editable on purpose) ─────────
export interface TrackLine { position: string; title: string; artist_credit: string | null; duration_seconds: number | null }

/** "A1 | Title | 6:12" or "A1 | Artist – Title | 6:12" (artist optional via " // "). */
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
  return tracks
    .map((t) => [t.position, t.title + (t.artist_credit ? ` // ${t.artist_credit}` : ""), formatDuration(t.duration_seconds)].filter((x, i) => i < 2 || x).join(" | "))
    .join("\n");
}

export interface IdentifierLine { kind: string; value: string; note: string | null }

/** "barcode: 5 012345 678900" or "matrix_runout: LLR-004 A — etched note". */
export function parseIdentifierLines(text: string): IdentifierLine[] {
  const out: IdentifierLine[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const m = /^([a-z_]+)\s*:\s*(.+)$/.exec(line.trim());
    if (!m || !(m[1] in IDENTIFIER_KINDS)) {
      throw new Error(`Identifier line ${i + 1}: start with one of ${Object.keys(IDENTIFIER_KINDS).join(", ")} followed by a colon.`);
    }
    const [value, note] = m[2].split(" — ").map((s) => s.trim());
    out.push({ kind: m[1], value: value.slice(0, 200), note: note ? note.slice(0, 200) : null });
  });
  return out;
}
export function serializeIdentifiers(ids: IdentifierLine[]): string {
  return ids.map((i) => `${i.kind}: ${i.value}${i.note ? ` — ${i.note}` : ""}`).join("\n");
}

/** Current edition as a payload, for prefilling correction forms and computing diffs. */
export function editionAsPayload(db: DB, editionId: number): EditionPayload {
  const e = db.prepare("SELECT e.*, l.name AS label_name FROM editions e LEFT JOIN labels l ON l.id = e.label_id WHERE e.id = ?").get(editionId) as any;
  if (!e) throw notFound("Edition");
  const tracks = db.prepare("SELECT position, title, artist_credit, duration_seconds FROM tracks WHERE edition_id = ? ORDER BY sort_order").all(editionId) as TrackLine[];
  const ids = db.prepare("SELECT kind, value, note FROM edition_identifiers WHERE edition_id = ? ORDER BY kind, id").all(editionId) as IdentifierLine[];
  const links = db.prepare("SELECT track_position, external_id FROM edition_media_links WHERE edition_id = ? ORDER BY id").all(editionId) as any[];
  return {
    label_name: e.label_name ?? null,
    catalog_number: e.catalog_number,
    format: e.format,
    format_details: e.format_details,
    country: e.country,
    release_year: e.release_year,
    release_month: e.release_month,
    release_day: e.release_day,
    date_note: e.date_note,
    edition_notes: e.edition_notes,
    tracks: serializeTracks(tracks),
    identifiers: serializeIdentifiers(ids),
    listening_links: serializeMediaLinks(links),
  };
}

export const PAYLOAD_FIELD_LABELS: Record<keyof EditionPayload, string> = {
  label_name: "Label",
  catalog_number: "Catalog number",
  format: "Format",
  format_details: "Format details",
  country: "Country",
  release_year: "Year",
  release_month: "Month",
  release_day: "Day",
  date_note: "Date note",
  edition_notes: "Edition notes",
  tracks: "Track listing",
  identifiers: "Identifiers",
  listening_links: "Listening links (YouTube)",
};

export interface FieldChange { field: keyof EditionPayload; before: string | number | null; after: string | number | null }

export function diffPayload(before: EditionPayload | null, after: EditionPayload): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const k of Object.keys(PAYLOAD_FIELD_LABELS) as (keyof EditionPayload)[]) {
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
  input: { kind: "new_edition" | "correction"; release_id: number; target_edition_id: number | null; body: Record<string, unknown>; imagePaths: { path: string; caption: string | null }[] },
): SubmitResult {
  const u = requireRole(user, "contributor");
  const errors: Record<string, string> = {};
  let payload: EditionPayload | null = null;
  let source: z.infer<typeof sourceSchema> | null = null;
  try { payload = parse(editionPayloadSchema, input.body); } catch (e) { if (e instanceof ValidationError) Object.assign(errors, e.fields); else throw e; }
  try { source = parse(sourceSchema, input.body); } catch (e) { if (e instanceof ValidationError) Object.assign(errors, e.fields); else throw e; }
  if (Object.keys(errors).length) throw new ValidationError(errors);

  if (!db.prepare("SELECT 1 FROM releases WHERE id = ?").get(input.release_id)) throw notFound("Release");
  if (input.kind === "correction") {
    const t = db.prepare("SELECT release_id FROM editions WHERE id = ?").get(input.target_edition_id ?? 0) as { release_id: number } | undefined;
    if (!t || t.release_id !== input.release_id) throw notFound("Edition");
    const changes = diffPayload(editionAsPayload(db, input.target_edition_id!), payload!);
    if (!changes.length) throw new ValidationError({ _form: "This correction doesn't change anything yet." }, "This correction doesn't change anything yet.");
  }

  const labelId = payload!.label_name
    ? ((db.prepare("SELECT id FROM labels WHERE name = ? COLLATE NOCASE").get(payload!.label_name) as { id: number } | undefined)?.id ?? null)
    : null;
  const duplicates =
    input.kind === "new_edition"
      ? findDuplicateCandidates(db, {
          release_id: input.release_id,
          label_id: labelId,
          catalog_number: payload!.catalog_number,
          format: payload!.format,
          country: payload!.country,
          release_year: payload!.release_year,
        })
      : [];
  const acknowledged = input.body.confirm_not_duplicate === "yes";
  if (duplicates.length && !acknowledged) return { ok: false, duplicates };

  const now = iso(clock.now());
  const id = db.transaction(() => {
    const pid = Number(
      db
        .prepare(
          `INSERT INTO proposals (kind, release_id, target_edition_id, payload, source_notes, duplicate_ack, status, proposed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(input.kind, input.release_id, input.target_edition_id, JSON.stringify({ edition: payload, source }), source!.source_notes,
          duplicates.length ? JSON.stringify(duplicates.map((d) => d.edition.id)) : null, u.id, now).lastInsertRowid,
    );
    for (const img of input.imagePaths) {
      db.prepare("INSERT INTO proposal_images (proposal_id, storage_path, caption, created_at) VALUES (?, ?, ?, ?)").run(pid, img.path, img.caption, now);
    }
    return pid;
  })();
  return { ok: true, proposalId: id };
}

// ───────────────────────── Reviewing ─────────────────────────
export function getProposal(db: DB, user: CurrentUser | null, id: number) {
  const u = requireRole(user, "contributor");
  const p = db
    .prepare(
      `SELECT p.*, pu.display_name AS proposed_by_name, ru.display_name AS reviewed_by_name, r.title AS release_title
       FROM proposals p JOIN users pu ON pu.id = p.proposed_by LEFT JOIN users ru ON ru.id = p.reviewed_by JOIN releases r ON r.id = p.release_id
       WHERE p.id = ?`,
    )
    .get(id) as any;
  if (!p) throw notFound("Proposal");
  // Contributors see their own proposals; moderators see all.
  if (!u.roles.includes("moderator") && p.proposed_by !== u.id) throw notFound("Proposal");
  const data = JSON.parse(p.payload) as { edition: EditionPayload; source: z.infer<typeof sourceSchema> };
  p.edition = data.edition;
  p.source = data.source;
  const current = p.kind === "correction" && p.status === "pending" ? editionAsPayload(db, p.target_edition_id) : null;
  p.changes = p.kind === "correction" && current ? diffPayload(current, data.edition) : diffPayload(null, data.edition);
  p.images = db.prepare("SELECT * FROM proposal_images WHERE proposal_id = ? ORDER BY id").all(id);
  p.duplicate_ids = p.duplicate_ack ? JSON.parse(p.duplicate_ack) : [];
  return p;
}

export function listProposals(db: DB, user: CurrentUser | null, status: string) {
  const u = requireRole(user, "contributor");
  const mine = !u.roles.includes("moderator");
  return db
    .prepare(
      `SELECT p.id, p.kind, p.status, p.created_at, p.reviewed_at, p.target_edition_id, p.resulting_edition_id, r.title AS release_title,
         pu.display_name AS proposed_by_name, p.proposed_by
       FROM proposals p JOIN releases r ON r.id = p.release_id JOIN users pu ON pu.id = p.proposed_by
       WHERE (? = '' OR p.status = ?) ${mine ? "AND p.proposed_by = ?" : ""} ORDER BY p.status = 'pending' DESC, p.id DESC`,
    )
    .all(status, status, ...(mine ? [u.id] : [])) as any[];
}

function labelIdFor(db: DB, name: string | null, now: string): number | null {
  if (!name) return null;
  const found = db.prepare("SELECT id FROM labels WHERE name = ? COLLATE NOCASE").get(name) as { id: number } | undefined;
  if (found) return found.id;
  return Number(db.prepare("INSERT INTO labels (name, created_at) VALUES (?, ?)").run(name, now).lastInsertRowid);
}

function writeTracksAndIdentifiers(db: DB, editionId: number, payload: EditionPayload, proposerId: number, now: string) {
  db.prepare("DELETE FROM tracks WHERE edition_id = ?").run(editionId);
  parseTrackLines(payload.tracks).forEach((t, i) =>
    db.prepare("INSERT INTO tracks (edition_id, position, title, artist_credit, duration_seconds, sort_order) VALUES (?, ?, ?, ?, ?, ?)")
      .run(editionId, t.position, t.title, t.artist_credit, t.duration_seconds, i));
  db.prepare("DELETE FROM edition_identifiers WHERE edition_id = ?").run(editionId);
  for (const i of parseIdentifierLines(payload.identifiers)) {
    db.prepare("INSERT INTO edition_identifiers (edition_id, kind, value, note) VALUES (?, ?, ?, ?)").run(editionId, i.kind, i.value, i.note);
  }
  const current = db.prepare("SELECT track_position, external_id FROM edition_media_links WHERE edition_id = ? ORDER BY id").all(editionId) as any[];
  if (serializeMediaLinks(current) !== payload.listening_links) {
    db.prepare("DELETE FROM edition_media_links WHERE edition_id = ?").run(editionId);
    for (const l of parseMediaLinkLines(payload.listening_links)) {
      db.prepare("INSERT INTO edition_media_links (edition_id, provider, external_id, track_position, added_by, created_at) VALUES (?, 'youtube', ?, ?, ?, ?)")
        .run(editionId, l.external_id, l.track_position, proposerId, now);
    }
  }
}

/**
 * Applies a pending proposal. Only archive tables are written: copies, listings and orders
 * are never touched, so private notes, listing conditions and order snapshots are unaffected.
 */
export function acceptProposal(db: DB, clock: Clock, user: CurrentUser | null, id: number, reviewNote: string | null): number {
  const mod = requireRole(user, "moderator");
  return db.transaction(() => {
    const p = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as any;
    if (!p) throw notFound("Proposal");
    if (p.proposed_by === mod.id) throw forbidden("Moderators can't accept their own proposals. Another moderator must review it.");
    const now = iso(clock.now());
    const claimed = db
      .prepare("UPDATE proposals SET status = 'accepted', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'")
      .run(mod.id, now, reviewNote, id);
    if (claimed.changes !== 1) throw new DomainError("This proposal has already been reviewed.");
    const { edition: payload, source } = JSON.parse(p.payload) as { edition: EditionPayload; source: z.infer<typeof sourceSchema> };
    const labelId = labelIdFor(db, payload.label_name, now);
    let editionId: number;
    let changes: FieldChange[];
    if (p.kind === "new_edition") {
      changes = diffPayload(null, payload);
      editionId = Number(
        db
          .prepare(
            `INSERT INTO editions (release_id, label_id, catalog_number, catalog_number_norm, format, format_details, country, release_year,
               release_month, release_day, date_note, edition_notes, verification_status, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?)`,
          )
          .run(p.release_id, labelId, payload.catalog_number, normalizeCatno(payload.catalog_number), payload.format, payload.format_details,
            payload.country, payload.release_year, payload.release_month, payload.release_day, payload.date_note, payload.edition_notes,
            p.proposed_by, now, now).lastInsertRowid,
      );
    } else {
      editionId = p.target_edition_id;
      changes = diffPayload(editionAsPayload(db, editionId), payload);
      db.prepare(
        `UPDATE editions SET label_id = ?, catalog_number = ?, catalog_number_norm = ?, format = ?, format_details = ?, country = ?,
           release_year = ?, release_month = ?, release_day = ?, date_note = ?, edition_notes = ?, updated_at = ? WHERE id = ?`,
      ).run(labelId, payload.catalog_number, normalizeCatno(payload.catalog_number), payload.format, payload.format_details, payload.country,
        payload.release_year, payload.release_month, payload.release_day, payload.date_note, payload.edition_notes, now, editionId);
    }
    writeTracksAndIdentifiers(db, editionId, { ...payload, listening_links: payload.listening_links ?? "" }, p.proposed_by, now);
    db.prepare("INSERT INTO archival_sources (edition_id, kind, citation, url, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      editionId, source.source_kind, source.source_citation, source.source_url, p.proposed_by, now);
    const proposer = db.prepare("SELECT display_name FROM users WHERE id = ?").get(p.proposed_by) as { display_name: string };
    for (const img of db.prepare("SELECT * FROM proposal_images WHERE proposal_id = ?").all(id) as any[]) {
      db.prepare("INSERT INTO archive_images (edition_id, kind, storage_path, caption, attribution, created_at) VALUES (?, 'other', ?, ?, ?, ?)").run(
        editionId, img.storage_path, img.caption, `Contributed by ${proposer.display_name}; accepted by ${mod.display_name} (proposal #${id})`, now);
    }
    // A moderator has now reviewed the entry against at least one cited source.
    db.prepare("UPDATE editions SET verification_status = CASE WHEN verification_status = 'disputed' THEN 'disputed' ELSE 'reviewed' END WHERE id = ?").run(editionId);
    db.prepare("UPDATE proposals SET resulting_edition_id = ? WHERE id = ?").run(editionId, id);
    db.prepare(
      "INSERT INTO edition_revisions (edition_id, proposal_id, summary, changes, proposed_by, accepted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(editionId, id, p.kind === "new_edition" ? "Edition created" : `Correction: ${changes.map((c) => PAYLOAD_FIELD_LABELS[c.field]).join(", ")}`,
      JSON.stringify(changes), p.proposed_by, mod.id, now);
    return editionId;
  })();
}

export function rejectProposal(db: DB, clock: Clock, user: CurrentUser | null, id: number, reviewNote: string | null) {
  const mod = requireRole(user, "moderator");
  const note = parse(z.string().trim().min(5, "Explain the rejection so the contributor can improve it (5+ characters)."), reviewNote ?? "");
  const p = db.prepare("SELECT proposed_by FROM proposals WHERE id = ?").get(id) as { proposed_by: number } | undefined;
  if (!p) throw notFound("Proposal");
  if (p.proposed_by === mod.id) throw forbidden("Moderators can't review their own proposals.");
  const r = db
    .prepare("UPDATE proposals SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'")
    .run(mod.id, iso(clock.now()), note, id);
  if (r.changes !== 1) throw new DomainError("This proposal has already been reviewed.");
}
