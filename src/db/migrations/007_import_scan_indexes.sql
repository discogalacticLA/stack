-- 007: indexes for lookups the importer made by full scan.
-- Company credits without a Discogs id are matched by exact name. Without this index that
-- lookup scanned the whole companies table once per id-less credit, so imports slowed down as the
-- table grew. Suspected cause of the slowdown on the real 2025-12-01 releases dump.
CREATE INDEX IF NOT EXISTS companies_name_without_id ON companies(name) WHERE discogs_company_id IS NULL;

-- Deleting a changed release's tracks (monthly updates) makes SQLite check the foreign keys that
-- point at release_tracks. These two had no index, so every deleted track scanned the whole of
-- release_tracks and release_extra_artists.
CREATE INDEX IF NOT EXISTS release_tracks_parent ON release_tracks(parent_track_id) WHERE parent_track_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS release_extra_artists_track ON release_extra_artists(track_id) WHERE track_id IS NOT NULL;
