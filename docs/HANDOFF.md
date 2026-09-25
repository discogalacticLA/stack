# Handoff

Snapshot of where the prototype stands, for the next person (or AI assistant) picking it up.

## State

- Local prototype only. It is not production-ready and not deployed, and it has no real payments.
- Branch `claude/music-archive-marketplace-ibxhs3` in the `stack` repo.
- `npm run check` runs the typecheck and 137 vitest tests across 9 files, all passing at the time
  of writing.

## Milestones done

1. **Archive and simulated marketplace.** Catalog, moderated contributions, YouTube preview links,
   listings, reservations, checkout and orders.
2. **Unified library.** Discogs CSV and Rekordbox XML imports (preview, review, commit, undo),
   digital holdings, crates, tags and Top 5 drafts. See [IMPORTS.md](IMPORTS.md).
3. **Catalog foundation.** Migration 003 (masters and releases, the Discogs-ready schema,
   provenance and import runs, FTS search), the streaming Discogs dump importer and CLI, and the
   catalog API (`/api/v1/*`). Artist, label and company pages. See
   [DISCOGS_IMPORT.md](DISCOGS_IMPORT.md).

4. **Catalog hardening** (this milestone):
   - Fixed a stale-relationship bug: an old internal master or main-release link survived a
     Discogs change to an unimported entity. Reconcile now also repairs rows damaged earlier.
   - `--defer-search` bulk mode, with backend-neutral search-freshness state (migration 004).
   - A hardened `download`: `.part` files, Content-Length and sha256 checks, sidecars, `--url`,
     and a host allow-list.
   - XML `census` coverage audit, benchmark tooling and a synthetic realistic-shape generator.
   - Docs: [POSTGRES_READINESS.md](POSTGRES_READINESS.md), [DISCOGS_FORMAT_COVERAGE.md](DISCOGS_FORMAT_COVERAGE.md).

## Key decisions already made

- The vocabulary is **master** (shared identity) and **release** (a specific pressing). Migration
  003 renamed the old `releases`→`masters` and `editions`→`releases`, and old `/editions/:id`
  URLs redirect.
- Discogs IDs are unique nullable columns on the catalog tables. Internal IDs are the only keys
  used for references.
- Search is behind `SearchBackend`. Today that's SQLite FTS5.
- The proposal kind value `new_edition` is kept in stored data for compatibility. It means "new release".

## Not verified

- **Real Discogs CSV exports and real Rekordbox XML exports.** The mappings were built from
  community references and synthetic fixtures. The official docs were unreachable from the build
  environment.
- **Real Discogs dumps: partly validated.** The 2025-12-01 dump was checked on the owner's Mac:
  - checksums verified;
  - census of 200k artists, labels and masters, and 50k releases;
  - a 50k-release benchmark.

  One unknown structure, `release/series`, was found and is now imported (migration 005).
  Benchmarks were run up to 1M real releases (maintained indexes) and 300k (bulk mode). A full
  import has not been run yet. The exact download link
  host (data.discogs.com or S3) is still unconfirmed; the file naming and year folders are
  confirmed.
- No browser walkthrough or screenshots were produced for the latest milestone.

## Decisions needed (from the owner)

1. **Branding.** The name is **Stack** (decided 2026-09-25). Still open: logo and visual identity, and a trademark/domain check (not done).
2. **Hosting.** Options and costs are in HOSTING_OPTIONS.md: from ≈€20/month (one server, SQLite) to ≈$85–135/month (managed PostgreSQL).
3. **Imported Discogs YouTube links.** The dump's `<videos>` are stored as preview links attributed
   to the Discogs source, without local moderation. Keep this, or queue them for moderation?
4. **Checking against real exports.** The importers need a real Discogs CSV and a real Rekordbox
   XML to test. These can be private, and would be tested locally only.
5. Anything involving **live payments, paid accounts or public deployment**.

## Full-import gate

**Updated recommendation: A for a local full import on SQLite, using bulk mode. B (PostgreSQL)
before any hosting.**

- Without bulk mode, SQLite import speed on the owner's Mac decayed from 3,646/s to ~470/s over
  1M real releases.
- Profiling traced this to 36 secondary indexes on scattered values. With those deferred
  (`--bulk`), the real dump imports at a flat ~5,250/s: 300k releases in 80 s, including every
  rebuild.
- The projected full releases load is roughly 1.3–1.5 hours and ~63 GB.
- A 1M-release bulk run confirmed it: a flat 4,300–4,500/s after 300k, 427 s in total including
  all rebuilds. The estimate for a full linked `import-all --bulk` is about 2–2.5 h and ~70 GB.
- Open: search tail latency (p95 155–348 ms at 1M) needs work before the full catalog is
  searchable interactively.
- PostgreSQL is still required before hosting: single writer, paid infrastructure, concurrency.
  See POSTGRES_READINESS.md.

## Suggested next steps

1. Full `import-all --bulk` into a dedicated database file on the Mac. Then measure search latency
   on the full catalog, and improve prefix and short-term queries.
2. Validate the collection importers against real user exports.
3. Link user library holdings to catalog releases in bulk, via Discogs `release_id`, after a
   catalog import.
4. Plan the Postgres move (migrations, `SearchBackend`, COPY-based first load).

## Prompt for handing this to another assistant

> You're working on "Stack", a local TypeScript/Express/SQLite
> prototype. Read README.md, then docs/ARCHITECTURE.md, docs/DISCOGS_IMPORT.md, docs/IMPORTS.md
> and this file.
>
> Rules:
> - Never delete user data or reset the database without being asked.
> - Never weaken or remove tests.
> - No Discogs scraping, and no pricing from data we lack rights to.
> - Don't commit dumps, databases, logs or `.env` files.
> - Treat all XML and CSV as untrusted.
> - Ask before branding, paid infrastructure, public deployment or live payments.
>
> Run `npm run check` before and after changes.
