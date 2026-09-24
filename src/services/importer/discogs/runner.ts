/**
 * Orchestrates one Discogs dump import run.
 *
 * - A `catalog_import_runs` row tracks status, counters, file hash and a checkpoint.
 * - Records are committed in batches; each batch transaction also advances the checkpoint, so
 *   the checkpoint always matches what is in the database.
 * - Record-level problems are logged (catalog_import_errors + an NDJSON log file) and the run
 *   continues. Fatal problems (unreadable file, malformed XML, database errors) stop the run with
 *   status 'failed' and a message; `resume` continues from the last checkpoint.
 * - Re-running on the same or a newer dump is idempotent: matching is by Discogs id and unchanged
 *   records are skipped by content hash.
 */
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../../../db/index.js";
import { FatalImportError, streamRecords, type XNode } from "./stream.js";
import { artistFromNode, labelFromNode, masterFromNode, RecordError, releaseFromNode } from "./normalize.js";
import { DiscogsCatalogWriter, reconcileReferences, unresolvedCounts, type BatchResult } from "./writer.js";

export type DumpType = "artists" | "labels" | "masters" | "releases";
export const IMPORT_ORDER: DumpType[] = ["artists", "labels", "masters", "releases"];
const RECORD_TAG: Record<DumpType, string> = { artists: "artist", labels: "label", masters: "master", releases: "release" };
const NORMALIZE = { artists: artistFromNode, labels: labelFromNode, masters: masterFromNode, releases: releaseFromNode } as const;
const MAX_ERRORS_IN_DB = 10_000;

/** Thrown from the record callback to stop reading early (used by --limit). */
class StopReading extends Error {}

export interface Progress {
  runId: number;
  type: DumpType;
  fileName: string;
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  skippedLocal: number;
  unresolved: number;
  lastExternalId: string | null;
  bytesRead: number;
  fileSize: number;
  recordsPerSecond: number;
  elapsedSeconds: number;
}

export interface RunOptions {
  file: string;
  type?: DumpType;              // inferred from the file name when omitted
  batchSize?: number;           // records per transaction (default 1000)
  limit?: number;               // stop after this many records (for trials)
  resumeRunId?: number;         // continue a failed/cancelled/running run of the same file
  expectedHash?: string | null; // from the published CHECKSUM file
  logDir?: string;              // where NDJSON error logs go (default data/import-logs)
  onProgress?: (p: Progress) => void;
  progressEveryMs?: number;
  now?: () => Date;
  /** Test hook: throw a fatal error after this many records have been committed. */
  failAfterRecords?: number;
}

/** discogs_20260901_releases.xml.gz → { type: 'releases', version: '20260901', date: '2026-09-01' } */
export function parseDumpFileName(file: string): { type: DumpType | null; version: string | null; date: string | null } {
  const base = path.basename(file);
  const m = /discogs_(\d{8})_(artists|labels|masters|releases)\.xml(\.gz)?$/i.exec(base);
  const loose = /(artists|labels|masters|releases)\.xml(\.gz)?$/i.exec(base);
  const version = m?.[1] ?? null;
  return {
    type: ((m?.[2] ?? loose?.[1])?.toLowerCase() as DumpType) ?? null,
    version,
    date: version ? `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}` : null,
  };
}

export async function runImport(db: DB, opts: RunOptions): Promise<Progress & { status: string; runId: number }> {
  const nowDate = opts.now ?? (() => new Date());
  const now = () => nowDate().toISOString();
  const meta = parseDumpFileName(opts.file);
  const type = opts.type ?? meta.type;
  if (!type) throw new FatalImportError(`Can't tell the dump type from “${path.basename(opts.file)}”. Pass --type artists|labels|masters|releases.`);
  if (!fs.existsSync(opts.file)) throw new FatalImportError(`File not found: ${opts.file}`);
  const fileSize = fs.statSync(opts.file).size;
  const batchSize = Math.max(1, Math.min(20_000, opts.batchSize ?? 1000));

  // ── Create or resume the run ──
  let runId: number;
  let skip = 0;
  if (opts.resumeRunId) {
    const run = db.prepare("SELECT * FROM catalog_import_runs WHERE id = ?").get(opts.resumeRunId) as any;
    if (!run) throw new FatalImportError(`Import run #${opts.resumeRunId} not found.`);
    if (run.status === "completed" || run.status === "completed_with_errors") throw new FatalImportError(`Run #${run.id} already finished (${run.status}).`);
    if (run.entity_type !== type) throw new FatalImportError(`Run #${run.id} imported ${run.entity_type}, not ${type}.`);
    if (run.file_size != null && run.file_size !== fileSize) throw new FatalImportError(`This file (${fileSize} bytes) is not the one run #${run.id} was reading (${run.file_size} bytes). Start a new run instead.`);
    runId = run.id;
    skip = run.checkpoint_record_index;
    db.prepare("UPDATE catalog_import_runs SET status = 'running', fatal_error = NULL, updated_at = ? WHERE id = ?").run(now(), runId);
  } else {
    const active = db.prepare("SELECT id FROM catalog_import_runs WHERE entity_type = ? AND status = 'running'").get(type) as any;
    if (active) throw new FatalImportError(`Run #${active.id} (${type}) is marked running. Resume it with --resume ${active.id}, or mark it cancelled with \`catalog cancel ${active.id}\` if it was interrupted.`);
    runId = Number(db.prepare(
      `INSERT INTO catalog_import_runs (source, entity_type, source_version, dump_date, file_name, file_path, file_size, expected_hash, status, started_at, created_at, updated_at)
       VALUES ('discogs', ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(type, meta.version, meta.date, path.basename(opts.file), path.resolve(opts.file), fileSize, opts.expectedHash ?? null, now(), now(), now()).lastInsertRowid);
  }
  const logDir = opts.logDir ?? path.resolve("data/import-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `catalog-run-${runId}.ndjson`);
  db.prepare("UPDATE catalog_import_runs SET error_log_location = ? WHERE id = ?").run(logPath, runId);
  const log = fs.createWriteStream(logPath, { flags: "a" });

  const run0 = db.prepare("SELECT * FROM catalog_import_runs WHERE id = ?").get(runId) as any;
  const p: Progress = {
    runId, type, fileName: path.basename(opts.file), processed: run0.records_processed, created: run0.records_created, updated: run0.records_updated,
    unchanged: run0.records_unchanged, failed: run0.records_failed, skippedLocal: run0.records_skipped_local, unresolved: run0.unresolved_references,
    lastExternalId: run0.last_external_id, bytesRead: 0, fileSize, recordsPerSecond: 0, elapsedSeconds: 0,
  };
  const writer = new DiscogsCatalogWriter(db, runId, now);
  const started = Date.now();
  const processedAtStart = p.processed;
  let lastReport = 0;
  let batch: unknown[] = [];
  let batchErrors: { externalId: string | null; errorType: string; message: string; raw: string | null }[] = [];
  let checkpoint = skip; // index (exclusive) of the last record handed to a batch
  let errorsLogged = (db.prepare("SELECT COUNT(*) AS n FROM catalog_import_errors WHERE import_run_id = ?").get(runId) as { n: number }).n;

  const insertError = db.prepare("INSERT INTO catalog_import_errors (import_run_id, external_id, entity_type, error_type, message, raw_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const report = (force = false) => {
    const t = Date.now();
    if (!force && t - lastReport < (opts.progressEveryMs ?? 2000)) return;
    lastReport = t;
    p.elapsedSeconds = (t - started) / 1000;
    p.recordsPerSecond = p.elapsedSeconds > 0 ? Math.round((p.processed - processedAtStart) / p.elapsedSeconds) : 0;
    opts.onProgress?.({ ...p });
  };

  const flush = () => {
    if (!batch.length && !batchErrors.length) return;
    const records = batch;
    const errors = batchErrors;
    batch = [];
    batchErrors = [];
    db.transaction(() => {
      const r: BatchResult =
        type === "artists" ? writer.writeArtists(records as any) : type === "labels" ? writer.writeLabels(records as any)
        : type === "masters" ? writer.writeMasters(records as any) : writer.writeReleases(records as any);
      p.created += r.created; p.updated += r.updated; p.unchanged += r.unchanged; p.skippedLocal += r.skippedLocal; p.unresolved += r.unresolved;
      p.processed += records.length + errors.length;
      p.failed += errors.length;
      if (r.lastExternalId) p.lastExternalId = r.lastExternalId;
      const all = [...errors, ...r.conflicts.map((c) => ({ externalId: c.externalId, errorType: "local_edit_conflict", message: c.message, raw: null }))];
      for (const e of all) {
        log.write(JSON.stringify({ run: runId, type, ...e, at: now() }) + "\n");
        if (errorsLogged++ < MAX_ERRORS_IN_DB) insertError.run(runId, e.externalId, type.slice(0, -1), e.errorType, e.message.slice(0, 2000), e.raw, now());
      }
      db.prepare(
        `UPDATE catalog_import_runs SET records_processed = ?, records_created = ?, records_updated = ?, records_unchanged = ?, records_failed = ?, records_skipped_local = ?,
           unresolved_references = ?, last_external_id = ?, checkpoint_record_index = ?, bytes_read = ?, updated_at = ? WHERE id = ?`,
      ).run(p.processed, p.created, p.updated, p.unchanged, p.failed, p.skippedLocal, p.unresolved, p.lastExternalId, checkpoint, p.bytesRead, now(), runId);
    })();
    if (opts.failAfterRecords != null && p.processed >= opts.failAfterRecords) throw new FatalImportError(`Simulated interruption after ${p.processed} records`);
    report();
  };

  const onRecord = (node: XNode | null, m: { index: number; truncated: boolean; oversized: boolean }) => {
    if (m.index < skip) return; // already committed by an earlier attempt of this run
    if (opts.limit != null && m.index >= skip + opts.limit) throw new StopReading();
    checkpoint = m.index + 1;
    const idGuess = node ? (node.attrs.id ?? node.children.find((c) => c.name === "id")?.text?.trim() ?? null) : null;
    if (!node) {
      batchErrors.push({ externalId: null, errorType: "invalid_record", message: `Record #${m.index + 1} exceeds the per-record size limit and was skipped.`, raw: null });
    } else {
      try {
        batch.push(NORMALIZE[type](node));
        if (m.truncated) batchErrors.push({ externalId: idGuess, errorType: "field_truncated", message: "A very long field was truncated to the size limit (record imported).", raw: null });
      } catch (e: any) {
        if (!(e instanceof RecordError)) throw e;
        batchErrors.push({ externalId: e.externalId ?? idGuess, errorType: "invalid_record", message: e.message, raw: JSON.stringify(node).slice(0, 500) });
        // a truncated-but-invalid record is counted once, as invalid
      }
    }
    // A record with only a truncation warning was also added to `batch`; don't double-count it as failed.
    if (batch.length + batchErrors.filter((x) => x.errorType !== "field_truncated").length >= batchSize) flushWithWarnings();
  };

  // Truncation warnings are informational: log them but don't count them as failed records.
  const flushWithWarnings = () => {
    const warnings = batchErrors.filter((e) => e.errorType === "field_truncated");
    batchErrors = batchErrors.filter((e) => e.errorType !== "field_truncated");
    flush();
    for (const w of warnings) {
      log.write(JSON.stringify({ run: runId, type, ...w, at: now() }) + "\n");
      if (errorsLogged++ < MAX_ERRORS_IN_DB) insertError.run(runId, w.externalId, type.slice(0, -1), w.errorType, w.message, null, now());
    }
  };

  let status = "running";
  try {
    let stats: Awaited<ReturnType<typeof streamRecords>> | null = null;
    try {
      stats = await streamRecords(opts.file, RECORD_TAG[type], onRecord, { onBytes: (b) => { p.bytesRead = b; report(); } });
    } catch (e) {
      if (!(e instanceof StopReading)) throw e;
    }
    flushWithWarnings();
    const reconciled = reconcileReferences(db);
    // Store what is still unresolved after reconciliation (catalog-wide), not the write-time count.
    const remaining = unresolvedCounts(db);
    p.unresolved = Object.values(remaining).reduce((a, b) => a + b, 0);
    db.prepare("UPDATE catalog_import_runs SET unresolved_references = ? WHERE id = ?").run(p.unresolved, runId);
    if (!stats) {
      // Stopped by --limit: a partial run that can be resumed.
      status = "cancelled";
      db.prepare("UPDATE catalog_import_runs SET status = 'cancelled', fatal_error = ?, checkpoint_record_index = ?, updated_at = ? WHERE id = ?")
        .run(`Stopped after --limit ${opts.limit} records; resume to continue.`, checkpoint, now(), runId);
    } else {
      const hashMismatch = opts.expectedHash && stats.sha256 && opts.expectedHash.toLowerCase() !== stats.sha256;
      status = p.failed || hashMismatch ? "completed_with_errors" : "completed";
      db.prepare(`UPDATE catalog_import_runs SET status = ?, completed_at = ?, file_hash = ?, bytes_read = ?, fatal_error = ?, checkpoint_record_index = ?, updated_at = ? WHERE id = ?`).run(
        status, now(), stats.sha256, stats.bytesRead, hashMismatch ? `File hash ${stats.sha256} does not match the published checksum ${opts.expectedHash}.` : null, stats.records, now(), runId);
    }
    log.write(JSON.stringify({ run: runId, event: "reconciled", reconciled, at: now() }) + "\n");
  } catch (e: any) {
    status = "failed";
    const message = e instanceof FatalImportError ? e.message : `Unexpected error: ${e?.message ?? e}`;
    db.prepare("UPDATE catalog_import_runs SET status = 'failed', fatal_error = ?, updated_at = ? WHERE id = ?").run(message, now(), runId);
    log.write(JSON.stringify({ run: runId, event: "fatal", message, at: now() }) + "\n");
    await new Promise((r) => log.end(r));
    report(true);
    throw Object.assign(e instanceof FatalImportError ? e : new FatalImportError(message), { runId });
  }
  await new Promise((r) => log.end(r));
  report(true);
  return { ...p, status, runId };
}

export function getRun(db: DB, id?: number) {
  return (id ? db.prepare("SELECT * FROM catalog_import_runs WHERE id = ?").get(id) : db.prepare("SELECT * FROM catalog_import_runs ORDER BY id DESC LIMIT 1").get()) as any;
}

export function listRuns(db: DB, limit = 20) {
  return db.prepare("SELECT * FROM catalog_import_runs ORDER BY id DESC LIMIT ?").all(limit) as any[];
}

export function runErrors(db: DB, runId: number, limit = 50) {
  return db.prepare("SELECT * FROM catalog_import_errors WHERE import_run_id = ? ORDER BY id LIMIT ?").all(runId, limit) as any[];
}

export function cancelRun(db: DB, runId: number) {
  const r = db.prepare("UPDATE catalog_import_runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('running', 'pending', 'failed')").run(new Date().toISOString(), runId);
  if (r.changes !== 1) throw new FatalImportError(`Run #${runId} is not running, pending or failed.`);
}
