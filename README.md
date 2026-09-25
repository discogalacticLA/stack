# Stack

A **local prototype** of an independent music catalog, private collection manager, DJ-library
importer, curation tool and *simulated* marketplace. It is not production-ready, has no live
payments, and is not deployed anywhere.

- **Catalog**: artists, labels, companies, masters (shared identity of a work) and releases
  (a specific pressing/edition), built to be filled from the official Discogs monthly data dumps.
- **Library**: physical copies and digital files together, imported from a Discogs collection or
  wantlist CSV, a Rekordbox XML export, or entered by hand. Private by default.
- **Curation**: crates, tags and Top 5 chart drafts.
- **Archive**: moderated contributions (new releases, corrections, images, YouTube previews).
- **Marketplace (simulated)**: listings, atomic reservations, idempotent checkout, order state machine.
  Money is stored as integer cents. No real payment provider is connected.

## Requirements

Node.js 22 or newer. No external services, API keys or accounts. The database is a local SQLite file.

## Setup

```bash
npm install
npm run migrate        # creates ./data/archive.db and applies all migrations
npm run seed           # optional demo data (refuses to touch a non-empty database)
npm run dev            # http://localhost:3000
```

Demo accounts (development only, password `demo-password`, or use the account switcher in the
header): `mara` (buyer), `sol` and `dex` (sellers), `cato` (contributor), `moss` (moderator).
The switcher is disabled server-side whenever `NODE_ENV` is not `development`.

`npm run reset` **deletes** the local database and reseeds it. Only use it on throwaway data.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Run the web app (watch mode / once) |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:down` | Revert the latest migration (refused if it would lose data) |
| `npm run seed` / `npm run reset` | Seed demo data / delete the DB and reseed |
| `npm test` | Run the test suite (vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run check` | Typecheck + tests |
| `npm run catalog -- <command>` | Catalog / Discogs dump importer CLI (see below) |
| `npm run fixtures:discogs` | Regenerate the `.gz` copies of the synthetic dump fixtures |
| `npm run fixtures:large` | Generate large synthetic collection/Rekordbox files for performance checks |

## Importing the Discogs catalog

```bash
# The synthetic fixtures (a few records each, safe to run any time):
npm run catalog -- import tests/fixtures/discogs/artists.xml.gz  --type artists
npm run catalog -- import tests/fixtures/discogs/labels.xml.gz   --type labels
npm run catalog -- import tests/fixtures/discogs/masters.xml.gz  --type masters
npm run catalog -- import tests/fixtures/discogs/releases.xml.gz --type releases
npm run catalog -- status

# A real monthly dump (large: see docs/DISCOGS_IMPORT.md first). Copy the exact links from
# https://data.discogs.com/ (the old S3 URL pattern now returns 403):
npm run catalog -- download --url "<CHECKSUM.txt link>" --url "<releases.xml.gz link>"
npm run catalog -- census data/discogs-dumps/discogs_YYYYMMDD_releases.xml.gz --limit 50000
npm run catalog -- import-all data/discogs-dumps --date YYYYMMDD --defer-search
```

Imports upsert by Discogs ID. They never truncate the catalog, can be resumed
(`npm run catalog -- resume <runId>`), and keep local edits. Details: [docs/DISCOGS_IMPORT.md](docs/DISCOGS_IMPORT.md).

## Documentation

- [docs/PRODUCT.md](docs/PRODUCT.md): what the product is, rules, what is simulated
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): stack, data model, modules, security, path to Postgres
- [docs/IMPORTS.md](docs/IMPORTS.md): Discogs CSV / Rekordbox XML collection imports
- [docs/DISCOGS_IMPORT.md](docs/DISCOGS_IMPORT.md): Discogs monthly dump importer
- [docs/DISCOGS_FORMAT_COVERAGE.md](docs/DISCOGS_FORMAT_COVERAGE.md): which dump elements are imported or ignored
- [docs/POSTGRES_READINESS.md](docs/POSTGRES_READINESS.md): what moving the catalog to PostgreSQL involves
- [docs/HOSTING_OPTIONS.md](docs/HOSTING_OPTIONS.md): hosting setups and monthly costs (for a later decision)
- [docs/HANDOFF.md](docs/HANDOFF.md): current state, open decisions, next steps

## Data and rights

- Nothing is scraped from Discogs. Only the official public data dumps (CC0 catalog data) and
  users' own exports are read. Discogs images, marketplace data, prices and user data are **not**
  in the dumps and are not assumed to be reusable.
- No pricing is derived from data we don't have rights to.
- Dumps, databases, logs and `.env` files are git-ignored.
