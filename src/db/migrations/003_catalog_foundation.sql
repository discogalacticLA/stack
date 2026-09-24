-- foreign_keys: off
-- Migration 003: catalog foundation for Discogs dump ingestion.
--
-- Vocabulary change (see docs/ARCHITECTURE.md):
--   old `releases` (shared identity)   → `masters`
--   old `editions` (a specific issue)  → `releases`
-- Every user-owned table that pointed at an edition now has `release_id`; every pointer at the
-- old release group is now `master_id`. No rows are dropped. Reverse with 003_catalog_foundation.down.sql.
--
-- Discogs IDs are stored directly on each table (UNIQUE, nullable) AND in `external_identifiers`
-- (the general mechanism for future sources such as MusicBrainz). Internal ids stay the primary keys.

DROP VIEW IF EXISTS library_items;

-- ───────────────────────── Sources & provenance ─────────────────────────
CREATE TABLE catalog_sources (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,          -- 'discogs', 'user', 'seed', later 'musicbrainz', 'label', 'editorial' …
  type       TEXT NOT NULL,                 -- 'dump', 'submission', 'synthetic', 'api', 'editorial'
  url        TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO catalog_sources (name, type, url, created_at) VALUES
  ('discogs', 'dump', 'https://data.discogs.com/', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('user', 'submission', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('seed', 'synthetic', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE external_identifiers (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'label', 'company', 'master', 'release')),
  entity_id   INTEGER NOT NULL,
  source_id   INTEGER NOT NULL REFERENCES catalog_sources(id),
  external_id TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (source_id, entity_type, external_id)
);
CREATE INDEX external_identifiers_entity ON external_identifiers(entity_type, entity_id);

-- Which source last supplied a record, with a content hash so unchanged records can be skipped.
CREATE TABLE catalog_provenance (
  entity_type    TEXT NOT NULL,
  entity_id      INTEGER NOT NULL,
  source_id      INTEGER NOT NULL REFERENCES catalog_sources(id),
  content_hash   TEXT NOT NULL,
  import_run_id  INTEGER REFERENCES catalog_import_runs(id),
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, source_id)
) WITHOUT ROWID;

CREATE TABLE catalog_import_runs (
  id                     INTEGER PRIMARY KEY,
  source                 TEXT NOT NULL,           -- 'discogs'
  entity_type            TEXT NOT NULL CHECK (entity_type IN ('artists', 'labels', 'masters', 'releases')),
  source_version         TEXT,                    -- e.g. '20260901'
  dump_date              TEXT,                    -- '2026-09-01'
  file_name              TEXT NOT NULL,
  file_path              TEXT,
  file_hash              TEXT,                    -- sha256 of the file as read (compressed bytes)
  file_size              INTEGER,
  expected_hash          TEXT,                    -- from the published CHECKSUM file, when supplied
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  started_at             TEXT,
  completed_at           TEXT,
  records_processed      INTEGER NOT NULL DEFAULT 0,
  records_created        INTEGER NOT NULL DEFAULT 0,
  records_updated        INTEGER NOT NULL DEFAULT 0,
  records_unchanged      INTEGER NOT NULL DEFAULT 0,
  records_failed         INTEGER NOT NULL DEFAULT 0,
  records_skipped_local  INTEGER NOT NULL DEFAULT 0,   -- not overwritten because of local editorial edits
  unresolved_references  INTEGER NOT NULL DEFAULT 0,
  last_external_id       TEXT,
  checkpoint_record_index INTEGER NOT NULL DEFAULT 0,  -- records fully committed; resume skips this many
  bytes_read             INTEGER NOT NULL DEFAULT 0,
  error_log_location     TEXT,
  fatal_error            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX catalog_import_runs_status ON catalog_import_runs(entity_type, status);

CREATE TABLE catalog_import_errors (
  id             INTEGER PRIMARY KEY,
  import_run_id  INTEGER NOT NULL REFERENCES catalog_import_runs(id) ON DELETE CASCADE,
  external_id    TEXT,
  entity_type    TEXT,
  error_type     TEXT NOT NULL,        -- 'invalid_record', 'field_truncated', 'local_edit_conflict', 'unresolved_reference', 'exception'
  message        TEXT NOT NULL,
  raw_context    TEXT,                 -- bounded excerpt, never the whole record
  created_at     TEXT NOT NULL
);
CREATE INDEX catalog_import_errors_run ON catalog_import_errors(import_run_id, error_type);

-- ───────────────────────── Artists ─────────────────────────
ALTER TABLE artists ADD COLUMN discogs_artist_id INTEGER;
ALTER TABLE artists ADD COLUMN normalized_name TEXT;
ALTER TABLE artists ADD COLUMN real_name TEXT;
ALTER TABLE artists ADD COLUMN urls TEXT;              -- JSON array of URLs
ALTER TABLE artists ADD COLUMN data_quality TEXT;
ALTER TABLE artists ADD COLUMN local_edited_at TEXT;   -- editorial edits here are never overwritten by imports
ALTER TABLE artists ADD COLUMN updated_at TEXT;
UPDATE artists SET updated_at = created_at;
CREATE UNIQUE INDEX artists_discogs_id ON artists(discogs_artist_id) WHERE discogs_artist_id IS NOT NULL;
CREATE INDEX artists_normalized_name ON artists(normalized_name);

CREATE TABLE artist_aliases (
  id                INTEGER PRIMARY KEY,
  artist_id         INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  alias_artist_id   INTEGER REFERENCES artists(id) ON DELETE SET NULL,   -- resolved when the alias is also imported
  discogs_alias_id  INTEGER,
  name              TEXT NOT NULL
);
CREATE INDEX artist_aliases_artist ON artist_aliases(artist_id);

CREATE TABLE artist_name_variations (
  id        INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE INDEX artist_name_variations_artist ON artist_name_variations(artist_id);

-- Group ↔ member relationships (both directions derivable).
CREATE TABLE artist_members (
  id                INTEGER PRIMARY KEY,
  group_artist_id   INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  member_artist_id  INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  discogs_member_id INTEGER,
  name              TEXT NOT NULL
);
CREATE INDEX artist_members_group ON artist_members(group_artist_id);
CREATE INDEX artist_members_member ON artist_members(member_artist_id);

-- ───────────────────────── Labels (rebuild: names are not unique) ─────────────────────────
CREATE TABLE labels_new (
  id                     INTEGER PRIMARY KEY,
  discogs_label_id       INTEGER,
  name                   TEXT NOT NULL,
  normalized_name        TEXT,
  profile                TEXT,
  contact_info           TEXT,
  urls                   TEXT,
  parent_label_id        INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  parent_discogs_label_id INTEGER,
  data_quality           TEXT,
  local_edited_at        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
INSERT INTO labels_new (id, name, profile, created_at, updated_at) SELECT id, name, profile, created_at, created_at FROM labels;
DROP TABLE labels;
ALTER TABLE labels_new RENAME TO labels;
CREATE UNIQUE INDEX labels_discogs_id ON labels(discogs_label_id) WHERE discogs_label_id IS NOT NULL;
CREATE INDEX labels_normalized_name ON labels(normalized_name);
CREATE INDEX labels_name ON labels(name);

-- Companies: pressing plants, studios, distributors … shared across many releases.
CREATE TABLE companies (
  id                 INTEGER PRIMARY KEY,
  discogs_company_id INTEGER,          -- Discogs uses its label id space for companies
  name               TEXT NOT NULL,
  normalized_name    TEXT,
  company_type       TEXT,
  country            TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX companies_discogs_id ON companies(discogs_company_id) WHERE discogs_company_id IS NOT NULL;
CREATE INDEX companies_normalized_name ON companies(normalized_name);

-- ───────────────────────── Masters (was: releases) ─────────────────────────
ALTER TABLE releases RENAME TO masters;
ALTER TABLE masters ADD COLUMN discogs_master_id INTEGER;
ALTER TABLE masters ADD COLUMN normalized_title TEXT;
ALTER TABLE masters ADD COLUMN year INTEGER;
ALTER TABLE masters ADD COLUMN main_release_discogs_id INTEGER;
ALTER TABLE masters ADD COLUMN main_release_id INTEGER;
ALTER TABLE masters ADD COLUMN notes TEXT;
ALTER TABLE masters ADD COLUMN data_quality TEXT;
ALTER TABLE masters ADD COLUMN local_edited_at TEXT;
CREATE UNIQUE INDEX masters_discogs_id ON masters(discogs_master_id) WHERE discogs_master_id IS NOT NULL;
CREATE INDEX masters_normalized_title ON masters(normalized_title);

CREATE TABLE master_artists (
  id                INTEGER PRIMARY KEY,
  master_id         INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  artist_id         INTEGER REFERENCES artists(id) ON DELETE SET NULL,  -- NULL = not imported yet (see discogs_artist_id)
  discogs_artist_id INTEGER,
  name              TEXT NOT NULL,     -- name as known at import time
  anv               TEXT,              -- "artist name variation" used on this credit
  join_text         TEXT NOT NULL DEFAULT '',
  role              TEXT,
  position          INTEGER NOT NULL DEFAULT 0
);
INSERT INTO master_artists (master_id, artist_id, name, join_text, position)
SELECT ra.release_id, ra.artist_id, a.name, ra.join_text, ra.position FROM release_artists ra JOIN artists a ON a.id = ra.artist_id;
DROP TABLE release_artists;
CREATE INDEX master_artists_master ON master_artists(master_id, position);
CREATE INDEX master_artists_artist ON master_artists(artist_id);
CREATE INDEX master_artists_unresolved ON master_artists(discogs_artist_id) WHERE artist_id IS NULL;

CREATE TABLE master_genres (id INTEGER PRIMARY KEY, master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE, genre TEXT NOT NULL);
CREATE TABLE master_styles (id INTEGER PRIMARY KEY, master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE, style TEXT NOT NULL);
INSERT INTO master_genres (master_id, genre) SELECT release_id, term FROM release_terms WHERE kind = 'genre';
INSERT INTO master_styles (master_id, style) SELECT release_id, term FROM release_terms WHERE kind = 'style';
DROP TABLE release_terms;
CREATE INDEX master_genres_master ON master_genres(master_id);
CREATE INDEX master_genres_genre ON master_genres(genre);
CREATE INDEX master_styles_master ON master_styles(master_id);
CREATE INDEX master_styles_style ON master_styles(style);

-- ───────────────────────── Releases (was: editions) ─────────────────────────
-- Rename first so every foreign key that pointed at `editions` now points at `releases`,
-- then rebuild in place with the new column set.
ALTER TABLE editions RENAME TO releases;
CREATE TABLE releases_new (
  id                  INTEGER PRIMARY KEY,
  discogs_release_id  INTEGER,
  master_id           INTEGER REFERENCES masters(id) ON DELETE SET NULL,  -- NULL = no master (common on Discogs)
  discogs_master_id   INTEGER,            -- kept so an unresolved master can be linked later
  title               TEXT NOT NULL,
  normalized_title    TEXT,
  year                INTEGER,
  released_date       TEXT,               -- as published: '1981', '1981-05', '1981-05-10' (Discogs may use '-00')
  country             TEXT,               -- display text as published: 'Germany', 'UK', 'UK & Europe'
  status              TEXT,               -- Discogs: Accepted, Draft, Deleted, Rejected
  notes               TEXT,
  data_quality        TEXT,
  -- Denormalised "primary" values for fast display; full data lives in release_labels / release_formats.
  label_id            INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  catalog_number      TEXT,
  catalog_number_norm TEXT,
  format              TEXT NOT NULL,      -- primary format name: Vinyl, CD, Cassette, File, 8-Track Cartridge, Reel-To-Reel …
  format_details      TEXT,
  date_note           TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'sourced', 'reviewed', 'disputed')),
  local_edited_at     TEXT,               -- set when a moderator accepts a local correction
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
INSERT INTO releases_new (id, master_id, title, year, released_date, country, notes, label_id, catalog_number, catalog_number_norm, format, format_details,
  date_note, verification_status, created_by, created_at, updated_at)
SELECT e.id, e.release_id, m.title, e.release_year,
  CASE WHEN e.release_year IS NULL THEN NULL
       WHEN e.release_month IS NULL THEN CAST(e.release_year AS TEXT)
       WHEN e.release_day IS NULL THEN printf('%04d-%02d', e.release_year, e.release_month)
       ELSE printf('%04d-%02d-%02d', e.release_year, e.release_month, e.release_day) END,
  CASE e.country WHEN 'GB' THEN 'UK' WHEN 'US' THEN 'US' WHEN 'DE' THEN 'Germany' WHEN 'NL' THEN 'Netherlands' WHEN 'JP' THEN 'Japan'
    WHEN 'MX' THEN 'Mexico' WHEN 'BR' THEN 'Brazil' WHEN 'FR' THEN 'France' WHEN 'IT' THEN 'Italy' WHEN 'ES' THEN 'Spain' WHEN 'CA' THEN 'Canada'
    WHEN 'AU' THEN 'Australia' WHEN 'ZA' THEN 'South Africa' ELSE e.country END,
  e.edition_notes, e.label_id, e.catalog_number, e.catalog_number_norm, e.format, e.format_details, e.date_note, e.verification_status,
  e.created_by, e.created_at, e.updated_at
FROM releases e JOIN masters m ON m.id = e.release_id;
DROP TABLE releases;
ALTER TABLE releases_new RENAME TO releases;
CREATE UNIQUE INDEX releases_discogs_id ON releases(discogs_release_id) WHERE discogs_release_id IS NOT NULL;
CREATE INDEX releases_master ON releases(master_id);
CREATE INDEX releases_unresolved_master ON releases(discogs_master_id) WHERE master_id IS NULL AND discogs_master_id IS NOT NULL;
CREATE INDEX releases_catno ON releases(catalog_number_norm);
CREATE INDEX releases_normalized_title ON releases(normalized_title);
CREATE INDEX releases_year ON releases(year);
CREATE INDEX releases_country ON releases(country);

CREATE TABLE release_artists (
  id                INTEGER PRIMARY KEY,
  release_id        INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  artist_id         INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  discogs_artist_id INTEGER,
  name              TEXT NOT NULL,
  anv               TEXT,
  join_text         TEXT NOT NULL DEFAULT '',
  role              TEXT,
  position          INTEGER NOT NULL DEFAULT 0
);
INSERT INTO release_artists (release_id, artist_id, name, join_text, position)
SELECT r.id, ma.artist_id, ma.name, ma.join_text, ma.position FROM releases r JOIN master_artists ma ON ma.master_id = r.master_id;
CREATE INDEX release_artists_release ON release_artists(release_id, position);
CREATE INDEX release_artists_artist ON release_artists(artist_id);
CREATE INDEX release_artists_unresolved ON release_artists(discogs_artist_id) WHERE artist_id IS NULL;

-- Credits such as Producer, Mastered By, Written-By — optionally for specific tracks.
CREATE TABLE release_extra_artists (
  id                INTEGER PRIMARY KEY,
  release_id        INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  track_id          INTEGER REFERENCES release_tracks(id) ON DELETE CASCADE,  -- set for track-level credits
  artist_id         INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  discogs_artist_id INTEGER,
  name              TEXT NOT NULL,
  anv               TEXT,
  role              TEXT NOT NULL DEFAULT '',
  tracks            TEXT,              -- Discogs "tracks" text, e.g. "A1, B2"
  join_text         TEXT NOT NULL DEFAULT '',
  position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX release_extra_artists_release ON release_extra_artists(release_id);
CREATE INDEX release_extra_artists_artist ON release_extra_artists(artist_id, role);
CREATE INDEX release_extra_artists_unresolved ON release_extra_artists(discogs_artist_id) WHERE artist_id IS NULL;

CREATE TABLE release_labels (
  id                  INTEGER PRIMARY KEY,
  release_id          INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  label_id            INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  discogs_label_id    INTEGER,
  name                TEXT NOT NULL,
  catalog_number      TEXT,
  catalog_number_norm TEXT,
  position            INTEGER NOT NULL DEFAULT 0
);
INSERT INTO release_labels (release_id, label_id, name, catalog_number, catalog_number_norm)
SELECT r.id, r.label_id, l.name, r.catalog_number, r.catalog_number_norm FROM releases r JOIN labels l ON l.id = r.label_id;
CREATE INDEX release_labels_release ON release_labels(release_id);
CREATE INDEX release_labels_label ON release_labels(label_id);
CREATE INDEX release_labels_catno ON release_labels(catalog_number_norm);
CREATE INDEX release_labels_unresolved ON release_labels(discogs_label_id) WHERE label_id IS NULL;

CREATE TABLE release_companies (
  id                 INTEGER PRIMARY KEY,
  release_id         INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  company_id         INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  role               TEXT NOT NULL,     -- Discogs entity_type_name: 'Pressed By', 'Mastered At', 'Distributed By' …
  entity_type        INTEGER,           -- Discogs entity_type code
  catalog_number     TEXT,
  position           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX release_companies_release ON release_companies(release_id);
CREATE INDEX release_companies_company ON release_companies(company_id, role);

-- ───────────────────────── Tracks (was: tracks) ─────────────────────────
ALTER TABLE tracks RENAME TO release_tracks;
CREATE TABLE release_tracks_new (
  id               INTEGER PRIMARY KEY,
  release_id       INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  parent_track_id  INTEGER REFERENCES release_tracks(id) ON DELETE CASCADE,  -- sub-tracks of an index track
  track_type       TEXT NOT NULL DEFAULT 'track' CHECK (track_type IN ('track', 'index', 'heading', 'subtrack')),
  position         TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL,
  duration         TEXT,               -- as published, e.g. '6:48'
  duration_seconds INTEGER,
  artist_credit    TEXT,               -- display credit when it differs from the release credit
  recording_id     INTEGER REFERENCES recordings(id),
  sequence         INTEGER NOT NULL
);
INSERT INTO release_tracks_new (id, release_id, position, title, duration, duration_seconds, artist_credit, recording_id, sequence)
SELECT id, edition_id, position, title,
  CASE WHEN duration_seconds IS NULL THEN NULL ELSE (duration_seconds / 60) || ':' || printf('%02d', duration_seconds % 60) END,
  duration_seconds, artist_credit, recording_id, sort_order
FROM release_tracks;
DROP TABLE release_tracks;
ALTER TABLE release_tracks_new RENAME TO release_tracks;
CREATE INDEX release_tracks_release ON release_tracks(release_id, sequence);

CREATE TABLE release_track_artists (
  id                INTEGER PRIMARY KEY,
  track_id          INTEGER NOT NULL REFERENCES release_tracks(id) ON DELETE CASCADE,
  artist_id         INTEGER REFERENCES artists(id) ON DELETE SET NULL,
  discogs_artist_id INTEGER,
  name              TEXT NOT NULL,
  anv               TEXT,
  join_text         TEXT NOT NULL DEFAULT '',
  position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX release_track_artists_track ON release_track_artists(track_id);
CREATE INDEX release_track_artists_artist ON release_track_artists(artist_id);

-- ───────────────────────── Formats ─────────────────────────
CREATE TABLE release_formats (
  id         INTEGER PRIMARY KEY,
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,           -- Vinyl, CD, Cassette, File, 8-Track Cartridge, Reel-To-Reel …
  quantity   INTEGER,
  text       TEXT,                    -- free text, e.g. 'Clear'
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE release_format_descriptions (
  id          INTEGER PRIMARY KEY,
  format_id   INTEGER NOT NULL REFERENCES release_formats(id) ON DELETE CASCADE,
  description TEXT NOT NULL,          -- 12", LP, 45 RPM, Reissue, Promo …
  position    INTEGER NOT NULL DEFAULT 0
);
INSERT INTO release_formats (release_id, name, quantity, position) SELECT id, format, 1, 0 FROM releases;
CREATE INDEX release_formats_release ON release_formats(release_id);
CREATE INDEX release_formats_name ON release_formats(name);
CREATE INDEX release_format_descriptions_format ON release_format_descriptions(format_id);

-- ───────────────────────── Identifiers (was: edition_identifiers) ─────────────────────────
ALTER TABLE edition_identifiers RENAME TO release_identifiers;
CREATE TABLE release_identifiers_new (
  id               INTEGER PRIMARY KEY,
  release_id       INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  identifier_type  TEXT NOT NULL,      -- 'Barcode', 'Matrix / Runout', 'Label Code', 'Rights Society', 'Other', …
  value            TEXT NOT NULL,
  description      TEXT,
  normalized_value TEXT                -- digits/letters only, for barcode & code search
);
INSERT INTO release_identifiers_new (id, release_id, identifier_type, value, description, normalized_value)
SELECT id, edition_id,
  CASE kind WHEN 'barcode' THEN 'Barcode' WHEN 'matrix_runout' THEN 'Matrix / Runout' WHEN 'label_code' THEN 'Label Code'
    WHEN 'rights_society' THEN 'Rights Society' ELSE 'Other' END,
  value, note, upper(replace(replace(replace(value, ' ', ''), '-', ''), '.', ''))
FROM release_identifiers;
DROP TABLE release_identifiers;
ALTER TABLE release_identifiers_new RENAME TO release_identifiers;
CREATE INDEX release_identifiers_release ON release_identifiers(release_id);
CREATE INDEX release_identifiers_value ON release_identifiers(normalized_value);

-- ───────────────────────── Genres & styles (release level) ─────────────────────────
CREATE TABLE release_genres (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE, genre TEXT NOT NULL);
CREATE TABLE release_styles (id INTEGER PRIMARY KEY, release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE, style TEXT NOT NULL);
INSERT INTO release_genres (release_id, genre) SELECT r.id, mg.genre FROM releases r JOIN master_genres mg ON mg.master_id = r.master_id;
INSERT INTO release_styles (release_id, style) SELECT r.id, ms.style FROM releases r JOIN master_styles ms ON ms.master_id = r.master_id;
CREATE INDEX release_genres_release ON release_genres(release_id);
CREATE INDEX release_genres_genre ON release_genres(genre);
CREATE INDEX release_styles_release ON release_styles(release_id);
CREATE INDEX release_styles_style ON release_styles(style);

-- ───────────────────────── Archive tables that pointed at editions ─────────────────────────
ALTER TABLE archival_sources RENAME COLUMN edition_id TO release_id;
ALTER TABLE archive_images RENAME COLUMN edition_id TO release_id;
ALTER TABLE edition_media_links RENAME TO release_media_links;
ALTER TABLE release_media_links RENAME COLUMN edition_id TO release_id;
ALTER TABLE release_media_links ADD COLUMN source_id INTEGER REFERENCES catalog_sources(id);
ALTER TABLE release_media_links ADD COLUMN title TEXT;
ALTER TABLE edition_revisions RENAME TO release_revisions;
ALTER TABLE release_revisions RENAME COLUMN edition_id TO release_id;
ALTER TABLE proposals RENAME COLUMN release_id TO master_id;
ALTER TABLE proposals RENAME COLUMN target_edition_id TO target_release_id;
ALTER TABLE proposals RENAME COLUMN resulting_edition_id TO resulting_release_id;

-- ───────────────────────── User-owned tables: edition_id → release_id ─────────────────────────
-- Ownership data stays out of catalog tables; these only reference a release.
ALTER TABLE copies RENAME COLUMN edition_id TO release_id;
ALTER TABLE listings RENAME COLUMN edition_id TO release_id;
ALTER TABLE order_lines RENAME COLUMN edition_id TO release_id;
ALTER TABLE digital_holdings RENAME COLUMN edition_id TO release_id;
ALTER TABLE wants RENAME COLUMN release_id TO master_id;
ALTER TABLE wants RENAME COLUMN edition_id TO release_id;

-- ───────────────────────── Search index (SQLite FTS5; swappable backend) ─────────────────────────
-- rowid = entity type code × 2^40 + internal id, so upserts are O(log n) by rowid.
CREATE VIRTUAL TABLE catalog_search USING fts5(
  entity_type UNINDEXED, entity_id UNINDEXED, title, people, codes, extra,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ───────────────────────── Unified library view (recreated with new names) ─────────────────────────
CREATE VIEW library_items AS
SELECT
  'physical' AS item_type, c.id AS item_id, c.owner_id,
  COALESCE(c.artist_text, (SELECT group_concat(COALESCE(ra.anv, ra.name) || ra.join_text, '' ORDER BY ra.position) FROM release_artists ra WHERE ra.release_id = r.id)) AS artist,
  COALESCE(c.title_text, r.title) AS title,
  NULL AS version,
  COALESCE(c.label_text, l.name) AS label,
  COALESCE(c.catno_text, r.catalog_number) AS catno,
  COALESCE(c.format_group, CASE WHEN r.format = 'File' THEN 'Digital' WHEN r.format IN ('Vinyl', 'CD', 'Cassette') THEN r.format WHEN r.format IS NULL THEN NULL ELSE 'Other' END) AS format_group,
  COALESCE(c.format_raw, r.format || COALESCE(', ' || r.format_details, '')) AS format_raw,
  COALESCE(c.release_year, r.year) AS year,
  COALESCE(c.genre_text, (SELECT group_concat(genre, ', ' ORDER BY genre) FROM release_genres rg WHERE rg.release_id = r.id)) AS genre,
  c.date_added, c.release_id, r.master_id, c.created_by_batch_id, c.source_entry_id,
  c.media_condition, c.sleeve_condition, NULL AS bpm_x100, NULL AS musical_key, NULL AS rating, c.source_folder AS folder
FROM copies c
LEFT JOIN releases r ON r.id = c.release_id
LEFT JOIN labels l ON l.id = r.label_id
UNION ALL
SELECT
  'digital', d.id, d.owner_id, d.artist_text, d.title_text, d.version_text, d.label_text, d.catno_text,
  'Digital', COALESCE(d.file_format, 'Digital') || CASE WHEN d.granularity = 'release' THEN ' (release)' ELSE '' END,
  d.release_year, d.genre_text, d.date_added, d.release_id, r.master_id, d.created_by_batch_id, d.source_entry_id,
  NULL, NULL, d.bpm_x100, d.musical_key, d.rating, NULL
FROM digital_holdings d
LEFT JOIN releases r ON r.id = d.release_id;
