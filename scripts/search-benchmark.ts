/**
 * Search latency benchmark. Opens an existing catalog database READ-ONLY and times realistic
 * queries through the real code paths (the /search box and /discover browse), plus alternative
 * FTS query styles, so search changes are decided on measured numbers from the full catalog.
 *
 *   npx tsx scripts/search-benchmark.ts --db data/catalog-full.db [--reps 5] [--cap 200000] \
 *     [--only current] [--skip-browse] [--out data/search-bench.json]
 *
 * For each query it reports: how many index entries match (counted up to --cap), and the p50 / max
 * latency over --reps runs (after one cold run, reported separately) for:
 *   - search:   SearchBackend.search, all types, limit 40 (what the /search page asks for)
 *   - unified:  unifiedSearch, limit 40 (search + loading each result row)
 *   - browse:   browseCatalog page 1 (what /discover and /api/search do; up to 5000 candidates)
 *   - unranked: the same MATCH with LIMIT 40 and no bm25 ORDER BY, which separates the cost of
 *               finding matches from the cost of ranking all of them
 * and, per FTS query style (--only to pick one), the search timing with that style's MATCH string.
 *
 * Safety: the database is opened with readonly + fileMustExist and no migrations run.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { ftsQuery, ENTITY_CODES } from "../src/services/search/index.js";
import { searchBackend } from "../src/services/search/index.js";
import { unifiedSearch } from "../src/services/catalog-api/index.js";
import { browseCatalog, type SearchParams } from "../src/domain/catalog.js";
import { normalizeCode } from "../src/services/catalog-api/normalize.js";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (k: string) => args.includes(`--${k}`);
const dbPath = flag("db") ?? process.env.DATABASE_PATH;
if (!dbPath || !fs.existsSync(dbPath)) {
  console.error("Usage: npx tsx scripts/search-benchmark.ts --db <existing catalog.db> [--reps 5] [--cap 200000] [--only <style>] [--skip-browse] [--out file.json]");
  process.exit(1);
}
const reps = Math.max(1, Number(flag("reps") ?? 5));
const cap = Math.max(1000, Number(flag("cap") ?? 200000));
const only = flag("only");
const out = flag("out");

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");

// ───────────────────────── Query styles under comparison ─────────────────────────
const clean = (q: string) => q.normalize("NFKC").split(/\s+/).map((w) => w.replace(/["*^():{}[\]\\]/g, "")).filter(Boolean).slice(0, 12);
const codeAlt = (w: string) => { const c = normalizeCode(w); return c && c.length >= 3 && c !== w.toUpperCase() ? `"${c.toLowerCase()}"*` : null; };
const join = (parts: string[][]) => parts.map((a) => (a.length > 1 ? `(${a.join(" OR ")})` : a[0])).join(" AND ");

const STYLES: Record<string, (q: string) => string | null> = {
  // What the app does today.
  current: ftsQuery,
  // Prefix only on the last word, and only once it has 3+ characters.
  prefix3: (q) => { const w = clean(q); if (!w.length) return null; return join(w.map((x, i) => { const a = [`"${x}"${i === w.length - 1 && x.length >= 3 ? "*" : ""}`]; const c = codeAlt(x); if (c) a.push(c); return a; })); },
  // No prefix matching at all (code alternatives stay exact too).
  exact: (q) => { const w = clean(q); if (!w.length) return null; return join(w.map((x) => { const a = [`"${x}"`]; const c = codeAlt(x); if (c) a.push(c.replace(/\*$/, "")); return a; })); },
};
const styleNames = only ? [only] : Object.keys(STYLES);
if (only && !STYLES[only]) { console.error(`Unknown --only ${only}. Styles: ${Object.keys(STYLES).join(", ")}`); process.exit(1); }

// ───────────────────────── Queries ─────────────────────────
type Q = { kind: string; q: string };
const queries: Q[] = [
  { kind: "common word", q: "the" },
  { kind: "common word", q: "love" },
  { kind: "common word", q: "live" },
  { kind: "common word", q: "remix" },
  { kind: "short prefix", q: "a" },
  { kind: "short prefix", q: "da" },
  { kind: "short prefix", q: "joh" },
  { kind: "typing", q: "daft p" },
  { kind: "typing", q: "the beat" },
  { kind: "artist", q: "aphex twin" },
  { kind: "artist", q: "daft punk" },
  { kind: "artist", q: "the beatles" },
  { kind: "artist", q: "miles davis" },
  { kind: "artist", q: "björk" },
  { kind: "title", q: "blue monday" },
  { kind: "title", q: "kind of blue" },
  { kind: "title", q: "selected ambient works" },
  { kind: "artist + title", q: "new order blue monday" },
  { kind: "catalog number", q: "WARP LP 30" },
  { kind: "catalog number", q: "FACT 73" },
  { kind: "no match", q: "zzqxjvw" },
];

// Real catalog numbers and barcodes, picked by random rowid probes (no table scans).
function sample(sql: string, maxSql: string, n: number): string[] {
  const max = (db.prepare(maxSql).get() as { m: number | null }).m ?? 0;
  const got: string[] = [];
  const stmt = db.prepare(sql);
  for (let i = 0; i < n * 5 && got.length < n && max > 0; i++) {
    const row = stmt.get(Math.floor(Math.random() * max)) as { v: string } | undefined;
    if (row?.v && !got.includes(row.v)) got.push(row.v);
  }
  return got;
}
for (const v of sample("SELECT catalog_number AS v FROM releases WHERE id >= ? AND catalog_number IS NOT NULL AND catalog_number <> '' AND upper(catalog_number) <> 'NONE' LIMIT 1", "SELECT max(id) AS m FROM releases", 3)) queries.push({ kind: "catalog number (sampled)", q: v });
for (const v of sample("SELECT value AS v FROM release_identifiers WHERE rowid >= ? AND identifier_type = 'Barcode' AND length(value) >= 8 LIMIT 1", "SELECT max(rowid) AS m FROM release_identifiers", 3)) queries.push({ kind: "barcode (sampled)", q: v });

// ───────────────────────── Timing helpers ─────────────────────────
const now = () => Number(process.hrtime.bigint()) / 1e6;
function time(fn: () => unknown) {
  const t0 = now(); fn(); const cold = now() - t0;
  const runs: number[] = [];
  for (let i = 0; i < reps; i++) { const t = now(); fn(); runs.push(now() - t); }
  runs.sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { cold_ms: r(cold), p50_ms: r(runs[Math.floor((runs.length - 1) / 2)]), max_ms: r(runs[runs.length - 1]) };
}

const allRanges = Object.values(ENTITY_CODES).map((c) => `(rowid BETWEEN ${c * 2 ** 40} AND ${(c + 1) * 2 ** 40 - 1})`).join(" OR ");
const countStmt = db.prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ? LIMIT ${cap})`);
const rankedStmt = db.prepare(`SELECT rowid FROM catalog_search WHERE catalog_search MATCH ? AND (${allRanges}) ORDER BY bm25(catalog_search, 0, 0, 10.0, 3.0, 6.0, 1.0) LIMIT 40`);
const unrankedStmt = db.prepare(`SELECT rowid FROM catalog_search WHERE catalog_search MATCH ? AND (${allRanges}) LIMIT 40`);
const backend = searchBackend(db);
const browseParams = (q: string): SearchParams => ({ q, terms: [], termMode: "any", formats: [], countries: [], yearFrom: null, yearTo: null, forSale: false, sort: "relevance", page: 1, pageSize: 24 });

const docs = (db.prepare("SELECT documents FROM search_index_state WHERE name = 'catalog'").get() as { documents: number | null } | undefined)?.documents ?? null;
console.log(`Database: ${dbPath} (read-only). Search documents: ${docs ?? "unknown"}. Reps: ${reps}. Match count cap: ${cap}.`);

const results: any[] = [];
for (const { kind, q } of queries) {
  const row: any = { kind, q, styles: {} };
  const cur = ftsQuery(q);
  row.match_current = cur;
  row.matches = cur ? Math.min(cap, (countStmt.get(cur) as { n: number }).n) : 0;
  row.matches_capped = row.matches >= cap;
  row.search = time(() => backend.search(q, { limit: 40 }));
  row.unified = time(() => unifiedSearch(db, q, { limit: 40 }));
  if (cur) row.unranked = time(() => unrankedStmt.all(cur));
  if (!has("skip-browse")) row.browse = time(() => browseCatalog(db, browseParams(q)));
  for (const s of styleNames) {
    const m = STYLES[s](q);
    if (!m) continue;
    row.styles[s] = { match: m, matches: Math.min(cap, (countStmt.get(m) as { n: number }).n), ...time(() => rankedStmt.all(m)) };
  }
  results.push(row);
  const styleSummary = styleNames.map((s) => row.styles[s] ? `${s} ${row.styles[s].p50_ms}ms/${row.styles[s].matches}` : "").filter(Boolean).join("  ");
  console.log(`${kind.padEnd(24)} ${JSON.stringify(q).padEnd(26)} matches ${String(row.matches).padStart(7)}${row.matches_capped ? "+" : " "}  search ${row.search.p50_ms}ms (cold ${row.search.cold_ms})  unified ${row.unified.p50_ms}ms  unranked ${row.unranked?.p50_ms ?? "-"}ms  browse ${row.browse?.p50_ms ?? "-"}ms  | ${styleSummary}`);
}

const p = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null; };
const summarize = (key: string) => { const xs = results.map((r) => r[key]?.p50_ms).filter((x) => x != null); return { p50_ms: p(xs, 0.5), p95_ms: p(xs, 0.95), max_ms: p(xs, 1) }; };
const summary = {
  database: dbPath, documents: docs, reps, cap, queries: results.length, node: process.version,
  sqlite: (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v,
  search: summarize("search"), unified: summarize("unified"), unranked: summarize("unranked"), browse: summarize("browse"),
  styles: Object.fromEntries(styleNames.map((s) => { const xs = results.map((r) => r.styles[s]?.p50_ms).filter((x) => x != null); return [s, { p50_ms: p(xs, 0.5), p95_ms: p(xs, 0.95), max_ms: p(xs, 1) }]; })),
};
console.log("\nSummary (per-query p50s, then percentiles across queries):");
console.log(JSON.stringify(summary, null, 2));
if (out) { fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2)); console.log(`Wrote ${out}`); }
db.close();
