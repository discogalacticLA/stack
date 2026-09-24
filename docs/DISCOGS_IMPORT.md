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
npm run catalog -- import <file.xml[.gz]> [--type releases] [--batch 1000] [--limit N] [--checksum CHECKSUM.txt]
npm run catalog -- import-all data/discogs-dumps [--date 20260901]
npm run catalog -- status [runId]
npm run catalog -- errors <runId> [--limit 50]
npm run catalog -- resume <runId>
npm run catalog -- cancel <runId>          # mark an interrupted 'running' run as cancelled (resumable)
npm run catalog -- reconcile
npm run catalog -- search:reindex
npm run catalog -- verify <file> --checksum <CHECKSUM.txt>
npm run catalog -- download --date YYYYMMDD [--types artists,labels,masters,releases] [--dir data/discogs-dumps]
```

`--limit N` imports N records and stops. The run is left `cancelled`, and `resume` continues it.
It's useful for trying a real dump on a small slice.

## Importing a real dump

1. Check the latest dump date and file names at <https://data.discogs.com/>.
   The `download` command builds URLs as
   `https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data/YYYY/discogs_YYYYMMDD_<type>.xml.gz`.
   **That pattern could not be verified from the build environment.** If it has changed, download
   the files by hand into `data/discogs-dumps/`, or pass `--base <url>`.
2. Download: `npm run catalog -- download --date 20260901`
3. Verify: `npm run catalog -- verify data/discogs-dumps/discogs_20260901_releases.xml.gz --checksum data/discogs-dumps/discogs_20260901_CHECKSUM.txt`
4. Try a slice first: `npm run catalog -- import data/discogs-dumps/discogs_20260901_releases.xml.gz --limit 50000`
5. Full import: `npm run catalog -- import-all data/discogs-dumps --date 20260901`
6. If it stops for any reason: `npm run catalog -- status`, then `npm run catalog -- resume <runId>`.

**Disk and time.** The compressed releases dump alone is many GB, and it holds tens of millions of
records. On a synthetic dump of 20,000 simple releases in this environment:
- the first import ran at about 6,000 records per second;
- an unchanged re-run ran at about 14,000 records per second;
- the database grew by about 1.3 KB per release, including the search index.

Real releases have longer tracklists and more credits, so expect several hours and a very large
SQLite file (well over 100 GB for everything). This has **not been measured on a real dump**. For
the full catalog, the PostgreSQL path in ARCHITECTURE.md is recommended.

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
