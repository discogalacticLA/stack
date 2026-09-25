# Architecture

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript on Node 22 (`tsx` to run, `tsc` to typecheck) | One language end to end |
| Web | Express 5, server-rendered HTML via an auto-escaping `html` tagged template | No build step; escaping by default |
| Database | SQLite (better-sqlite3, WAL) | Zero-setup local file; synchronous transactions make reservation logic simple to reason about |
| Migrations | Plain SQL files in `src/db/migrations`, optional `.down.sql`, `afterUp` hooks | Reviewable, reversible |
| Validation | zod v4 at every form/API boundary | Explicit allow-lists (no mass assignment) |
| Search | SQLite FTS5 behind a `SearchBackend` interface | Replaceable with Postgres FTS / OpenSearch later |
| XML | `saxes` (streaming, Discogs dumps), `fast-xml-parser` (Rekordbox, size-capped) | Dumps are tens of GB; Rekordbox exports are small |
| Tests | vitest + supertest | Domain, HTTP and importer tests run against a temp DB |

It's a monolith: one process, one database file.

## Layout

```
src/
  app.ts, server.ts, config.ts, context.ts
  db/            migrations, migrate(), migrateDown(), afterUp hooks and down guards
  domain/        catalog, library, listings, orders, proposals, wants, charts (business rules)
  imports/       user collection imports (Discogs CSV, Rekordbox XML): adapters, reconcile, service
  services/
    catalog-api/ read API over the catalog (artists, labels, companies, masters, releases, search)
    search/      SearchBackend + SQLite FTS5 implementation, document builders, reindex
    importer/    Discogs dump importer: stream.ts → normalize.ts → writer.ts, runner.ts, cli.ts
  routes/        HTTP routes (HTML pages and /api/v1 JSON)
  views/         layout and components
  lib/           auth, money, html escaping, uploads, clock, validation
seed/            demo data
tests/           vitest suites + fixtures (tests/fixtures/discogs: synthetic dumps)
fixtures/        synthetic Discogs CSV / Rekordbox XML user exports
```

If the project is split later, `routes` + `views` map to `apps/web`, and `services/*` and
`domain/*` become packages.

## Data model (after migration 003)

**Catalog**
- `artists` (+ `artist_aliases`, `artist_name_variations`, `artist_members`), `labels` (with parent label), `companies`
- `masters` (+ `master_artists`, `master_genres`, `master_styles`)
- `releases`, which has a nullable `master_id`, plus these child tables:
  - `release_artists`, `release_extra_artists`
  - `release_labels`, `release_companies`
  - `release_tracks`, `release_track_artists`
  - `release_formats`, `release_format_descriptions`
  - `release_identifiers`, `release_genres`, `release_styles`
- `catalog_sources`, `external_identifiers`, `catalog_provenance`, `catalog_import_runs` and `catalog_import_errors`
- `catalog_search` (FTS5, rowid = type code · 2^40 + id)
- `search_index_state` (migration 004): whether the search index is behind the catalog, e.g. after
  a `--defer-search` bulk import. Kept outside the search backend, so it works with any backend.

The Discogs IDs are stored directly as unique nullable columns (`discogs_artist_id`,
`discogs_label_id`, `discogs_master_id`, `discogs_release_id`). They are also recorded in
`external_identifiers`. Internal integer primary keys are what every other table references. A
reference to a Discogs entity that isn't imported yet is stored as NULL plus its Discogs ID
(e.g. `releases.discogs_master_id`), and `reconcileReferences()` links it later.

**Users and library**
- `users`, `user_roles`, `sessions`
- `copies` (physical, → `release_id`) and `digital_holdings` (→ `release_id`)
- `wants` (→ `master_id` or `release_id`)
- `tags`, `crates` (+ `crate_items`) and charts (Top 5)
- `source_libraries`, `source_entries`, `import_batches` and import rows (collection import bookkeeping)
- `library_items` view: physical and digital holdings side by side

**Archive**
- `proposals`, `release_revisions`, `archive_images`, `release_media_links`, `archival_sources`

**Marketplace (simulated)**
- `listings` (one active per copy, enforced by a partial unique index)
- `orders` and `order_lines`, which store snapshots of title, price and condition at purchase time

## Security measures

- **XML**: DOCTYPE is refused outright, so no DTDs, external entities or entity expansion.
  Dumps also cap depth, nodes per record and text length. Malformed XML stops the import with
  a message; batches already committed are kept.
- **CSV**: RFC 4180 parser with per-row errors and size limits. Imported values are stored as
  plain text and only ever rendered HTML-escaped. There is no CSV *export* yet. When one is
  added, it must prefix values starting with `= + - @` (formula injection).
- **SQL**: parameterised statements only; FTS input is re-tokenised, so user text never reaches
  FTS query syntax.
- **Authorisation**: every holding, crate, chart, import and order query is scoped to the owner
  (tests cover IDOR). Inputs go through zod schemas with explicit fields.
- **Web**: CSRF tokens on every POST, strict CSP (no inline scripts or styles), HttpOnly session
  cookie, auto-escaped templates.
- **Privacy**: file paths from Rekordbox and dump file paths are never shown publicly. The CLI
  prints them only to the local operator.

## Path to PostgreSQL

The detailed audit is in [POSTGRES_READINESS.md](POSTGRES_READINESS.md).

SQLite is right for a local prototype. It is the wrong choice for a hosted multi-user service
with an ~18M-release catalog. Before any hosting:

1. Port the migrations to Postgres, mostly type changes (`INTEGER PRIMARY KEY` → `bigint
   generated`, `TEXT` timestamps → `timestamptz`).
2. Replace `SqliteFtsBackend` with a Postgres `tsvector` backend (or OpenSearch) implementing the
   same `SearchBackend` interface.
3. Keep the reservation logic, but use `SELECT … FOR UPDATE` or conditional updates.
4. Make the importer write through `COPY` into staging tables for the first full load.

This needs a decision: it requires paid infrastructure once hosted.
