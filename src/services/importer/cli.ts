/**
 * Catalog command line.
 *
 *   npm run catalog -- import <file.xml[.gz]> [--type releases] [--batch 1000] [--limit N] [--checksum CHECKSUM.txt]
 *   npm run catalog -- import-all <dir> [--date 20260901]      artists → labels → masters → releases
 *   npm run catalog -- resume <runId>
 *   npm run catalog -- status [runId]
 *   npm run catalog -- errors <runId> [--limit 50]
 *   npm run catalog -- cancel <runId>                            mark an interrupted run as cancelled
 *   npm run catalog -- reconcile                                 link references imported out of order
 *   npm run catalog -- search:reindex                            rebuild the search index from catalog tables
 *   npm run catalog -- verify <file> --checksum CHECKSUM.txt     check a download against the published sha256
 *   npm run catalog -- download --date 20260901 [--types artists,labels,masters,releases] [--dir data/discogs-dumps]
 *
 * Nothing here truncates or rebuilds the catalog: imports upsert by Discogs id.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "../../config.js";
import { openDatabase } from "../../db/index.js";
import { reindexAll } from "../search/index.js";
import { FatalImportError, sha256File } from "./discogs/stream.js";
import { cancelRun, getRun, IMPORT_ORDER, listRuns, parseDumpFileName, runErrors, runImport, type Progress } from "./discogs/runner.js";
import { reconcileReferences, unresolvedCounts } from "./discogs/writer.js";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const n = (v: number) => v.toLocaleString("en-US");

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
  const want = path.basename(file);
  for (const line of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && path.basename(m[2]) === want) return m[1].toLowerCase();
  }
  throw new FatalImportError(`No checksum for ${want} in ${checksumPath}.`);
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
        const r = await runImport(db, { file, type: flag("type") as any, batchSize: Number(flag("batch")) || undefined, limit: flag("limit") ? Number(flag("limit")) : undefined, expectedHash: expected, ...progress });
        printRun(getRun(db, r.runId));
        break;
      }
      case "import-all": {
        const dir = args[1] ?? "data/discogs-dumps";
        const date = flag("date");
        const files = fs.readdirSync(dir).filter((f) => /\.xml(\.gz)?$/.test(f) && (!date || f.includes(date)));
        const checksum = fs.readdirSync(dir).find((f) => /CHECKSUM/i.test(f) && (!date || f.includes(date)));
        for (const type of IMPORT_ORDER) {
          const f = files.find((x) => parseDumpFileName(x).type === type);
          if (!f) { console.error(`No ${type} dump in ${dir}; skipping.`); continue; }
          const full = path.join(dir, f);
          const expected = checksum ? checksumFor(full, path.join(dir, checksum)) : null;
          const r = await runImport(db, { file: full, type, expectedHash: expected, batchSize: Number(flag("batch")) || undefined, ...progress });
          printRun(getRun(db, r.runId));
        }
        console.log("Unresolved references:", unresolvedCounts(db));
        break;
      }
      case "resume": {
        const run = getRun(db, Number(args[1]));
        if (!run) throw new FatalImportError(`Run #${args[1]} not found.`);
        const r = await runImport(db, { file: run.file_path, type: run.entity_type, resumeRunId: run.id, expectedHash: run.expected_hash, ...progress });
        printRun(getRun(db, r.runId));
        break;
      }
      case "status":
        if (args[1]) printRun(getRun(db, Number(args[1])));
        else for (const r of listRuns(db, 10).reverse()) printRun(r);
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
        break;
      case "search:reindex":
        console.log(`Indexed ${n(reindexAll(db))} catalog records.`);
        break;
      case "verify": {
        const expected = checksumFor(args[1], flag("checksum"));
        const actual = await sha256File(args[1]);
        console.log(actual === expected ? `OK ${actual}` : `MISMATCH expected ${expected} got ${actual}`);
        if (actual !== expected) process.exitCode = 1;
        break;
      }
      case "download": {
        // Official public dumps; the URL pattern is documented in docs/DISCOGS_IMPORT.md — verify it at https://data.discogs.com/ first.
        const date = flag("date");
        if (!date || !/^\d{8}$/.test(date)) throw new FatalImportError("Usage: catalog download --date YYYYMMDD (e.g. 20260901) [--types artists,labels,masters,releases]");
        const dir = flag("dir") ?? "data/discogs-dumps";
        const base = flag("base") ?? "https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data";
        fs.mkdirSync(dir, { recursive: true });
        const names = [`discogs_${date}_CHECKSUM.txt`, ...(flag("types") ?? IMPORT_ORDER.join(",")).split(",").map((t) => `discogs_${date}_${t}.xml.gz`)];
        for (const name of names) {
          const url = `${base}/${date.slice(0, 4)}/${name}`;
          const dest = path.join(dir, name);
          if (fs.existsSync(dest)) { console.error(`Already downloaded: ${dest}`); continue; }
          console.error(`Downloading ${url}`);
          const res = await fetch(url);
          if (!res.ok || !res.body) throw new FatalImportError(`Download failed (${res.status}) for ${url}`);
          await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(`${dest}.part`));
          fs.renameSync(`${dest}.part`, dest);
        }
        console.error(`Done. Verify with: npm run catalog -- verify ${path.join(dir, `discogs_${date}_releases.xml.gz`)} --checksum ${path.join(dir, `discogs_${date}_CHECKSUM.txt`)}`);
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
