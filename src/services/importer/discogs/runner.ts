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
import { DiscogsCatalogWriter, reconcileReferences, resetReconcileScope, unresolvedCounts, type BatchResult, type StatementTime, type WriterTimings } from "./writer.js";
import { markSearchStale, reindexAll, searchBackend } from "../../search/index.js";
import { deferredIndexes, dropDeferrableIndexes, restoreDeferredIndexes } from "./bulk-indexes.js";

export type DumpType = "artists" | "labels" | "masters" | "releases";
export const IMPORT_ORDER: DumpType[] = ["artists", "labels", "masters", "releases"];
const SCOPE = { artists: "artist", labels: "label", masters: "master", releases: "release" } as const;
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
  /** With `profile`: cumulative ms per phase and per writer statement so far. */
  profile?: { phases: { parse: number; normalize: number; write: number; writer: WriterTimings }; statements: StatementTime[] };
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
  /**
   * Bulk-load mode: write catalog rows only and skip search-index updates. The index is marked
   * stale and must be rebuilt with `reindexAll()` (`catalog search:reindex`); `import-all
   * --defer-search` does that once at the end. A resumed run keeps the mode it started with.
   */
  deferSearch?: boolean;
  /**
   * Bulk-load mode: drop secondary indexes on scattered values for the run and rebuild them once
   * at the end (see bulk-indexes.ts). A resumed run keeps the mode it started with.
   */
  deferIndexes?: boolean;
  /** Internal (import-all): leave the indexes dropped at the end; the caller rebuilds and reconciles. */
  keepIndexesDeferred?: boolean;
  /** Called with a short message when a long step without record progress starts (rebuilds, linking). */
  onStep?: (message: string) => void;
  /** Collect per-statement timings (reported via onProgress and in the result). */
  profile?: boolean;
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

/**
 * Where the time went, in ms. `parse` = wall time not spent in normalise/write/reconcile, i.e.
 * gunzip + XML parsing + tree building + the importer's own bookkeeping. `write` includes the
 * writer's sub-phases (lookup, hash, provenance, search) plus plain row inserts and the commit.
 */
export interface ImportTimings { wall: number; parse: number; normalize: number; write: number; reconcile: number; writer: WriterTimings }

export interface ImportResult extends Progress {
  status: string; runId: number; searchMode: "incremental" | "deferred"; indexMode: "maintained" | "deferred";
  indexes: { dropped: string[]; restoredBeforeRun: string[]; rebuildMs: number };
  timings: ImportTimings;
}

export async function runImport(db: DB, opts: RunOptions): Promise<ImportResult> {
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
  let deferSearch = !!opts.deferSearch;
  let deferIndexes = !!opts.deferIndexes;
  if (opts.resumeRunId) {
    const run = db.prepare("SELECT * FROM catalog_import_runs WHERE id = ?").get(opts.resumeRunId) as any;
    if (!run) throw new FatalImportError(`Import run #${opts.resumeRunId} not found.`);
    if (run.status === "completed" || run.status === "completed_with_errors") throw new FatalImportError(`Run #${run.id} already finished (${run.status}).`);
    if (run.entity_type !== type) throw new FatalImportError(`Run #${run.id} imported ${run.entity_type}, not ${type}.`);
    if (run.file_size != null && run.file_size !== fileSize) throw new FatalImportError(`This file (${fileSize} bytes) is not the one run #${run.id} was reading (${run.file_size} bytes). Start a new run instead.`);
    runId = run.id;
    skip = run.checkpoint_record_index;
    deferSearch = opts.deferSearch ?? run.search_mode === "deferred";
    deferIndexes = opts.deferIndexes ?? run.index_mode === "deferred";
    db.prepare("UPDATE catalog_import_runs SET status = 'running', fatal_error = NULL, updated_at = ? WHERE id = ?").run(now(), runId);
  } else {
    const active = db.prepare("SELECT id FROM catalog_import_runs WHERE entity_type = ? AND status = 'running'").get(type) as any;
    if (active) throw new FatalImportError(`Run #${active.id} (${type}) is marked running. Resume it with --resume ${active.id}, or mark it cancelled with \`catalog cancel ${active.id}\` if it was interrupted.`);
    runId = Number(db.prepare(
      `INSERT INTO catalog_import_runs (source, entity_type, source_version, dump_date, file_name, file_path, file_size, expected_hash, search_mode, status, started_at, created_at, updated_at)
       VALUES ('discogs', ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(type, meta.version, meta.date, path.basename(opts.file), path.resolve(opts.file), fileSize, opts.expectedHash ?? null, deferSearch ? "deferred" : "incremental", now(), now(), now()).lastInsertRowid);
  }
  db.prepare("UPDATE catalog_import_runs SET search_mode = ?, index_mode = ? WHERE id = ?").run(deferSearch ? "deferred" : "incremental", deferIndexes ? "deferred" : "maintained", runId);
  // Indexes: a normal run never writes while indexes are missing (e.g. after an interrupted bulk
  // load); a bulk run drops the deferrable ones, recording their definitions first.
  const indexInfo = { dropped: [] as string[], restoredBeforeRun: [] as string[], rebuildMs: 0 };
  if (!deferIndexes && deferredIndexes(db).length) indexInfo.restoredBeforeRun = restoreDeferredIndexes(db).restored;
  if (deferIndexes) indexInfo.dropped = dropDeferrableIndexes(db, runId, now());
  // Mark stale before the first write, so an interrupted deferred run still leaves the flag set.
  if (deferSearch) markSearchStale(db, `Import run #${runId} (${type}) was run with deferred search`, now());
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
  resetReconcileScope(db);
  const writer = new DiscogsCatalogWriter(db, runId, now, { search: deferSearch ? null : searchBackend(db), profile: opts.profile });
  const phase = { normalize: 0, write: 0, reconcile: 0 };
  const wallStart = performance.now();
  const timingsOf = (): ImportTimings => {
    const wall = performance.now() - wallStart;
    return { wall, parse: Math.max(0, wall - phase.normalize - phase.write - phase.reconcile), ...phase, writer: { ...writer.timings } };
  };
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
    if (opts.profile) {
      const wall = performance.now() - wallStart;
      p.profile = {
        phases: { parse: Math.max(0, wall - phase.normalize - phase.write), normalize: phase.normalize, write: phase.write, writer: { ...writer.timings } },
        statements: [...writer.statementTimes.values()].map((x) => ({ ...x })),
      };
    }
    opts.onProgress?.({ ...p });
  };

  const flush = () => {
    if (!batch.length && !batchErrors.length) return;
    const records = batch;
    const errors = batchErrors;
    batch = [];
    batchErrors = [];
    const tw = performance.now();
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
    phase.write += performance.now() - tw;
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
        const t0 = performance.now();
        try { batch.push(NORMALIZE[type](node)); } finally { phase.normalize += performance.now() - t0; }
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
    const keepDeferred = deferIndexes && opts.keepIndexesDeferred;
    if (deferIndexes && !keepDeferred) {
      opts.onStep?.(`Rebuilding ${indexInfo.dropped.length} deferred indexes (one sort each; no per-record progress)…`);
      indexInfo.rebuildMs = restoreDeferredIndexes(db, (name, i, n) => opts.onStep?.(`  index ${i}/${n}: ${name}`)).ms;
    }
    if (!keepDeferred) opts.onStep?.(skip > 0 ? "Linking references across the catalog (resumed run)…" : "Linking references to this run's records…");
    const tr = performance.now();
    // A resumed run didn't record the ids written before the interruption, so it reconciles fully.
    // Otherwise (bulk or not) only references to this run's records can be newly resolvable:
    // everything else was resolved when the rows were written. On the real dump, a catalog-wide
    // pass here cost 130 s after 1M releases to find nothing. import-all --defer-indexes does its
    // own single pass after the rebuild.
    const reconciled = keepDeferred ? {} : reconcileReferences(db, skip > 0 ? {} : { scope: SCOPE[type] });
    // Store what is still unresolved after reconciliation (catalog-wide), not the write-time count.
    if (!keepDeferred) p.unresolved = Object.values(unresolvedCounts(db)).reduce((a, b) => a + b, 0);
    phase.reconcile += performance.now() - tr;
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
  return { ...p, status, runId, searchMode: deferSearch ? "deferred" : "incremental", indexMode: deferIndexes ? "deferred" : "maintained", indexes: indexInfo, timings: timingsOf() };
}

export interface ImportAllOptions extends Omit<RunOptions, "file" | "type" | "resumeRunId" | "expectedHash" | "limit"> {
  dir: string;
  date?: string;                                  // YYYYMMDD: only files for that dump
  checksumFor?: (file: string) => string | null;  // expected sha256 per file (from CHECKSUM.txt)
}

/**
 * Imports every dump in `dir` in dependency order (artists → labels → masters → releases).
 * With `deferSearch`, no search documents are written during the runs; once all runs have
 * finished without a fatal error, references are reconciled and the index is rebuilt once.
 */
export async function runImportAll(db: DB, opts: ImportAllOptions) {
  const files = fs.readdirSync(opts.dir).filter((f) => /\.xml(\.gz)?$/.test(f) && (!opts.date || f.includes(opts.date)));
  const runs: ImportResult[] = [];
  const skipped: DumpType[] = [];
  for (const type of IMPORT_ORDER) {
    const f = files.find((x) => parseDumpFileName(x).type === type);
    if (!f) { skipped.push(type); continue; }
    const file = path.join(opts.dir, f);
    runs.push(await runImport(db, { ...opts, file, type, expectedHash: opts.checksumFor?.(file) ?? null, keepIndexesDeferred: opts.deferIndexes }));
  }
  let indexRebuild: { restored: number; ms: number; reconcileMs: number } | null = null;
  if (opts.deferIndexes) {
    // Rebuild each deferred index once over the full tables, then link everything in one pass.
    opts.onStep?.("Rebuilding deferred indexes (one sort each; no per-record progress)…");
    const r = restoreDeferredIndexes(db, (name, i, n) => opts.onStep?.(`  index ${i}/${n}: ${name}`));
    opts.onStep?.("Linking references across the catalog…");
    const t = performance.now();
    reconcileReferences(db);
    indexRebuild = { restored: r.restored.length, ms: r.ms, reconcileMs: performance.now() - t };
  }
  let reindexed: { documents: number; ms: number } | null = null;
  if (opts.deferSearch && runs.length) {
    // Each run already reconciled the references to what it imported.
    opts.onStep?.("Rebuilding the search index…");
    const t = performance.now();
    const documents = reindexAll(db);
    reindexed = { documents, ms: performance.now() - t };
  }
  return { runs, skipped, indexRebuild, reindexed, unresolved: unresolvedCounts(db) };
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
