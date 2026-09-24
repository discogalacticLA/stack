-- foreign_keys: off
-- Reverses 003_catalog_foundation.sql. The migration runner refuses to run this while the catalog
-- holds data the old schema cannot represent (see src/db/hooks.ts guard for 003), so nothing is
-- silently discarded: Discogs-only detail tables are dropped only when they are empty of imported data.

DROP VIEW IF EXISTS library_items;
DROP TABLE IF EXISTS catalog_search;

-- User-owned tables back to edition_id.
ALTER TABLE wants RENAME COLUMN release_id TO edition_id;
ALTER TABLE wants RENAME COLUMN master_id TO release_id;
ALTER TABLE digital_holdings RENAME COLUMN release_id TO edition_id;
ALTER TABLE order_lines RENAME COLUMN release_id TO edition_id;
ALTER TABLE listings RENAME COLUMN release_id TO edition_id;
ALTER TABLE copies RENAME COLUMN release_id TO edition_id;

ALTER TABLE proposals RENAME COLUMN resulting_release_id TO resulting_edition_id;
ALTER TABLE proposals RENAME COLUMN target_release_id TO target_edition_id;
ALTER TABLE proposals RENAME COLUMN master_id TO release_id;
ALTER TABLE release_revisions RENAME COLUMN release_id TO edition_id;
ALTER TABLE release_revisions RENAME TO edition_revisions;
ALTER TABLE release_media_links DROP COLUMN title;
ALTER TABLE release_media_links DROP COLUMN source_id;
ALTER TABLE release_media_links RENAME COLUMN release_id TO edition_id;
ALTER TABLE release_media_links RENAME TO edition_media_links;
ALTER TABLE archive_images RENAME COLUMN release_id TO edition_id;
ALTER TABLE archival_sources RENAME COLUMN release_id TO edition_id;

-- Releases → editions. Rename first so every foreign key that says `releases` follows to `editions`, then rebuild in place.
ALTER TABLE releases RENAME TO editions;
CREATE TABLE editions_old (
  id                  INTEGER PRIMARY KEY,
  release_id          INTEGER NOT NULL REFERENCES masters(id),
  label_id            INTEGER REFERENCES labels(id),
  catalog_number      TEXT,
  catalog_number_norm TEXT,
  format              TEXT NOT NULL,
  format_details      TEXT,
  country             TEXT,
  release_year        INTEGER,
  release_month       INTEGER,
  release_day         INTEGER,
  date_note           TEXT,
  edition_notes       TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'sourced', 'reviewed', 'disputed')),
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
INSERT INTO editions_old (id, release_id, label_id, catalog_number, catalog_number_norm, format, format_details, country, release_year, release_month,
  release_day, date_note, edition_notes, verification_status, created_by, created_at, updated_at)
SELECT id, master_id, label_id, catalog_number, catalog_number_norm, format, format_details,
  CASE country WHEN 'UK' THEN 'GB' WHEN 'US' THEN 'US' WHEN 'Germany' THEN 'DE' WHEN 'Netherlands' THEN 'NL' WHEN 'Japan' THEN 'JP' WHEN 'Mexico' THEN 'MX'
    WHEN 'Brazil' THEN 'BR' WHEN 'France' THEN 'FR' WHEN 'Italy' THEN 'IT' WHEN 'Spain' THEN 'ES' WHEN 'Canada' THEN 'CA' WHEN 'Australia' THEN 'AU'
    WHEN 'South Africa' THEN 'ZA' ELSE country END,
  year,
  CASE WHEN length(released_date) >= 7 AND substr(released_date, 6, 2) != '00' THEN CAST(substr(released_date, 6, 2) AS INTEGER) END,
  CASE WHEN length(released_date) >= 10 AND substr(released_date, 9, 2) != '00' THEN CAST(substr(released_date, 9, 2) AS INTEGER) END,
  date_note, notes, verification_status, created_by, created_at, updated_at
FROM editions;
DROP TABLE editions;
ALTER TABLE editions_old RENAME TO editions;
CREATE INDEX editions_release ON editions(release_id);
CREATE INDEX editions_catno ON editions(catalog_number_norm);

-- Identifiers.
CREATE TABLE edition_identifiers (
  id         INTEGER PRIMARY KEY,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('barcode', 'matrix_runout', 'label_code', 'rights_society', 'other')),
  value      TEXT NOT NULL,
  note       TEXT
);
INSERT INTO edition_identifiers (id, edition_id, kind, value, note)
SELECT id, release_id,
  CASE identifier_type WHEN 'Barcode' THEN 'barcode' WHEN 'Matrix / Runout' THEN 'matrix_runout' WHEN 'Label Code' THEN 'label_code'
    WHEN 'Rights Society' THEN 'rights_society' ELSE 'other' END,
  value, CASE WHEN identifier_type IN ('Barcode', 'Matrix / Runout', 'Label Code', 'Rights Society', 'Other') THEN description
    ELSE trim(identifier_type || COALESCE(': ' || description, '')) END
FROM release_identifiers;
DROP TABLE release_identifiers;
CREATE INDEX identifiers_edition ON edition_identifiers(edition_id);

DROP TABLE release_genres;
DROP TABLE release_styles;
DROP TABLE release_format_descriptions;
DROP TABLE release_formats;
DROP TABLE release_track_artists;
DROP TABLE release_companies;
DROP TABLE companies;
DROP TABLE release_labels;
DROP TABLE release_extra_artists;
DROP TABLE release_artists;

-- Tracks.
CREATE TABLE tracks (
  id               INTEGER PRIMARY KEY,
  edition_id       INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  position         TEXT NOT NULL,
  title            TEXT NOT NULL,
  artist_credit    TEXT,
  duration_seconds INTEGER,
  sort_order       INTEGER NOT NULL,
  recording_id     INTEGER REFERENCES recordings(id)
);
INSERT INTO tracks (id, edition_id, position, title, artist_credit, duration_seconds, sort_order, recording_id)
SELECT id, release_id, position, title, artist_credit, duration_seconds, sequence, recording_id FROM release_tracks WHERE track_type = 'track';
DROP TABLE release_tracks;
CREATE INDEX tracks_edition ON tracks(edition_id);

-- Masters → releases (group level).
CREATE TABLE release_artists (
  release_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  artist_id  INTEGER NOT NULL REFERENCES artists(id),
  position   INTEGER NOT NULL DEFAULT 0,
  join_text  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (release_id, artist_id)
);
INSERT OR IGNORE INTO release_artists (release_id, artist_id, position, join_text) SELECT master_id, artist_id, position, join_text FROM master_artists WHERE artist_id IS NOT NULL;
DROP TABLE master_artists;
CREATE TABLE release_terms (
  release_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('genre', 'style')),
  term       TEXT NOT NULL,
  PRIMARY KEY (release_id, kind, term)
);
INSERT OR IGNORE INTO release_terms SELECT master_id, 'genre', genre FROM master_genres;
INSERT OR IGNORE INTO release_terms SELECT master_id, 'style', style FROM master_styles;
DROP TABLE master_genres;
DROP TABLE master_styles;
DROP INDEX masters_discogs_id;
DROP INDEX masters_normalized_title;
ALTER TABLE masters DROP COLUMN discogs_master_id;
ALTER TABLE masters DROP COLUMN normalized_title;
ALTER TABLE masters DROP COLUMN year;
ALTER TABLE masters DROP COLUMN main_release_discogs_id;
ALTER TABLE masters DROP COLUMN main_release_id;
ALTER TABLE masters DROP COLUMN notes;
ALTER TABLE masters DROP COLUMN data_quality;
ALTER TABLE masters DROP COLUMN local_edited_at;
ALTER TABLE masters RENAME TO releases;

-- Labels (restore UNIQUE(name); the guard ensures there are no duplicates).
CREATE TABLE labels_old (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  profile    TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO labels_old (id, name, profile, created_at) SELECT id, name, profile, created_at FROM labels;
DROP TABLE labels;
ALTER TABLE labels_old RENAME TO labels;

-- Artists.
DROP TABLE artist_members;
DROP TABLE artist_name_variations;
DROP TABLE artist_aliases;
DROP INDEX artists_discogs_id;
DROP INDEX artists_normalized_name;
ALTER TABLE artists DROP COLUMN discogs_artist_id;
ALTER TABLE artists DROP COLUMN normalized_name;
ALTER TABLE artists DROP COLUMN real_name;
ALTER TABLE artists DROP COLUMN urls;
ALTER TABLE artists DROP COLUMN data_quality;
ALTER TABLE artists DROP COLUMN local_edited_at;
ALTER TABLE artists DROP COLUMN updated_at;

DROP TABLE catalog_import_errors;
DROP TABLE catalog_provenance;
DROP TABLE catalog_import_runs;
DROP TABLE external_identifiers;
DROP TABLE catalog_sources;

-- Library view as defined by migration 002.
CREATE VIEW library_items AS
SELECT
  'physical' AS item_type, c.id AS item_id, c.owner_id,
  COALESCE(c.artist_text, (SELECT group_concat(a.name || ra.join_text, '' ORDER BY ra.position) FROM release_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.release_id = e.release_id)) AS artist,
  COALESCE(c.title_text, r.title) AS title,
  NULL AS version,
  COALESCE(c.label_text, l.name) AS label,
  COALESCE(c.catno_text, e.catalog_number) AS catno,
  COALESCE(c.format_group, CASE WHEN e.format = 'File' THEN 'Digital' WHEN e.format IN ('Vinyl', 'CD', 'Cassette') THEN e.format ELSE 'Other' END) AS format_group,
  COALESCE(c.format_raw, e.format || COALESCE(', ' || e.format_details, '')) AS format_raw,
  COALESCE(c.release_year, e.release_year) AS year,
  COALESCE(c.genre_text, (SELECT group_concat(term, ', ' ORDER BY term) FROM release_terms rt WHERE rt.release_id = e.release_id AND rt.kind = 'genre')) AS genre,
  c.date_added, c.edition_id, e.release_id, c.created_by_batch_id, c.source_entry_id,
  c.media_condition, c.sleeve_condition, NULL AS bpm_x100, NULL AS musical_key, NULL AS rating, c.source_folder AS folder
FROM copies c
LEFT JOIN editions e ON e.id = c.edition_id
LEFT JOIN releases r ON r.id = e.release_id
LEFT JOIN labels l ON l.id = e.label_id
UNION ALL
SELECT
  'digital', d.id, d.owner_id, d.artist_text, d.title_text, d.version_text, d.label_text, d.catno_text,
  'Digital', COALESCE(d.file_format, 'Digital') || CASE WHEN d.granularity = 'release' THEN ' (release)' ELSE '' END,
  d.release_year, d.genre_text, d.date_added, d.edition_id, e.release_id, d.created_by_batch_id, d.source_entry_id,
  NULL, NULL, d.bpm_x100, d.musical_key, d.rating, NULL
FROM digital_holdings d
LEFT JOIN editions e ON e.id = d.edition_id;
