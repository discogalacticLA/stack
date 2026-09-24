# Handoff

Snapshot of where the prototype stands, for the next person (or AI assistant) picking it up.

## State

- Local prototype only. It is not production-ready and not deployed, and it has no real payments.
- Branch `claude/music-archive-marketplace-ibxhs3` in the `stack` repo.
- `npm run check` runs the typecheck and 107 vitest tests across 7 files, all passing at the time
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
- **Real Discogs dumps.** Their size, speed, exact element variants and the S3 URL pattern used by
  `catalog download` are all untested.
- No browser walkthrough or screenshots were produced for the latest milestone.

## Decisions needed (from the owner)

1. **Permanent name and branding.** "Music Library Project" is temporary.
2. **PostgreSQL before any hosting.** This means paid infrastructure; see ARCHITECTURE.md.
3. **Imported Discogs YouTube links.** The dump's `<videos>` are stored as preview links attributed
   to the Discogs source, without local moderation. Keep this, or queue them for moderation?
4. **Checking against real exports.** The importers need a real Discogs CSV and a real Rekordbox
   XML to test. These can be private, and would be tested locally only.
5. Anything involving **live payments, paid accounts or public deployment**.

## Suggested next steps

1. Run a `--limit 50000` slice of a real releases dump, then compare field coverage and speed.
2. Validate the collection importers against real user exports.
3. Link user library holdings to catalog releases in bulk, via Discogs `release_id`, after a
   catalog import.
4. Plan the Postgres move (migrations, `SearchBackend`, COPY-based first load).

## Prompt for handing this to another assistant

> You're working on "Music Library Project" (temporary name), a local TypeScript/Express/SQLite
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
