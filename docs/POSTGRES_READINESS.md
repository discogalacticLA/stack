# PostgreSQL readiness audit: catalog subsystem

Scope: `src/db`, `src/services/{importer,search,catalog-api}`, `src/domain/{catalog,proposals}.ts`,
`src/routes/{api,entities,catalog}.ts`. Audited 2026-09-25 by reading the code and grepping it.
No PostgreSQL code was written.

## Summary

The SQL itself is mostly portable, and the SearchBackend boundary is already in the right place.
The real cost is architectural: **every database call is synchronous** (better-sqlite3). Postgres
drivers are asynchronous, so the change runs through the writer, the runner, the catalog API,
the domain functions and the routes.

| Area | Size of change |
|---|---|
| SQL dialect (upserts, IGNORE, json_each, COLLATE NOCASE, GROUP_CONCAT) | Small: about 20 statements |
| Schema | Medium: write a fresh Postgres baseline. The SQLite rebuild migrations don't port |
| Search (FTS5 → tsvector/GIN or OpenSearch) | Medium: one new `SearchBackend`, plus ranking re-tuning |
| Sync → async data access (~263 call sites, 7 transaction wrappers in scope) | **Large**: the main cost |
| Bulk first load (COPY into staging tables) | Medium: new code path, and the biggest speed win |

## POSTGRES_PORTABLE (works as is, or with trivial edits)

- **`INSERT … ON CONFLICT (…) DO UPDATE SET … = excluded.…`**: the `catalog_provenance` upsert
  is valid PostgreSQL.
- **Partial indexes**: `CREATE UNIQUE INDEX … WHERE discogs_*_id IS NOT NULL` and the
  `…_unresolved … WHERE artist_id IS NULL` indexes. PostgreSQL supports them natively.
- **`CHECK` constraints, `REFERENCES … ON DELETE SET NULL/CASCADE`, composite primary keys.**
- **Batched `IN (?, ?, …)` lookups** of up to 500 IDs work unchanged (or use `= ANY($1)`).
- **Reconciliation `UPDATE … SET fk = (SELECT …) WHERE fk IS NULL AND EXISTS (…)`** is valid. On
  Postgres it would be rewritten as `UPDATE … FROM …` for speed.
- **`COALESCE`, `CASE`, `EXISTS`, window-free aggregates** and the stale-reference repair queries.
- **Import run bookkeeping** (`catalog_import_runs`, checkpoints, error rows) is plain tables and
  updates.
- **`SearchBackend` interface** (`upsert` / `remove` / `search` / `clear`). The importer's deferred
  mode and `reindexAll()` only use this interface. A test proves reindex works with a non-SQLite
  backend.
- **Content hashing, normalisation, XML streaming and the download module**: no database
  dependency.

## SQLITE-SPECIFIC (must change)

| Construct | Where | PostgreSQL equivalent |
|---|---|---|
| `lastInsertRowid` (13 uses) | writer, proposals | `INSERT … RETURNING id`. SQLite ≥ 3.35 supports `RETURNING` too, so this can be switched **now** |
| `INSERT OR IGNORE` | writer (`external_identifiers`), 003 down | `ON CONFLICT DO NOTHING`, also valid SQLite, so it can be switched **now** |
| `WITHOUT ROWID` | `catalog_provenance` | Drop the clause (an ordinary table with a PK) |
| FTS5 virtual table, `MATCH`, `bm25()`, composite `rowid` = type·2^40 + id | `search/index.ts`, 003 | Table `(entity_type, entity_id) PK, tsv tsvector` + GIN index; `ts_rank_cd`; `unaccent` for `remove_diacritics` |
| `json_each(?)` to join ranked FTS hits | `domain/catalog.ts` | `unnest($1::bigint[]) WITH ORDINALITY` |
| `GROUP_CONCAT` | `domain/catalog.ts` | `string_agg` |
| `COLLATE NOCASE` (10 uses) | sorting and label lookup | `lower(x)`, an ICU case-insensitive collation, or `citext` |
| `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | 003 seed rows | `now()`; also move `TEXT` timestamps to `timestamptz` |
| `PRAGMA journal_mode/foreign_keys/busy_timeout/foreign_key_check` | `db/index.ts` | Not needed; FK checks are always on |
| `INDEXED BY` on scoped reconcile UPDATEs | `writer.ts` reconcile | Drop the hint. Postgres plans `col = ANY($1)` against partial indexes itself; verify with `EXPLAIN` |
| `sqlite_master`, `dbstat` | search state guard, benchmark | `information_schema`, `pg_total_relation_size` |
| `.changes` on run results | reconcile, services | `rowCount` |
| `-- foreign_keys: off` table-rebuild migrations, `RENAME COLUMN` sequences | 002, 003 and their down files | Not ported: write one baseline schema (`001_postgres_baseline.sql`) from the current SQLite schema |
| `INTEGER PRIMARY KEY` (implicit rowid alias) | all tables | `bigint GENERATED ALWAYS AS IDENTITY` |

## NEEDS ABSTRACTION (before or during the move)

1. **A `CatalogStore` / query interface that is async**, with a single place for transactions
   (`withTransaction(fn)`). Today `db.transaction(() => …)()` is called directly in the runner,
   writer, reconcile, reindex and proposals.
2. **The writer's statement cache (`this.st(sql)`)** assumes prepared statements are cheap and
   synchronous. Postgres wants multi-row `INSERT … VALUES (…),(…)` or `COPY` per child table per
   batch, rather than one statement per row. This is also where the speed-up is (see below).
3. **The search-freshness state (`search_index_state`)** is already backend-neutral. Keep it in the
   catalog database whatever search backend is used.
4. **`browseCatalog` joins FTS candidate IDs back via `json_each`.** Give `SearchBackend` a
   "candidate IDs with rank" method so the SQL side is dialect-free.
5. **Migrations runner**: SQLite `.sql` + `afterUp` hooks. Postgres needs its own migration folder
   (or a tool such as node-pg-migrate). The hook logic (normalised names, reindex) moves into scripts.

## MIGRATION RISKS

- **Async ripple.** Converting the sync call sites changes almost every catalog function signature,
  and the route handlers that call them. It's mechanical but wide. The test suite (133 tests) is the
  safety net.
- **Search behaviour changes.**
  - Ranking: FTS5 bm25 with weights 10/3/6/1 will not rank the same as `ts_rank_cd`.
  - Diacritics and tokenizing: FTS5 `unicode61 remove_diacritics 2` differs from Postgres `simple`
    configuration + `unaccent`, especially for CJK text (FTS5 tokenizes "夜明けのレコード" as one
    token; Postgres also needs care there).
  - The existing search tests (accent-insensitive, catalog number, barcode, Unicode, prefix)
    define the expected behaviour and must pass on the new backend.
- **Reservation and checkout concurrency.** SQLite gets atomicity for free from its single writer.
  On Postgres the reservation must use `SELECT … FOR UPDATE` or a conditional `UPDATE … WHERE
  status = 'available'`. Idempotent checkout keys need a unique constraint.
- **Timestamps as `TEXT`.** Comparisons currently rely on ISO-8601 string order. Convert during
  data migration and check every comparison.
- **Data move.** Copying an existing SQLite catalog to Postgres is a one-off export/COPY. For the
  Discogs catalog it's simpler to re-import from the dumps into Postgres: imports are idempotent
  and key off Discogs IDs. Internal IDs must be preserved only for rows that user data references
  (copies, wants, listings, order lines), and those can be carried over by ID.
- **Cost.** A hosted Postgres big enough for the full catalog (see size projection in
  DISCOGS_IMPORT.md) is paid infrastructure. **That needs an owner decision.**

## Measured facts that bear on the decision

**Real dump, 1M releases (owner's Mac):**
- 711/s on average; the rate decays from 3,646/s to ~470/s as the database grows to 4 GB;
- commit + WAL checkpoint was 38% of the time and row inserts 42%;
- search p95 over 200 ms;
- at this decay, the full catalog would take days on SQLite on that machine.

**Real dump, 50k releases (owner's Mac):**
- 3,155/s;
- 3,887 B/release;
- title search p50 0.5 ms;
- commit + WAL checkpoint 22% of wall time, row inserts 40%, search writes 1.6%;
- extrapolated full releases load: about 16M records, about 62 GB, about 1.5–2 h.

**Synthetic data (build environment):**

See `docs/DISCOGS_IMPORT.md` → *Benchmarks* for the full numbers.

- **Throughput.** Releases import at about 1,900/s at 50k rows and about 1,650/s by 300k rows
  (−13%). Memory stays flat at about 250 MB.
- **Where the time goes.** At 300k rows:
  - row inserts are about 41% of wall time;
  - XML parsing is about 24%;
  - commit + WAL checkpointing is about 18%, up from 11% at 50k, and growing;
  - search writes are only 1.4%.
- **Search latency.** Title search p50 went from 9 ms at 50k releases to 46 ms at 300k. The
  synthetic vocabulary is tiny, so this overstates the real-world case, but it scales with matches.
- **Single writer.** A long import batch holds the write lock for ~0.3–0.6 s. The web app's writes
  (reservations, checkouts) wait up to `busy_timeout` = 5 s. That's fine locally, and a real risk
  on a shared hosted instance.
