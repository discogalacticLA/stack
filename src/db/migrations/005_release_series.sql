-- 005: release series (found in the real 2025-12-01 releases dump: <series><series name catno id/></series>,
-- present on ~6.6% of releases). Discogs series share the label id space, so each entry links to a
-- label when that label is imported, and keeps its Discogs id otherwise (resolved by reconcile).
CREATE TABLE release_series (
  id                  INTEGER PRIMARY KEY,
  release_id          INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  label_id            INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  discogs_label_id    INTEGER,
  name                TEXT NOT NULL,
  catalog_number      TEXT,          -- the position in the series, e.g. "Vol. 1"
  catalog_number_norm TEXT,
  position            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX release_series_release ON release_series(release_id);
CREATE INDEX release_series_label ON release_series(label_id);
CREATE INDEX release_series_unresolved ON release_series(discogs_label_id) WHERE label_id IS NULL;
