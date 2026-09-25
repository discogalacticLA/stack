-- 008: bulk-load mode. Secondary indexes on scattered values (artist/label/company ids, names,
-- codes, unresolved references) are dropped for a first large import and rebuilt once at the end.
-- Their definitions are stored here *before* they are dropped, so an interrupted load can always be
-- restored (`catalog indexes:restore`, or automatically by the next normal import).
-- Measured on the real 2025-12-01 dump: per-row insert cost into tables with such indexes tripled
-- within 80k releases, while tables with only release-ordered indexes stayed flat.
CREATE TABLE deferred_indexes (
  name        TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  sql         TEXT NOT NULL,
  run_id      INTEGER,
  dropped_at  TEXT NOT NULL
);

ALTER TABLE catalog_import_runs ADD COLUMN index_mode TEXT NOT NULL DEFAULT 'maintained'
  CHECK (index_mode IN ('maintained', 'deferred'));
