-- 006: indexes so run-scoped reconciliation can find unresolved references by Discogs id instead of
-- scanning every unresolved row. Measured on the real 2025-12-01 dump: a catalog-wide reconcile took
-- 165 s after 1M releases (14M unresolved rows), and grows with the catalog.
CREATE INDEX IF NOT EXISTS release_track_artists_unresolved ON release_track_artists(discogs_artist_id) WHERE artist_id IS NULL;
CREATE INDEX IF NOT EXISTS artist_aliases_unresolved ON artist_aliases(discogs_alias_id) WHERE alias_artist_id IS NULL;
CREATE INDEX IF NOT EXISTS artist_members_unresolved ON artist_members(discogs_member_id) WHERE member_artist_id IS NULL;
CREATE INDEX IF NOT EXISTS labels_unresolved_parent ON labels(parent_discogs_label_id) WHERE parent_label_id IS NULL;
CREATE INDEX IF NOT EXISTS masters_unresolved_main_release ON masters(main_release_discogs_id) WHERE main_release_id IS NULL;
