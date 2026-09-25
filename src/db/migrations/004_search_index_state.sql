-- 004: bulk-import search mode.
-- Records whether an import run updated the search index as it went ('incremental') or skipped it
-- ('deferred'), and whether the search index is known to be behind the catalog tables.
-- The catalog tables are always authoritative; the search index can be rebuilt from them at any time.

ALTER TABLE catalog_import_runs ADD COLUMN search_mode TEXT NOT NULL DEFAULT 'incremental'
  CHECK (search_mode IN ('incremental', 'deferred'));

CREATE TABLE search_index_state (
  name            TEXT PRIMARY KEY,      -- 'catalog'
  stale_since     TEXT,                  -- NULL = in sync with the catalog tables
  stale_reason    TEXT,
  last_rebuilt_at TEXT,
  documents       INTEGER
);
INSERT INTO search_index_state (name) VALUES ('catalog');
