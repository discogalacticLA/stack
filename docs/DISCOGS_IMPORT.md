# Discogs monthly dump importer

This importer fills the catalog (artists, labels, companies, masters, releases) from the
**official Discogs data dumps**. It does no scraping and makes no API calls. Discogs publishes the
catalog data in the dumps under CC0. The dumps contain no images, marketplace listings, prices or
user data, and this project does not assume rights to any of those.

## Pipeline

```
file.xml.gz ─► stream.ts   gzip auto-detect → saxes streaming parser → one small tree per record
            ─► normalize.ts  record → typed object (RecordError = skip this record, log it)
            ─► writer.ts     batch (default 1,000 records) → one transaction of upserts
            ─► runner.ts     run bookkeeping, checkpoints, NDJSON error log, reconcile, final status
```

- **Memory stays flat.** Only the current record's tree and one batch are held in memory. The
  file is never loaded whole.
- **Upserts by Discogs ID.** New records are inserted. A changed record (different content hash)
  is updated and its child rows replaced. An unchanged record is skipped. Internal IDs never
  change, so users' copies, wants and listings keep pointing at the right release.
- **Nothing is truncated.** A new month's dump updates in place. Records absent from a newer dump
  are left as they are.
- **Local edits win.** A record edited through a moderated proposal (`local_edited_at` set) is not
  overwritten. A `local_edit_conflict` is logged for review.
- **Out-of-order references are handled.** A release that references a master, artist or label
  not imported yet stores NULL plus the Discogs ID. `reconcileReferences()` runs after every
  import (or on demand with `catalog reconcile`) and fills in the links.
- **Import order.** `import-all` runs artists → labels → masters → releases. Any order works.
  This order just leaves the fewest unresolved references.

## Safety limits

| Limit | Value | What happens |
|---|---|---|
| DOCTYPE present | always refused | Fatal before any record is read. Stops XXE and entity expansion |
| Malformed XML | fatal | Records before the error are committed; the run is marked `failed` with the message |
| Nesting depth | 32 | Fatal |
| Nodes per record | 50,000 | That record is skipped and logged as `invalid_record` |
| Text per field | 64 KB | The field is truncated and a `field_truncated` warning logged; the record is still imported |
| Record without a valid ID or required name/title | – | Skipped and logged as `invalid_record` |
| Error rows stored in DB | 10,000 per run | The rest go only to the NDJSON log |

## Run tracking

Each run creates a row in `catalog_import_runs` with:
- type, file name, dump date and version (from `discogs_YYYYMMDD_<type>.xml.gz`);
- the file's sha256 (computed while streaming) and the expected hash;
- counts: processed, created, updated, unchanged, failed, kept local edits and unresolved references;
- checkpoint record index, last Discogs ID, bytes read, and the status `running`, `completed`,
  `completed_with_errors`, `failed` or `cancelled`.

Record errors go to `catalog_import_errors` and to `data/import-logs/catalog-run-<id>.ndjson`.

**Resume.** `resume <runId>` re-streams the file and skips records up to the checkpoint. Every
batch commits its checkpoint in the same transaction as its records, so resuming never
double-applies anything. Upserts are idempotent anyway.

## Commands

```bash
npm run catalog -- import <file.xml[.gz]> [--type releases] [--batch 1000] [--limit N] [--checksum CHECKSUM.txt] [--defer-search]
npm run catalog -- import-all data/discogs-dumps [--date 20260901] [--defer-search]
npm run catalog -- status [runId]          # also shows whether the search index is stale
npm run catalog -- errors <runId> [--limit 50]
npm run catalog -- resume <runId>          # keeps the run's search mode
npm run catalog -- cancel <runId>          # mark an interrupted 'running' run as cancelled (resumable)
npm run catalog -- reconcile               # also reports inconsistent id/FK pairs (should be 0)
npm run catalog -- search:reindex
npm run catalog -- verify <file> --checksum <CHECKSUM.txt>
npm run catalog -- census <file> [--type releases] [--limit 50000] [--json out.json]
npm run catalog -- download --url <link> [--url <link> …] [--dir data/discogs-dumps]
npm run catalog -- download --date YYYYMMDD [--types artists,labels,masters,releases] [--base URL]
```

`--limit N` imports N records and stops. The run is left `cancelled`, and `resume` continues it.

### Search modes

- **Default (incremental).** Every batch updates the search index. Use this for monthly updates.
- **`--defer-search` (bulk load).**
  - Catalog rows are written without search-index updates. The catalog tables stay authoritative.
  - The index is marked stale (`search_index_state`), and `status` says so.
  - `import-all --defer-search` reconciles references and rebuilds the index **once** after all
    runs finish.
  - After a single `import --defer-search`, run `search:reindex` yourself.
  - A deferred run that is interrupted leaves the stale mark set, and its resume stays deferred.
  - The mode works through the `SearchBackend` interface only, so a future Postgres or
    OpenSearch backend behaves the same.

Measured effect (below): search writes are only ~1–2% of import time at 50k–300k records, so
deferring saves little at this scale. It exists for the first full load, when index merges grow.

### Relationship consistency

Paired columns always agree:
- `releases.discogs_master_id` / `master_id`
- `masters.main_release_discogs_id` / `main_release_id`
- `labels.parent_discogs_label_id` / `parent_label_id`

When Discogs changes or removes a relationship, the internal link is replaced or cleared, **never
kept**. If the new target isn't imported yet, the link is `NULL` until reconciliation connects it.
Every reconcile first repairs any row whose link disagrees with its Discogs ID (rows with local
edits are left alone). `staleReferenceCounts()` must be 0.

## Downloading dumps

**Status (2026-09-25): the download location is NOT verified.**

- `https://data.discogs.com/` is the official dump page. The build environment's network policy
  blocked it.
- The historical direct-S3 location
  (`https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data/YYYY/discogs_YYYYMMDD_<type>.xml.gz`)
  returns **403 AccessDenied** for every key tried, 2023–2026 and including `index.html`. A Discogs
  forum thread from 2026 reports the same, with users pointed to data.discogs.com.

So:
1. Open https://data.discogs.com/ in a browser. Note the latest dump date and copy the exact links.
2. `npm run catalog -- download --url "<CHECKSUM link>" --url "<labels link>"` (repeat `--url` as needed).
   `--date` with `--base <url>` (or `DISCOGS_DUMP_BASE_URL`) also works if the links follow
   `{base}/{YYYY}/discogs_{date}_{type}.xml.gz`.

What the download command guarantees (all tested):
- It streams to `<name>.part` and renames only after the byte count matches `Content-Length` (when
  sent) and the sha256 matches CHECKSUM.txt (when downloaded alongside). A truncated or
  interrupted file never gets the real name.
- A checksum mismatch saves the file as `<name>.corrupt` and stops with both hashes.
- Verified files get a `<name>.sha256` sidecar. They're skipped on later runs without re-hashing.
- An existing file that fails verification is set aside as `.corrupt` and downloaded again.
- CHECKSUM.txt is re-fetched each time. A failed re-fetch keeps the old copy.
- Only `https` on `*.discogs.com` or the `discogs-data-dumps` S3 bucket is accepted, redirects
  included. Local file names must be official dump names, since no path from a URL is trusted.
- HTTP 403 or 404 explains what to do next. Content-Length is reported.

Behind a proxy, Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node 22+).

## Importing a real dump (validation first)

```bash
# 1. Structure audit (reads only)
npm run catalog -- census data/discogs-dumps/discogs_YYYYMMDD_releases.xml.gz --limit 50000 --json data/census-releases.json
# 2. Benchmark a 50k slice into a throwaway DB, both search modes
npx tsx scripts/benchmark-import.ts --file data/discogs-dumps/discogs_YYYYMMDD_releases.xml.gz --limit 50000 --db data/bench-inc.db --out data/bench-inc.json
npx tsx scripts/benchmark-import.ts --file data/discogs-dumps/discogs_YYYYMMDD_releases.xml.gz --limit 50000 --db data/bench-def.db --defer-search --out data/bench-def.json
# 3. Only then, into the working DB
npm run catalog -- import-all data/discogs-dumps --date YYYYMMDD --defer-search
```

## Benchmarks

### Real dump: `discogs_20251201_releases.xml.gz`, first 50,000 releases

Run on the owner's MacBook Pro (Node 24) into a fresh database, releases only, with no artists,
labels or masters imported, so every master link is unresolved.

| Measurement | Incremental search |
|---|---|
| Records | 50,000 created, 0 failed |
| Rate | **3,155/s** (3,615/s in the first 10 s, 2,320/s in the final 5.6 s) |
| Wall time | 15.8 s |

| Phase | Time | Share of wall time |
|---|---|---|
| XML parsing and gunzip | 2.97 s | 19% |
| Normalising | 0.73 s | 5% |
| Write | 11.51 s | 73% |
| ↳ relationship lookups | 0.19 s | |
| ↳ content hashing | 0.91 s | |
| ↳ provenance | 0.33 s | |
| ↳ search index | 0.26 s | 1.6% |
| ↳ row inserts | ≈6.4 s | 40% |
| ↳ commit and WAL checkpoint | ≈3.5 s | 22% |
| Reconcile | 0.64 s | |

| Other measurements | Value |
|---|---|
| Peak memory | 381 MB RSS |
| Database growth | 185.3 MB (3,887 B/release), of which search index 19.7 MB (412 B/release) |
| Largest tables | extra artists 18.8 MB, releases 18.6 MB, tracks 14.5 MB, video links 14.4 MB, identifiers 10.6 MB |
| Search latency | titles p50 0.5 ms / p95 4.4 ms; catalog numbers p50 0.3 ms / p95 9.0 ms |
| Unresolved (expected without the other dumps) | 50,000 master links, 55,447 artist credits, 343,050 extra-artist credits, 79,433 track-artist credits, 59,292 labels |

50,000 records used 34.6 MB of the 10.96 GB compressed file. Extrapolating gives roughly 16 million
releases, about 62 GB for releases alone at 3.9 KB each, and about 1.5–2 hours at the measured
rates. This is **an extrapolation**: early records (low IDs) may not be representative, and
slowdown beyond 50k real rows hasn't been measured.

### Real dump: first 1,000,000 releases (owner's Mac, incremental search)

| Measurement | Value |
|---|---|
| Records | 1,000,000 created, 0 failed |
| Average rate | **711/s**; wall time 1,407 s (23.5 min) |
| Database | 3,958.8 MB (4,151 B/release), of which search index 352.7 MB |
| Peak memory | 414 MB RSS (flat) |
| Title search | p50 2.9 ms, p95 223 ms, max 356 ms |
| Catalog-number search | p50 2.1 ms, p95 210 ms, max 353 ms |

**Rate as the catalog grew:**

| Rows so far | 0 | 150k | 330k | 600k | 1M |
|---|---|---|---|---|---|
| Rate | 3,646/s | ~2,000/s | ~1,000/s | ~650/s | ~470/s |

**Where the time went:**

| Part | Time | Share |
|---|---|---|
| XML parsing and gunzip | 60 s | 4% |
| Normalising | 14 s | 1% |
| Row inserts | ≈585 s | 42% |
| Commit and WAL checkpoint | ≈540 s | 38% |
| Reconcile | 165 s | 12% |
| Lookups, hashing, provenance and search together | 43 s | 3% |

**Unresolved without the other dumps:**
- 1,000,000 master links;
- 1,123,098 artist credits, 9,747,966 extra-artist credits and 2,129,733 track-artist credits;
- 1,211,272 labels and 69,708 series.

**Findings:**
1. **Throughput decays roughly in inverse proportion to database size.** That rules out a full
   ~16M-release load on this setup: it would take days. The same 300k test in the build
   environment, with a realistic Discogs ID spread, did **not** degrade (1,844 → 1,762/s). So the
   decay depends on the machine (storage and fsync behaviour, page cache, possibly power
   settings) or on the real record shape. The next measurement (below) tests the SQLite cache and
   sync settings on the Mac itself.
2. **Reconcile scanned every unresolved row in the catalog on every run** (14M rows at 1M
   releases). **Fixed.** Each run now records the Discogs IDs it wrote (`temp.reconcile_scope`)
   and links only rows that point at them, pinned to the unresolved-reference indexes
   (migration 006).
   - References to entities from earlier runs were already resolved when the rows were written,
     so scoped linking is complete for a normal run. A test proves it gives the same result as a
     full reconcile.
   - Resumed runs, and `catalog reconcile`, still run the full version, which includes stale-link
     repair.
   - In the build environment's 300k test, reconcile went from 2.6 s to 1.1 s; the remainder is
     the unresolved count. The releases run no longer rescans at all. The cost is about 5% slower
     writes from the extra partial indexes.
3. **Search tail latency grows** (p95 over 200 ms at 1M), although the medians stay low.

Next measurement on the Mac, the same 300k slice with a large SQLite page cache and
`synchronous=NORMAL`:

```bash
npx tsx scripts/benchmark-import.ts --file ~/Downloads/discogs_20251201_releases.xml.gz --limit 300000 --db data/bench-300k-tuned.db --cache-mb 1024 --sync normal --progress --out data/bench-300k-tuned.json
```

Compare it with the 1M run's rate at 300k (~1,250/s).

### Synthetic data

**All numbers below are from SYNTHETIC data** (`scripts/synthetic-discogs-dump.ts`), not a real
dump. The generator models a plausible record shape:
- 2–18 tracks, some with sub-tracks;
- 0–8 extra artists;
- 0–5 companies and 0–5 identifiers;
- videos on 40% of records.

The environment was 4 vCPU (Xeon 2.1 GHz), 16 GB RAM, local disk. Releases were imported with no
artists, labels or masters present, so references stay unresolved, as in a releases-first load.

| Run | Records | Rate | Wall | Parse+gunzip | Normalise | Write | Reconcile | Reindex |
|---|---|---|---|---|---|---|---|---|
| 50k, incremental | 50,000 new | 1,889/s | 26.5 s | 7.4 s | 2.0 s | 16.7 s | 0.4 s | – |
| 50k, `--defer-search` | 50,000 new | 1,914/s | 26.1 s | 7.5 s | 2.0 s | 16.2 s | 0.4 s | 1.5 s (total 27.6 s) |
| 50k re-run, unchanged | 50,000 unchanged | 4,167/s | 12.0 s | 7.4 s | 2.0 s | 2.2 s | 0.4 s | – |
| 300k, incremental | 300,000 new | 1,677/s | 178.9 s | 43.5 s | 11.0 s | 121.8 s | 2.5 s | – |

How the write time for the 300k run (121.8 s) breaks down:

| Part | Time |
|---|---|
| Relationship lookups | 0.8 s |
| Content hashing | 10.3 s |
| Provenance and external IDs | 3.9 s |
| Search index | 2.6 s |
| Row inserts and child rows | ≈72.6 s |
| Transaction commit and WAL checkpoint (outside the writer) | ≈31.7 s |

| Other measurements | 50k | 300k |
|---|---|---|
| Rate over time | 1,900/s | ~1,650/s (−13%) |
| Peak memory (RSS) | 254 MB | 249 MB (flat) |
| Database growth | 171.6 MB (3,600 B/release) | 1,051.7 MB (3,676 B/release) |
| of which search index | 19.4 MB (407 B/release) | 117.5 MB (411 B/release) |
| Title search p50 / p95 | 9.1 / 15.0 ms | 46.4 / 71.3 ms |
| Catalog-number search p50 / p95 | 1.6 / 2.2 ms | 6.5 / 11.3 ms |

What this shows:
- **Main costs, as a share of wall time.**

  | Cost | 50k | 300k |
  |---|---|---|
  | Row inserts and child rows | 41% | 41% |
  | XML parsing and gunzip | 28% | 24% |
  | Commit and WAL checkpoint | 11% | 18% |
  | Normalising | 8% | 6% |
  | Content hashing | 6% | 6% |
  | Provenance | 2% | 2% |
  | Search index | 1.5% | 1.4% |
  | Lookups | <1% | <1% |

  The commit/checkpoint share is the part that grows with database size.
- **Re-runs.** On unchanged records, parsing dominates (61%).
- **Deferred search** doesn't meaningfully help at 50k–300k.
- **Title search latency grows faster than the data.** The synthetic vocabulary is only 18 words,
  so almost every title query matches a large share of records; real data should do better. It
  still needs checking at scale.
- **Full catalog projection.** Assume the synthetic shape holds, and roughly 18 million releases
  (Discogs' public figure, not confirmed from a dump). Then the releases load is at least ~3 hours
  at ≥1,650/s, and the releases tables need ~65–70 GB. Degradation beyond 300k rows is not
  measured.

## Mapping

| Dump element | Tables |
|---|---|
| `<artist>` | `artists`, `artist_aliases`, `artist_name_variations`, `artist_members` |
| `<label>` | `labels` (parent via `parentLabel`); sublabels come from their own records |
| `<master>` | `masters`, `master_artists`, `master_genres`, `master_styles`; main release linked by ID |
| `<release>` | `releases` + `release_artists`, `release_extra_artists`, `release_labels`, `release_companies` (→ `companies`), `release_tracks` (track / index / heading / sub-track), `release_track_artists`, `release_formats`, `release_format_descriptions`, `release_identifiers`, `release_genres`, `release_styles`; YouTube `<videos>` → `release_media_links` |
| every record | `external_identifiers`, `catalog_provenance`, `catalog_search` |

Images in the dumps are only references, and are not imported.

## Fixtures

`tests/fixtures/discogs/` holds synthetic files that cover every edge case above (see its
README). Regenerate the `.gz` copies with `npm run fixtures:discogs`.
