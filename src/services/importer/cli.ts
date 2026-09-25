/**
 * Catalog command line.
 *
 *   npm run catalog -- import <file.xml[.gz]> [--type releases] [--batch 1000] [--limit N] [--checksum CHECKSUM.txt] [--defer-search] [--defer-indexes] [--bulk]
 *   npm run catalog -- import-all <dir> [--date 20260901] [--defer-search] [--defer-indexes] [--bulk]   artists → labels → masters → releases
 *   npm run catalog -- resume <runId>
 *   npm run catalog -- status [runId]
 *   npm run catalog -- errors <runId> [--limit 50]
 *   npm run catalog -- cancel <runId>                            mark an interrupted run as cancelled
 *   npm run catalog -- reconcile                                 link references imported out of order
 *   npm run catalog -- search:reindex                            rebuild the search index from catalog tables
 *   npm run catalog -- verify <file> --checksum CHECKSUM.txt     check a download against the published sha256
 *   npm run catalog -- census <file> [--type releases] [--limit 50000] [--json out.json]   XML structure coverage audit (writes nothing to the DB)
 *   npm run catalog -- download --date 20260901 [--types artists,labels,masters,releases] [--dir data/discogs-dumps] [--base URL]
 *   npm run catalog -- download --url <link> [--url <link> …] [--dir data/discogs-dumps]   exact links from https://data.discogs.com/
 *
 *   npm run catalog -- indexes:restore                           rebuild indexes left deferred by an interrupted bulk load
 *
 * --bulk = --defer-search + --defer-indexes: the fastest first load. --defer-indexes drops the
 * secondary indexes on scattered values for the load and rebuilds each once at the end.
 * --defer-search: bulk-load mode. Catalog rows are written without search-index updates; the
 * index is marked stale. import-all rebuilds it once at the end; after `import` run search:reindex.
 *
 * Nothing here truncates or rebuilds the catalog: imports upsert by Discogs id.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config.js";
import { openDatabase } from "../../db/index.js";
import { reindexAll, searchIndexState } from "../search/index.js";
import { census } from "./discogs/coverage.js";
import { deferredIndexes, restoreDeferredIndexes } from "./discogs/bulk-indexes.js";
import { DEFAULT_DUMP_BASE_URL, downloadDumps, dumpFileNames, dumpUrl, parseChecksums } from "./discogs/download.js";
import { FatalImportError, sha256File } from "./discogs/stream.js";
import { cancelRun, getRun, listRuns, parseDumpFileName, runErrors, runImport, runImportAll, type ImportResult, type Progress } from "./discogs/runner.js";
import { reconcileReferences, staleReferenceCounts, unresolvedCounts } from "./discogs/writer.js";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flags = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const has = (name: string) => args.includes(`--${name}`);
const n = (v: number) => v.toLocaleString("en-US");
const ms = (v: number) => `${(v / 1000).toFixed(2)}s`;

function printTimings(r: ImportResult) {
  const t = r.timings;
  const w = t.writer;
  const rows = Math.max(0, t.write - w.lookup - w.hash - w.provenance - w.search);
  console.log(`  Time ${ms(t.wall)}: parse+gunzip ${ms(t.parse)} · normalise ${ms(t.normalize)} · write ${ms(t.write)} ` +
    `(lookups ${ms(w.lookup)}, hashing ${ms(w.hash)}, provenance ${ms(w.provenance)}, search ${ms(w.search)}, rows+commit ${ms(rows)}) · reconcile ${ms(t.reconcile)} · search mode ${r.searchMode}`);
}

const deferSearchFlag = () => has("defer-search") || has("bulk");
const deferIndexesFlag = () => has("defer-indexes") || has("bulk");

function printSearchState(db: any) {
  const missing = deferredIndexes(db);
  if (missing.length) console.log(`${missing.length} catalog indexes are deferred (bulk load in progress or interrupted since ${missing[0].dropped_at}). A normal import restores them first, or run: npm run catalog -- indexes:restore`);
  const s = searchIndexState(db);
  if (s.stale_since) console.log(`Search index is STALE since ${s.stale_since} (${s.stale_reason}). Run: npm run catalog -- search:reindex`);
  else console.log(`Search index up to date${s.last_rebuilt_at ? ` (last full rebuild ${s.last_rebuilt_at}, ${n(s.documents ?? 0)} documents)` : ""}.`);
}

function printProgress(p: Progress) {
  const pct = p.fileSize ? ` (${((p.bytesRead / p.fileSize) * 100).toFixed(1)}% of file)` : "";
  process.stderr.write(
    `\nDiscogs ${p.type} import · run #${p.runId}\nFile: ${p.fileName}${pct}\nProcessed: ${n(p.processed)}  Created: ${n(p.created)}  Updated: ${n(p.updated)}  Unchanged: ${n(p.unchanged)}\n` +
    `Errors: ${n(p.failed)}  Kept local edits: ${n(p.skippedLocal)}  Unresolved refs: ${n(p.unresolved)}\nRate: ${n(p.recordsPerSecond)} records/sec  Last Discogs ID: ${p.lastExternalId ?? "—"}\n`,
  );
}

function printRun(r: any) {
  if (!r) return console.log("No import runs yet.");
  console.log(`Run #${r.id} · ${r.source} ${r.entity_type} · ${r.status}`);
  console.log(`  File: ${r.file_name}${r.dump_date ? ` (dump ${r.dump_date})` : ""}${r.file_hash ? ` sha256 ${r.file_hash.slice(0, 16)}…` : ""}`);
  console.log(`  Started ${r.started_at ?? "—"} · completed ${r.completed_at ?? "—"}`);
  console.log(`  Processed ${n(r.records_processed)} · created ${n(r.records_created)} · updated ${n(r.records_updated)} · unchanged ${n(r.records_unchanged)} · failed ${n(r.records_failed)} · kept local edits ${n(r.records_skipped_local)}`);
  console.log(`  Checkpoint: record ${n(r.checkpoint_record_index)} · last Discogs ID ${r.last_external_id ?? "—"} · unresolved references ${n(r.unresolved_references)}`);
  if (r.fatal_error) console.log(`  Note: ${r.fatal_error}`);
  if (r.error_log_location) console.log(`  Error log: ${r.error_log_location}`);
}

function checksumFor(file: string, checksumPath?: string): string | null {
  if (!checksumPath) return null;
  const sum = parseChecksums(fs.readFileSync(checksumPath, "utf8")).get(path.basename(file));
  if (!sum) throw new FatalImportError(`No checksum for ${path.basename(file)} in ${checksumPath}.`);
  return sum;
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const progress = { onProgress: printProgress, progressEveryMs: 5000 };
  try {
    switch (cmd) {
      case "import": {
        const file = args[1];
        if (!file) throw new FatalImportError("Usage: catalog import <file.xml.gz> [--type releases] [--batch 1000] [--limit N] [--checksum CHECKSUM.txt]");
        const expected = checksumFor(file, flag("checksum"));
        if (expected) {
          console.error("Verifying checksum before importing…");
          const actual = await sha256File(file);
          if (actual !== expected) throw new FatalImportError(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}. Re-download the file.`);
        }
        const r = await runImport(db, { file, type: flag("type") as any, batchSize: Number(flag("batch")) || undefined, limit: flag("limit") ? Number(flag("limit")) : undefined, expectedHash: expected, deferSearch: deferSearchFlag(), deferIndexes: deferIndexesFlag(), ...progress });
        printRun(getRun(db, r.runId));
        printTimings(r);
        printSearchState(db);
        break;
      }
      case "import-all": {
        const dir = args[1] && !args[1].startsWith("--") ? args[1] : "data/discogs-dumps";
        const date = flag("date");
        const checksum = fs.readdirSync(dir).find((f) => /CHECKSUM/i.test(f) && (!date || f.includes(date)));
        const sums = checksum ? parseChecksums(fs.readFileSync(path.join(dir, checksum), "utf8")) : new Map<string, string>();
        const r = await runImportAll(db, {
          dir, date, deferSearch: deferSearchFlag(), deferIndexes: deferIndexesFlag(), batchSize: Number(flag("batch")) || undefined, ...progress,
          checksumFor: (file) => sums.get(path.basename(file)) ?? null,
        });
        for (const type of r.skipped) console.error(`No ${type} dump in ${dir}; skipped.`);
        for (const run of r.runs) { printRun(getRun(db, run.runId)); printTimings(run); }
        if (r.indexRebuild) console.log(`Rebuilt ${r.indexRebuild.restored} deferred indexes in ${ms(r.indexRebuild.ms)}; linked references in ${ms(r.indexRebuild.reconcileMs)}.`);
        if (r.reindexed) console.log(`Search index rebuilt once: ${n(r.reindexed.documents)} documents in ${ms(r.reindexed.ms)}.`);
        console.log("Unresolved references:", r.unresolved);
        printSearchState(db);
        break;
      }
      case "resume": {
        const run = getRun(db, Number(args[1]));
        if (!run) throw new FatalImportError(`Run #${args[1]} not found.`);
        const r = await runImport(db, { file: run.file_path, type: run.entity_type, resumeRunId: run.id, expectedHash: run.expected_hash, ...progress });
        printRun(getRun(db, r.runId));
        printTimings(r);
        printSearchState(db);
        break;
      }
      case "status":
        if (args[1]) printRun(getRun(db, Number(args[1])));
        else for (const r of listRuns(db, 10).reverse()) printRun(r);
        printSearchState(db);
        break;
      case "errors":
        for (const e of runErrors(db, Number(args[1]), Number(flag("limit")) || 50)) console.log(`${e.created_at} ${e.error_type} ${e.entity_type ?? ""} ${e.external_id ?? "—"}: ${e.message}`);
        break;
      case "cancel":
        cancelRun(db, Number(args[1]));
        console.log(`Run #${args[1]} marked cancelled. Its checkpoint is kept; \`resume\` still works.`);
        break;
      case "reconcile":
        console.log("Resolved:", reconcileReferences(db));
        console.log("Still unresolved:", unresolvedCounts(db));
        console.log("Inconsistent (should be 0):", staleReferenceCounts(db));
        break;
      case "indexes:restore": {
        const r = restoreDeferredIndexes(db);
        console.log(r.restored.length ? `Rebuilt ${r.restored.length} indexes in ${ms(r.ms)}: ${r.restored.join(", ")}` : "No deferred indexes.");
        if (r.restored.length) console.log("Linked:", reconcileReferences(db));
        break;
      }
      case "search:reindex":
        const t = performance.now();
        console.log(`Indexed ${n(reindexAll(db))} catalog records in ${ms(performance.now() - t)}.`);
        break;
      case "verify": {
        const expected = checksumFor(args[1], flag("checksum"));
        const actual = await sha256File(args[1]);
        console.log(actual === expected ? `OK ${actual}` : `MISMATCH expected ${expected} got ${actual}`);
        if (actual !== expected) process.exitCode = 1;
        break;
      }
      case "census": {
        const file = args[1];
        const type = (flag("type") ?? parseDumpFileName(file ?? "").type) as string | null;
        if (!file || !type) throw new FatalImportError("Usage: catalog census <file.xml.gz> [--type releases] [--limit 50000] [--json out.json]");
        const c = await census(file, type.replace(/s$/, ""), flag("limit") ? Number(flag("limit")) : undefined);
        console.log(`${n(c.records)} ${type} records · ${c.paths.length} distinct paths · ${n(c.unicodeRecords)} records with non-ASCII text · ${n(c.emptyElements)} empty elements`);
        for (const cov of ["imported", "ignored", "unknown"] as const) {
          console.log(`\n${cov.toUpperCase()}`);
          for (const p of c.paths.filter((x) => x.coverage === cov)) {
            console.log(`  ${p.path.padEnd(60)} in ${n(p.records).padStart(9)} records · ${n(p.occurrences).padStart(10)}× · empty ${n(p.empty)} · max ${n(p.maxTextLength)} chars${cov === "unknown" && p.sample ? ` · e.g. “${p.sample}”` : ""}`);
          }
        }
        if (flag("json")) fs.writeFileSync(flag("json")!, JSON.stringify(c, null, 2));
        if (c.unknown.length) { console.log(`\n${c.unknown.length} path(s) are not handled by the parser. Review them before a full import.`); process.exitCode = 2; }
        break;
      }
      case "download": {
        const dir = flag("dir") ?? "data/discogs-dumps";
        let urls = flags("url");
        if (!urls.length) {
          const date = flag("date");
          if (!date) throw new FatalImportError("Usage: catalog download --date YYYYMMDD [--types …] [--base URL]  or  catalog download --url <link from https://data.discogs.com/> …");
          const base = flag("base") ?? process.env.DISCOGS_DUMP_BASE_URL ?? DEFAULT_DUMP_BASE_URL;
          if (base === DEFAULT_DUMP_BASE_URL) console.error(`Note: ${DEFAULT_DUMP_BASE_URL} is the historical dump location and is unverified (it returned 403 in Sept 2026). If it fails, use --url with links from https://data.discogs.com/.`);
          urls = dumpFileNames(date, (flag("types") ?? "artists,labels,masters,releases").split(",")).map((name) => dumpUrl(base, name));
        }
        let last = 0;
        const results = await downloadDumps(urls, dir, {
          onProgress: (name, bytes, total) => {
            if (Date.now() - last < 5000) return;
            last = Date.now();
            process.stderr.write(`${name}: ${n(bytes)}${total ? ` of ${n(total)} bytes (${((bytes / total) * 100).toFixed(1)}%)` : " bytes"}\n`);
          },
        });
        for (const r of results) {
          console.log(`${r.status.padEnd(26)} ${r.name}  ${n(r.bytes)} bytes${r.contentLength != null ? ` (Content-Length ${n(r.contentLength)})` : ""}  ${r.verified ? "sha256 verified" : r.name.includes("CHECKSUM") ? "" : "NOT verified (no checksum)"}`);
        }
        break;
      }
      default:
        console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ \* ?/gm, ""));
    }
  } catch (e: any) {
    // Fatal errors: stop with a clear message. (Record-level errors never reach here.)
    console.error(`\nFATAL: ${e?.message ?? e}${e?.runId ? `\nThe checkpoint is saved. Continue with: npm run catalog -- resume ${e.runId}` : ""}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

void main();
