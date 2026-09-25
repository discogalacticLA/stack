/**
 * Import benchmark: imports (a slice of) one dump file into a NEW database and reports throughput,
 * time per phase, peak memory, database growth, search-index growth and search latency.
 *
 *   npx tsx scripts/benchmark-import.ts --file data/discogs-dumps/discogs_20260901_releases.xml.gz \
 *     --limit 50000 --db data/bench-incremental.db [--defer-search] [--out bench.json] [--progress] [--profile]
 *
 * --profile times every writer statement and prints the six slowest per 10 s interval (with
 * --progress), which shows which statement grows as the database grows.
 *
 * Safety: refuses to use an existing database file, so it can never touch your working catalog.
 * Relationships to entities not in the benchmark DB (artists, labels, masters) stay unresolved, which
 * is realistic for a releases-first import. Import the smaller dumps into the same DB first
 * (--keep-db on later runs) to benchmark a fully linked import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { runImport } from "../src/services/importer/discogs/runner.js";
import { unresolvedCounts } from "../src/services/importer/discogs/writer.js";
import { reindexAll } from "../src/services/search/index.js";
import { unifiedSearch } from "../src/services/catalog-api/index.js";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (k: string) => args.includes(`--${k}`);
const file = flag("file");
const dbPath = flag("db");
if (!file || !dbPath) {
  console.error("Usage: npx tsx scripts/benchmark-import.ts --file <dump.xml.gz> --db <new.db> [--type releases] [--limit 50000] [--batch 1000] [--defer-search] [--keep-db] [--out bench.json]");
  process.exit(1);
}
if (fs.existsSync(dbPath) && !has("keep-db")) {
  console.error(`${dbPath} already exists. The benchmark only writes to a new database (or pass --keep-db to add to a previous benchmark DB).`);
  process.exit(1);
}

const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
const fileBytes = (p: string) => ["", "-wal", "-shm"].reduce((a, s) => a + (fs.existsSync(p + s) ? fs.statSync(p + s).size : 0), 0);

const db = openDatabase(dbPath);
// Experiment knobs (defaults = what the app uses today).
if (flag("cache-mb")) db.pragma(`cache_size = -${Number(flag("cache-mb")) * 1024}`);
if (flag("mmap-mb")) db.pragma(`mmap_size = ${Number(flag("mmap-mb")) * 1024 * 1024}`);
if (flag("sync")) db.pragma(`synchronous = ${flag("sync")!.toUpperCase()}`);
const pragmas = { cache_size: db.pragma("cache_size", { simple: true }), mmap_size: db.pragma("mmap_size", { simple: true }), synchronous: db.pragma("synchronous", { simple: true }) };
const pageSizes = () => {
  db.pragma("wal_checkpoint(TRUNCATE)");
  const rows = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all() as { name: string; bytes: number }[];
  const search = rows.filter((r) => r.name.startsWith("catalog_search")).reduce((a, r) => a + r.bytes, 0);
  const total = rows.reduce((a, r) => a + r.bytes, 0);
  return { total, search, catalog: total - search, byObject: rows };
};
const before = { ...pageSizes(), file: fileBytes(dbPath) };

let peakRss = process.memoryUsage().rss;
let peakHeap = process.memoryUsage().heapUsed;
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}, 100);

const limit = flag("limit") ? Number(flag("limit")) : 50_000;
const t0 = performance.now();
const intervals: { processed: number; seconds: number; intervalRate: number; rssMB: number }[] = [];
let lastProcessed = 0;
let lastPhases: Record<string, number> = {};
const lastStmts = new Map<string, { sql: string; ms: number; calls: number }>();
const profileIntervals: unknown[] = [];
let lastAt = t0;
const r = await runImport(db, {
  file, type: flag("type") as any, limit, batchSize: Number(flag("batch")) || undefined, deferSearch: has("defer-search"),
  logDir: fs.mkdtempSync(path.join(os.tmpdir(), "bench-logs-")),
  progressEveryMs: 10_000,
  profile: has("profile"),
  onProgress: (p) => {
    if (p.profile) {
      const ph = p.profile.phases;
      const cur = { parse: ph.parse, normalize: ph.normalize, write: ph.write, writerTotal: ph.writer.total, lookup: ph.writer.lookup, hash: ph.writer.hash, provenance: ph.writer.provenance, search: ph.writer.search };
      const d = Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Math.round(v - ((lastPhases as any)[k] ?? 0))])) as Record<string, number>;
      const stmts = p.profile.statements.map((x) => ({ sql: x.sql, ms: Math.round(x.ms - (lastStmts.get(x.sql)?.ms ?? 0)), calls: x.calls - (lastStmts.get(x.sql)?.calls ?? 0) }))
        .sort((a, b) => b.ms - a.ms).slice(0, 6);
      profileIntervals.push({ processed: p.processed, phasesMs: d, commitMs: d.write - d.writerTotal, topStatements: stmts });
      if (has("progress")) {
        console.error(`   ms this interval: parse ${d.parse} · normalize ${d.normalize} · commit+other ${d.write - d.writerTotal} · lookup ${d.lookup} · hash ${d.hash} · provenance ${d.provenance} · search ${d.search}`);
        for (const x of stmts) console.error(`   ${String(x.ms).padStart(6)} ms  ${String(x.calls).padStart(7)}×  ${x.sql}`);
      }
      lastPhases = cur;
      for (const x of p.profile.statements) lastStmts.set(x.sql, { ...x });
    }
    const now = performance.now();
    const rate = Math.round((p.processed - lastProcessed) / ((now - lastAt) / 1000));
    intervals.push({ processed: p.processed, seconds: +((now - t0) / 1000).toFixed(1), intervalRate: rate, rssMB: mb(process.memoryUsage().rss) });
    if (has("progress")) console.error(`${p.processed} records · ${rate}/s over the last interval · rss ${mb(process.memoryUsage().rss)} MB`);
    lastProcessed = p.processed; lastAt = now;
  },
});
const importMs = performance.now() - t0;
let reindexMs: number | null = null;
if (has("defer-search")) {
  const t = performance.now();
  reindexAll(db);
  reindexMs = performance.now() - t;
}
clearInterval(sampler);
const after = { ...pageSizes(), file: fileBytes(dbPath) };

// Search latency on titles and catalog numbers that exist in what was just imported.
const titles = (db.prepare("SELECT title FROM releases WHERE discogs_release_id IS NOT NULL ORDER BY random() LIMIT 50").all() as { title: string }[]).map((x) => x.title);
const catnos = (db.prepare("SELECT catalog_number FROM releases WHERE catalog_number IS NOT NULL ORDER BY random() LIMIT 50").all() as { catalog_number: string }[]).map((x) => x.catalog_number);
const latency = (qs: string[]) => {
  const ms = qs.map((q) => { const t = performance.now(); unifiedSearch(db, q, { limit: 20 }); return performance.now() - t; }).sort((a, b) => a - b);
  return ms.length ? { queries: ms.length, p50: +ms[Math.floor(ms.length * 0.5)].toFixed(2), p95: +ms[Math.floor(ms.length * 0.95)].toFixed(2), max: +ms[ms.length - 1].toFixed(2) } : null;
};

const seconds = importMs / 1000;
const report = {
  file: path.basename(file), type: r.type, limit, searchMode: r.searchMode, pragmas,
  records: { processed: r.processed, created: r.created, updated: r.updated, unchanged: r.unchanged, failed: r.failed },
  unresolved: unresolvedCounts(db),
  elapsedSeconds: +seconds.toFixed(2), recordsPerSecond: Math.round(r.processed / seconds),
  reindexSeconds: reindexMs != null ? +(reindexMs / 1000).toFixed(2) : null,
  totalWithReindexSeconds: +((importMs + (reindexMs ?? 0)) / 1000).toFixed(2),
  phasesSeconds: Object.fromEntries(Object.entries({ ...r.timings, writer: undefined }).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, +((v as number) / 1000).toFixed(2)])),
  writerPhasesSeconds: Object.fromEntries(Object.entries(r.timings.writer).map(([k, v]) => [k, +(v / 1000).toFixed(2)])),
  peakMemoryMB: { rss: mb(peakRss), heap: mb(peakHeap) },
  dumpBytesRead: r.bytesRead, dumpFileBytes: r.fileSize,
  databaseGrowthMB: { total: mb(after.total - before.total), catalogTablesAndIndexes: mb(after.catalog - before.catalog), searchIndex: mb(after.search - before.search), fileOnDisk: mb(after.file - before.file) },
  bytesPerRecord: { total: Math.round((after.total - before.total) / Math.max(1, r.created)), search: Math.round((after.search - before.search) / Math.max(1, r.created)) },
  largestObjectsMB: after.byObject.sort((a, b) => b.bytes - a.bytes).slice(0, 12).map((o) => ({ name: o.name, mb: mb(o.bytes) })),
  searchLatencyMs: { titles: latency(titles), catalogNumbers: latency(catnos) },
  intervals,
  ...(has("profile") ? { profileIntervals } : {}),
};
db.close();
console.log(JSON.stringify(report, null, 2));
if (flag("out")) fs.writeFileSync(flag("out")!, JSON.stringify(report, null, 2));
