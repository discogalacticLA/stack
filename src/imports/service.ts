/**
 * Import lifecycle: upload → preview (parse + reconcile, nothing written to holdings) →
 * review ambiguous rows → commit (chunked, resumable, idempotent) → report → optional undo.
 *
 * Integrity guarantees (tested in tests/imports-*.test.ts):
 * - Every row is applied inside the same transaction that marks it applied, so a crash or
 *   retry never applies a row twice and never leaves a half-applied row.
 * - Commits are refused if another import of the same source library was committed or
 *   undone after this preview was made (the preview would be stale).
 * - Holdings are never deleted because they are missing from a later export.
 * - User edits (notes, tags, crates, charts, edited fields) are never overwritten by an
 *   update, and undo keeps any created record the user has since edited or organised.
 */
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, notFound } from "../lib/errors.js";
import { discogsCollectionAdapter, discogsWantlistAdapter } from "./adapters/discogs.js";
import { rekordboxAdapter } from "./adapters/rekordbox.js";
import { MAX_IMPORT_BYTES, type ImportAdapter, type ParsedPlaylistNode, type ParsedRow, type SourceKind } from "./adapters/types.js";
import { reconcile, type KnownEntry } from "./reconcile.js";
import { decodeUtf8, ImportFileError, sha256 } from "./text.js";

export const ADAPTERS: Record<SourceKind, ImportAdapter> = {
  discogs_collection: discogsCollectionAdapter,
  discogs_wantlist: discogsWantlistAdapter,
  rekordbox: rekordboxAdapter,
};

export const DEFAULT_SOURCE_NAMES: Record<SourceKind, string> = {
  discogs_collection: "Discogs collection",
  discogs_wantlist: "Discogs wantlist",
  rekordbox: "Rekordbox library",
};

/** Rows committed per transaction. Small enough to keep the server responsive between chunks. */
export const COMMIT_CHUNK_SIZE = 250;
/** Above this many rows, commits run in the background and the page shows progress. */
export const BACKGROUND_THRESHOLD = 1500;

// Fields an import may update on an existing holding (only when the owner hasn't edited it).
const UPDATABLE: Record<string, string[]> = {
  physical: ["artist_text", "title_text", "label_text", "catno_text", "format_raw", "format_group", "release_year", "media_condition", "sleeve_condition", "source_folder"],
  digital: ["artist_text", "title_text", "version_text", "album_text", "label_text", "genre_text", "release_year", "file_format", "bitrate_kbps", "sample_rate_hz",
    "duration_seconds", "file_size_bytes", "bpm_x100", "musical_key", "rating", "play_count", "file_location", "source_comments"],
  want: ["artist_text", "title_text", "label_text", "catno_text", "format_raw", "format_group", "release_year"],
};
const TABLE: Record<string, { table: string; owner: string }> = {
  physical: { table: "copies", owner: "owner_id" },
  digital: { table: "digital_holdings", owner: "owner_id" },
  want: { table: "wants", owner: "user_id" },
};

// ───────────────────────── Source libraries ─────────────────────────
export function getOrCreateSourceLibrary(db: DB, clock: Clock, ownerId: number, kind: SourceKind, name: string): number {
  const n = name.trim().slice(0, 80) || DEFAULT_SOURCE_NAMES[kind];
  db.prepare("INSERT OR IGNORE INTO source_libraries (owner_id, kind, name, created_at) VALUES (?, ?, ?, ?)").run(ownerId, kind, n, iso(clock.now()));
  return (db.prepare("SELECT id FROM source_libraries WHERE owner_id = ? AND kind = ? AND name = ?").get(ownerId, kind, n) as { id: number }).id;
}

export function listSourceLibraries(db: DB, ownerId: number) {
  return db
    .prepare(
      `SELECT sl.*, (SELECT COUNT(*) FROM source_entries se WHERE se.source_library_id = sl.id) AS entries,
         (SELECT MAX(committed_at) FROM import_batches b WHERE b.source_library_id = sl.id AND b.status = 'committed') AS last_import
       FROM source_libraries sl WHERE sl.owner_id = ? ORDER BY sl.kind, sl.name`,
    )
    .all(ownerId) as any[];
}

// ───────────────────────── Preview ─────────────────────────
export interface PreviewInput { kind: SourceKind; sourceName: string; filename: string; buffer: Buffer }

/**
 * Parses and reconciles a file, saving a batch in 'previewed' status. Nothing is written to
 * holdings. Files that can't be read are saved as a 'failed' batch with an explanation.
 */
export function previewImport(db: DB, clock: Clock, ownerId: number, input: PreviewInput): number {
  const adapter = ADAPTERS[input.kind];
  if (!adapter) throw new DomainError("Choose an import type.", 422);
  if (!input.buffer?.length) throw new DomainError("Choose a file to import.", 422);
  if (input.buffer.length > MAX_IMPORT_BYTES) throw new DomainError(`That file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB, the prototype's limit.`, 422);
  const sourceId = getOrCreateSourceLibrary(db, clock, ownerId, input.kind, input.sourceName);
  const fingerprint = sha256(input.buffer);
  const now = iso(clock.now());
  const filename = input.filename.slice(0, 200) || "upload";

  let parsed;
  try {
    parsed = adapter.parse(decodeUtf8(input.buffer));
  } catch (e) {
    if (!(e instanceof ImportFileError)) throw e;
    return Number(
      db.prepare(
        `INSERT INTO import_batches (owner_id, source_library_id, filename, file_fingerprint, file_bytes, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)`,
      ).run(ownerId, sourceId, filename, fingerprint, input.buffer.length, e.message, now).lastInsertRowid,
    );
  }

  const known = (db.prepare("SELECT id, external_id, identity_key, content_hash, hints FROM source_entries WHERE source_library_id = ?").all(sourceId) as any[])
    .map((e) => ({ ...e, hints: JSON.parse(e.hints) })) as KnownEntry[];
  const result = reconcile(input.kind, parsed.rows, known);
  const identical = db
    .prepare("SELECT id FROM import_batches WHERE source_library_id = ? AND file_fingerprint = ? AND status = 'committed' ORDER BY id DESC LIMIT 1")
    .get(sourceId, fingerprint) as { id: number } | undefined;
  const candidateIds = new Set(result.rows.flatMap((r) => r.candidateEntryIds));
  const missing = result.missingEntryIds.filter((id) => !candidateIds.has(id));
  const counts = {
    total: parsed.rows.length,
    new: result.rows.filter((r) => r.classification === "new").length,
    existing: result.rows.filter((r) => r.classification === "existing").length,
    changed: result.rows.filter((r) => r.classification === "changed").length,
    ambiguous: result.rows.filter((r) => r.classification === "ambiguous").length,
    invalid: result.rows.filter((r) => r.classification === "invalid").length,
    warnings: parsed.rows.filter((r) => r.warnings.length).length,
    missing_from_export: missing.length,
    playlists: countPlaylists(parsed.playlists),
  };

  return db.transaction(() => {
    const batchId = Number(
      db.prepare(
        `INSERT INTO import_batches (owner_id, source_library_id, filename, file_fingerprint, file_bytes, status, identical_to_batch_id, counts, notices,
           pending_playlists, rows_total, created_at) VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?)`,
      ).run(ownerId, sourceId, filename, fingerprint, input.buffer.length, identical?.id ?? null, JSON.stringify(counts), JSON.stringify(parsed.notices),
        parsed.playlists.length ? JSON.stringify(parsed.playlists) : null, parsed.rows.length, now).lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT INTO import_rows (batch_id, row_number, external_id, content_hash, parsed, classification, candidate_entry_ids, matched_entry_id, messages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    parsed.rows.forEach((row, i) => {
      const rr = result.rows[i];
      insert.run(batchId, row.rowNumber, row.externalId, row.contentHash, JSON.stringify(row), rr.classification, JSON.stringify(rr.candidateEntryIds),
        rr.matchedEntryId, JSON.stringify([rr.reason, ...row.warnings, ...row.errors.filter((e) => !rr.reason.includes(e))]));
    });
    return batchId;
  })();
}

function countPlaylists(nodes: ParsedPlaylistNode[]): number {
  return nodes.reduce((n, p) => n + (p.type === "playlist" ? 1 : 0) + countPlaylists(p.children), 0);
}

// ───────────────────────── Reading batches ─────────────────────────
export function getBatch(db: DB, ownerId: number, batchId: number) {
  const b = db
    .prepare("SELECT b.*, sl.kind, sl.name AS source_name FROM import_batches b JOIN source_libraries sl ON sl.id = b.source_library_id WHERE b.id = ? AND b.owner_id = ?")
    .get(batchId, ownerId) as any;
  if (!b) throw notFound("Import");
  b.counts = JSON.parse(b.counts);
  b.notices = JSON.parse(b.notices);
  b.report = b.report ? JSON.parse(b.report) : null;
  b.undecided = (db.prepare("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND classification = 'ambiguous' AND decision IS NULL").get(batchId) as { n: number }).n;
  return b;
}

export function listBatches(db: DB, ownerId: number) {
  return (db
    .prepare("SELECT b.*, sl.kind, sl.name AS source_name FROM import_batches b JOIN source_libraries sl ON sl.id = b.source_library_id WHERE b.owner_id = ? ORDER BY b.id DESC")
    .all(ownerId) as any[]).map((b) => ({ ...b, counts: JSON.parse(b.counts) }));
}

export function batchRows(db: DB, ownerId: number, batchId: number, filter: string, page: number, pageSize = 100) {
  getBatch(db, ownerId, batchId);
  const where = filter ? "AND classification = ?" : "";
  const args: unknown[] = filter ? [batchId, filter] : [batchId];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? ${where}`).get(...args) as { n: number }).n;
  const rows = (db.prepare(`SELECT * FROM import_rows WHERE batch_id = ? ${where} ORDER BY row_number LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as any[]).map((r) => ({
    ...r,
    parsed: r.parsed ? (JSON.parse(r.parsed) as ParsedRow) : null,
    candidate_entry_ids: JSON.parse(r.candidate_entry_ids) as number[],
    messages: JSON.parse(r.messages) as string[],
  }));
  return { total, rows };
}

/** Summary of a known entry for showing ambiguous-match candidates (owner-scoped). */
export function entrySummary(db: DB, ownerId: number, entryId: number) {
  const e = db.prepare("SELECT * FROM source_entries WHERE id = ? AND owner_id = ?").get(entryId, ownerId) as any;
  if (!e) return null;
  const data = JSON.parse(e.data);
  const holding = holdingForEntry(db, entryId);
  return { id: e.id, external_id: e.external_id, fields: data.fields ?? {}, source: data.source ?? {}, holding, first_batch_id: e.first_batch_id };
}

function holdingForEntry(db: DB, entryId: number): { type: "physical" | "digital" | "want"; id: number; user_edited_at: string | null } | null {
  for (const type of ["physical", "digital", "want"] as const) {
    const r = db.prepare(`SELECT id, user_edited_at FROM ${TABLE[type].table} WHERE source_entry_id = ?`).get(entryId) as any;
    if (r) return { type, id: r.id, user_edited_at: r.user_edited_at };
  }
  return null;
}

// ───────────────────────── Decisions on ambiguous rows ─────────────────────────
export type Decision = { decision: "create" | "skip" } | { decision: "link"; entryId: number };

export function decideRow(db: DB, ownerId: number, batchId: number, rowId: number, d: Decision) {
  const b = getBatch(db, ownerId, batchId);
  if (b.status !== "previewed") throw new DomainError("Decisions can only be changed before the import is committed.");
  const row = db.prepare("SELECT * FROM import_rows WHERE id = ? AND batch_id = ?").get(rowId, batchId) as any;
  if (!row) throw notFound("Import row");
  if (row.classification !== "ambiguous") throw new DomainError("Only ambiguous rows need a decision.", 422);
  if (d.decision === "link") {
    const candidates = JSON.parse(row.candidate_entry_ids) as number[];
    if (!candidates.includes(d.entryId)) throw new DomainError("Choose one of the suggested matches.", 422);
    const taken = db.prepare("SELECT row_number FROM import_rows WHERE batch_id = ? AND decision = 'link' AND decision_entry_id = ? AND id != ?").get(batchId, d.entryId, rowId) as any;
    if (taken) throw new DomainError(`That existing entry is already matched to row ${taken.row_number}. Each existing entry can match only one row.`, 422);
  }
  db.prepare("UPDATE import_rows SET decision = ?, decision_entry_id = ? WHERE id = ?").run(d.decision, d.decision === "link" ? d.entryId : null, rowId);
}

/** Applies one decision to every still-undecided ambiguous row ("link" picks the first free candidate). */
export function decideAllUndecided(db: DB, ownerId: number, batchId: number, decision: "create" | "skip" | "link"): number {
  const b = getBatch(db, ownerId, batchId);
  if (b.status !== "previewed") throw new DomainError("Decisions can only be changed before the import is committed.");
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND classification = 'ambiguous' AND decision IS NULL ORDER BY row_number").all(batchId) as any[];
    const takenIds = new Set((db.prepare("SELECT decision_entry_id FROM import_rows WHERE batch_id = ? AND decision = 'link'").all(batchId) as any[]).map((r) => r.decision_entry_id));
    let n = 0;
    for (const r of rows) {
      if (decision === "link") {
        const free = (JSON.parse(r.candidate_entry_ids) as number[]).find((id) => !takenIds.has(id));
        if (free == null) continue; // no candidate left: stays undecided
        takenIds.add(free);
        db.prepare("UPDATE import_rows SET decision = 'link', decision_entry_id = ? WHERE id = ?").run(free, r.id);
      } else db.prepare("UPDATE import_rows SET decision = ? WHERE id = ?").run(decision, r.id);
      n++;
    }
    return n;
  })();
}

export function discardPreview(db: DB, ownerId: number, batchId: number) {
  const b = getBatch(db, ownerId, batchId);
  if (b.status !== "previewed") throw new DomainError("Only an uncommitted preview can be discarded.");
  db.transaction(() => {
    db.prepare("DELETE FROM import_rows WHERE batch_id = ?").run(batchId);
    db.prepare("UPDATE import_batches SET status = 'discarded', pending_playlists = NULL WHERE id = ?").run(batchId);
  })();
}

// ───────────────────────── Commit ─────────────────────────
/** Validates and moves a preview (or a failed commit, for retry) into 'committing'. */
export function beginCommit(db: DB, clock: Clock, ownerId: number, batchId: number) {
  db.transaction(() => {
    const b = getBatch(db, ownerId, batchId);
    if (b.status === "committed") throw new DomainError("This import has already been committed.");
    if (!["previewed", "failed"].includes(b.status) || (b.status === "failed" && b.rows_total === 0)) {
      throw new DomainError(b.status === "failed" ? "This file couldn't be read, so there is nothing to commit. Fix the file and upload it again." : `An import that is “${b.status}” can't be committed.`);
    }
    // A preview is stale if the same source library changed after it was made.
    const later = db
      .prepare(
        `SELECT id FROM import_batches WHERE source_library_id = ? AND id != ? AND ((status = 'committed' AND committed_at > ?) OR (status = 'undone' AND undone_at > ?) OR status = 'committing')`,
      )
      .get(b.source_library_id, batchId, b.created_at, b.created_at) as any;
    if (later) throw new DomainError(`Import #${later.id} for the same source changed things after this preview was made. Upload the file again to get a fresh preview.`);
    if (b.undecided) throw new DomainError(`${b.undecided} ambiguous row${b.undecided === 1 ? " needs" : "s need"} a decision before committing.`, 422);
    const r = db.prepare("UPDATE import_batches SET status = 'committing', error = NULL WHERE id = ? AND status IN ('previewed', 'failed')").run(batchId);
    if (r.changes !== 1) throw new DomainError("This import is already being committed.");
  })();
  void clock;
}

export interface CommitOptions {
  chunkSize?: number;
  /** Test hook: throw while applying this row number, to prove retries are safe. */
  failAtRow?: number;
}

/**
 * Applies the next chunk of unapplied rows in ONE transaction. Returns true when finished.
 * On error the chunk rolls back, the batch is marked 'failed' with the reason, and a retry
 * resumes from the first unapplied row.
 */
export function commitNextChunk(db: DB, clock: Clock, batchId: number, opts: CommitOptions = {}): boolean {
  const size = opts.chunkSize ?? COMMIT_CHUNK_SIZE;
  const batch = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batchId) as any;
  if (!batch || batch.status !== "committing") throw new DomainError("This import isn't being committed.");
  try {
    return db.transaction(() => {
      const rows = db.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND applied = 0 ORDER BY row_number LIMIT ?").all(batchId, size) as any[];
      const kind = (db.prepare("SELECT kind FROM source_libraries WHERE id = ?").get(batch.source_library_id) as { kind: SourceKind }).kind;
      for (const row of rows) {
        if (opts.failAtRow === row.row_number) throw new Error(`Simulated failure at row ${row.row_number}`);
        applyRow(db, clock, batch, kind, row);
      }
      db.prepare("UPDATE import_batches SET rows_applied = (SELECT COUNT(*) FROM import_rows WHERE batch_id = ? AND applied = 1) WHERE id = ?").run(batchId, batchId);
      if (rows.length < size) {
        finalizeCommit(db, clock, batch, kind);
        return true;
      }
      return false;
    })();
  } catch (e: any) {
    db.prepare("UPDATE import_batches SET status = 'failed', error = ? WHERE id = ?").run(
      `Stopped at a problem: ${e?.message ?? e}. Rows already saved are kept; retrying continues from where it stopped and won't duplicate anything.`, batchId);
    throw e instanceof DomainError ? e : new DomainError(`Import stopped: ${e?.message ?? e}. You can retry safely.`, 500);
  }
}

/** Synchronous commit (small imports and tests). */
export function commitImport(db: DB, clock: Clock, ownerId: number, batchId: number, opts: CommitOptions = {}) {
  beginCommit(db, clock, ownerId, batchId);
  while (!commitNextChunk(db, clock, batchId, opts)) { /* next chunk */ }
  return getBatch(db, ownerId, batchId);
}

/** Background commit: yields to the event loop between chunks so the app stays responsive. */
export async function commitInBackground(db: DB, clock: Clock, batchId: number, opts: CommitOptions = {}) {
  try {
    for (;;) {
      if (commitNextChunk(db, clock, batchId, opts)) return;
      await new Promise((r) => setImmediate(r));
    }
  } catch (e) {
    if (!(e instanceof DomainError)) console.error(e);
  }
}

/** Resumes commits interrupted by a restart (status stuck at 'committing'). */
export function resumeInterruptedImports(db: DB, clock: Clock) {
  const stuck = db.prepare("SELECT id FROM import_batches WHERE status = 'committing'").all() as { id: number }[];
  for (const b of stuck) void commitInBackground(db, clock, b.id);
  return stuck.length;
}

function holdingSnapshot(db: DB, h: { type: string; id: number }) {
  const cols = UPDATABLE[h.type];
  return db.prepare(`SELECT ${cols.join(", ")}, user_edited_at FROM ${TABLE[h.type].table} WHERE id = ?`).get(h.id) as Record<string, unknown>;
}

function applyRow(db: DB, clock: Clock, batch: any, kind: SourceKind, row: any) {
  const now = iso(clock.now());
  const parsed: ParsedRow | null = row.parsed ? JSON.parse(row.parsed) : null;
  const action =
    row.classification === "invalid" || row.decision === "skip" ? "skip"
    : row.classification === "existing" ? "seen"
    : row.classification === "changed" || row.decision === "link" ? "update"
    : "create"; // 'new', or ambiguous resolved as 'create'
  let resultEntry: number | null = null;
  let previous: unknown = null;

  if (action === "seen") {
    const e = db.prepare("SELECT last_seen_batch_id FROM source_entries WHERE id = ?").get(row.matched_entry_id) as any;
    previous = { entry: { last_seen_batch_id: e.last_seen_batch_id } };
    db.prepare("UPDATE source_entries SET last_seen_batch_id = ? WHERE id = ?").run(batch.id, row.matched_entry_id);
    resultEntry = row.matched_entry_id;
  } else if (action === "update" && parsed) {
    const entryId = row.decision === "link" ? row.decision_entry_id : row.matched_entry_id;
    const e = db.prepare("SELECT * FROM source_entries WHERE id = ?").get(entryId) as any;
    const holding = holdingForEntry(db, entryId);
    previous = { entry: { data: e.data, content_hash: e.content_hash, last_seen_batch_id: e.last_seen_batch_id, external_id: e.external_id, identity_key: e.identity_key, hints: e.hints },
      holding: holding ? { ...holding, fields: holdingSnapshot(db, holding) } : null };
    db.prepare("UPDATE source_entries SET data = ?, content_hash = ?, external_id = ?, identity_key = ?, hints = ?, last_seen_batch_id = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ fields: parsed.fields, source: parsed.source, warnings: parsed.warnings }), parsed.contentHash, parsed.externalId, parsed.identityKey,
      JSON.stringify(parsed.fingerprintHints ?? []), batch.id, now, entryId);
    if (holding && !holding.user_edited_at) {
      const cols = UPDATABLE[holding.type].filter((c) => c in parsed.fields);
      if (cols.length) {
        db.prepare(`UPDATE ${TABLE[holding.type].table} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
          ...cols.map((c) => parsed.fields[c] ?? null), now, holding.id);
      }
    } else if (holding) {
      (previous as any).kept_user_edits = true;
    }
    resultEntry = entryId;
  } else if (action === "create" && parsed) {
    resultEntry = Number(
      db.prepare(
        `INSERT INTO source_entries (owner_id, source_library_id, external_id, identity_key, hints, content_hash, data, first_batch_id, last_seen_batch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(batch.owner_id, batch.source_library_id, parsed.externalId, parsed.identityKey, JSON.stringify(parsed.fingerprintHints ?? []), parsed.contentHash,
        JSON.stringify({ fields: parsed.fields, source: parsed.source, warnings: parsed.warnings }), batch.id, batch.id, now, now).lastInsertRowid,
    );
    createHolding(db, batch, parsed, resultEntry, now, kind);
  }
  db.prepare("UPDATE import_rows SET applied = 1, result_entry_id = ?, previous_state = ? WHERE id = ?").run(resultEntry, previous ? JSON.stringify(previous) : null, row.id);
}

function createHolding(db: DB, batch: any, parsed: ParsedRow, entryId: number, now: string, kind: SourceKind) {
  const f = parsed.fields as Record<string, any>;
  const common = { created_by_batch_id: batch.id, source_entry_id: entryId, created_at: now, updated_at: now, date_added: f.date_added ?? now };
  let table: string;
  let cols: Record<string, unknown>;
  if (parsed.target === "physical") {
    table = "copies";
    cols = { owner_id: batch.owner_id, artist_text: f.artist_text, title_text: f.title_text, label_text: f.label_text, catno_text: f.catno_text,
      format_raw: f.format_raw, format_group: f.format_group, release_year: f.release_year, source_folder: f.source_folder,
      media_condition: f.media_condition ?? "NG", sleeve_condition: f.sleeve_condition ?? "NG", ...common };
  } else if (parsed.target === "digital") {
    table = "digital_holdings";
    const fromDiscogs = kind === "discogs_collection";
    cols = { owner_id: batch.owner_id, granularity: fromDiscogs ? "release" : f.granularity ?? "track", holding_kind: "unspecified",
      artist_text: f.artist_text, title_text: f.title_text, version_text: f.version_text ?? null, album_text: f.album_text ?? null,
      label_text: f.label_text ?? null, catno_text: f.catno_text ?? null, genre_text: f.genre_text ?? null, release_year: f.release_year ?? null,
      file_format: fromDiscogs ? (String(f.format_raw ?? "").split(",")[1]?.trim() || null) : f.file_format, bitrate_kbps: f.bitrate_kbps ?? null,
      sample_rate_hz: f.sample_rate_hz ?? null, duration_seconds: f.duration_seconds ?? null, file_size_bytes: f.file_size_bytes ?? null,
      bpm_x100: f.bpm_x100 ?? null, musical_key: f.musical_key ?? null, rating: f.rating ?? null, play_count: f.play_count ?? null,
      file_location: f.file_location ?? null, source_comments: f.source_comments ?? null, ...common };
  } else {
    table = "wants";
    const { date_added: _ignored, ...rest } = common;
    cols = { user_id: batch.owner_id, want_kind: "edition", artist_text: f.artist_text, title_text: f.title_text, label_text: f.label_text,
      catno_text: f.catno_text, format_raw: f.format_raw, format_group: f.format_group, release_year: f.release_year, ...rest };
  }
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => cols[k]));
}

function finalizeCommit(db: DB, clock: Clock, batch: any, kind: SourceKind) {
  const now = iso(clock.now());
  const count = (sql: string) => (db.prepare(sql).get(batch.id) as { n: number }).n;
  let playlistReport = { playlists: 0, folders: 0, unresolved_track_refs: 0 };
  if (batch.pending_playlists) playlistReport = writePlaylists(db, batch, JSON.parse(batch.pending_playlists));
  const missing = db
    .prepare(
      `SELECT se.id, json_extract(se.data, '$.fields.artist_text') AS artist, json_extract(se.data, '$.fields.title_text') AS title
       FROM source_entries se WHERE se.source_library_id = ? AND se.last_seen_batch_id != ? LIMIT 200`,
    )
    .all(batch.source_library_id, batch.id) as any[];
  const missingTotal = (db.prepare("SELECT COUNT(*) AS n FROM source_entries WHERE source_library_id = ? AND last_seen_batch_id != ?").get(batch.source_library_id, batch.id) as { n: number }).n;
  const report = {
    kind,
    created: count("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND applied = 1 AND (classification = 'new' OR decision = 'create')"),
    updated: count("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND applied = 1 AND (classification = 'changed' OR decision = 'link')"),
    unchanged: count("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND classification = 'existing'"),
    skipped: count("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND decision = 'skip'"),
    invalid: count("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND classification = 'invalid'"),
    kept_user_edits: count("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND json_extract(previous_state, '$.kept_user_edits') = 1"),
    missing_from_export: missingTotal,
    missing_examples: missing.slice(0, 20).map((m) => `${m.artist ?? "?"} — ${m.title ?? "?"}`),
    ...playlistReport,
    note: "Entries missing from this export were kept, not deleted.",
  };
  db.prepare("UPDATE import_batches SET status = 'committed', committed_at = ?, report = ?, rows_applied = rows_total WHERE id = ?").run(now, JSON.stringify(report), batch.id);
}

function writePlaylists(db: DB, batch: any, nodes: ParsedPlaylistNode[]) {
  const byId = new Map<string, number>();
  const byLocation = new Map<string, number>();
  for (const e of db.prepare("SELECT id, external_id, json_extract(data, '$.fields.file_location') AS loc FROM source_entries WHERE source_library_id = ?").all(batch.source_library_id) as any[]) {
    if (e.external_id) byId.set(e.external_id, e.id);
    if (e.loc) byLocation.set(e.loc, e.id);
  }
  const rep = { playlists: 0, folders: 0, unresolved_track_refs: 0 };
  const insertNode = db.prepare("INSERT INTO source_playlists (source_library_id, batch_id, parent_id, node_type, name, path, position) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertItem = db.prepare("INSERT INTO source_playlist_items (playlist_id, position, source_entry_id) VALUES (?, ?, ?)");
  const walk = (list: ParsedPlaylistNode[], parentId: number | null, parentPath: string) => {
    list.forEach((n, i) => {
      const path = parentPath ? `${parentPath} / ${n.name}` : n.name;
      const id = Number(insertNode.run(batch.source_library_id, batch.id, parentId, n.type, n.name, path, i + 1).lastInsertRowid);
      if (n.type === "folder") rep.folders++;
      else rep.playlists++;
      let pos = 0;
      for (const key of n.trackKeys) {
        const entryId = n.keyType === "location" ? byLocation.get(decodeURIComponentSafe(key.replace(/^file:\/\/localhost/i, ""))) : byId.get(key);
        if (entryId == null) { rep.unresolved_track_refs++; continue; }
        insertItem.run(id, ++pos, entryId);
      }
      walk(n.children, id, path);
    });
  };
  walk(nodes, null, "");
  return rep;
}

function decodeURIComponentSafe(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ───────────────────────── Undo ─────────────────────────
/**
 * Undoes the most recent committed import of a source library:
 * - removes holdings it created, unless the owner has since edited, tagged, crated, charted,
 *   listed, photographed or linked them (those are kept and reported);
 * - restores source metadata and holding fields it updated, unless the owner edited them since;
 * - restores "last seen" markers. Playlists revert automatically (see current_source_playlists).
 */
export function undoImport(db: DB, clock: Clock, ownerId: number, batchId: number) {
  return db.transaction(() => {
    const b = getBatch(db, ownerId, batchId);
    if (b.status !== "committed") throw new DomainError("Only a committed import can be undone.");
    const later = db.prepare("SELECT id FROM import_batches WHERE source_library_id = ? AND id > ? AND status IN ('committed', 'committing')").get(b.source_library_id, batchId) as any;
    if (later) throw new DomainError(`Import #${later.id} of the same source came after this one. Undo that one first.`);
    const now = iso(clock.now());
    const rows = db.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND applied = 1 ORDER BY row_number DESC").all(batchId) as any[];
    const summary = { removed: 0, kept_edited_or_used: 0, restored: 0, restore_skipped_user_edits: 0 };
    for (const row of rows) {
      const prev = row.previous_state ? JSON.parse(row.previous_state) : null;
      const created = row.classification === "new" || row.decision === "create";
      if (created && row.result_entry_id) {
        const h = holdingForEntry(db, row.result_entry_id);
        if (h && isProtected(db, h)) { summary.kept_edited_or_used++; continue; }
        if (h) db.prepare(`DELETE FROM ${TABLE[h.type].table} WHERE id = ?`).run(h.id);
        db.prepare("DELETE FROM source_playlist_items WHERE source_entry_id = ?").run(row.result_entry_id);
        db.prepare("UPDATE import_rows SET matched_entry_id = NULL WHERE matched_entry_id = ?").run(row.result_entry_id);
        db.prepare("UPDATE import_rows SET decision_entry_id = NULL WHERE decision_entry_id = ?").run(row.result_entry_id);
        db.prepare("UPDATE import_rows SET result_entry_id = NULL WHERE result_entry_id = ?").run(row.result_entry_id);
        db.prepare("DELETE FROM source_entries WHERE id = ?").run(row.result_entry_id);
        summary.removed++;
      } else if (prev?.entry && row.result_entry_id) {
        const e = prev.entry;
        if (e.data !== undefined) {
          db.prepare("UPDATE source_entries SET data = ?, content_hash = ?, last_seen_batch_id = ?, external_id = ?, identity_key = ?, hints = ?, updated_at = ? WHERE id = ?").run(
            e.data, e.content_hash, e.last_seen_batch_id, e.external_id, e.identity_key, e.hints, now, row.result_entry_id);
          const h = prev.holding;
          if (h && !prev.kept_user_edits) {
            const current = db.prepare(`SELECT user_edited_at FROM ${TABLE[h.type].table} WHERE id = ?`).get(h.id) as any;
            if (current && !current.user_edited_at) {
              const cols = Object.keys(h.fields).filter((c) => c !== "user_edited_at");
              db.prepare(`UPDATE ${TABLE[h.type].table} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => h.fields[c]), now, h.id);
              summary.restored++;
            } else if (current) summary.restore_skipped_user_edits++;
          }
        } else {
          db.prepare("UPDATE source_entries SET last_seen_batch_id = ? WHERE id = ?").run(e.last_seen_batch_id, row.result_entry_id);
        }
      }
    }
    const report = { ...(b.report ?? {}), undo: { ...summary, at: now } };
    db.prepare("UPDATE import_batches SET status = 'undone', undone_at = ?, report = ? WHERE id = ?").run(now, JSON.stringify(report), batchId);
    return summary;
  })();
}

function isProtected(db: DB, h: { type: string; id: number; user_edited_at: string | null }): boolean {
  if (h.user_edited_at) return true;
  if (h.type === "physical") {
    return !!(
      db.prepare("SELECT 1 FROM copy_tags WHERE copy_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM crate_items WHERE copy_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM chart_entries WHERE copy_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM listings WHERE copy_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM copy_photos WHERE copy_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM digital_holdings WHERE linked_copy_id = ?").get(h.id)
    );
  }
  if (h.type === "digital") {
    return !!(
      db.prepare("SELECT 1 FROM digital_tags WHERE digital_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM crate_items WHERE digital_id = ?").get(h.id) ||
      db.prepare("SELECT 1 FROM chart_entries WHERE digital_id = ?").get(h.id)
    );
  }
  return false;
}
