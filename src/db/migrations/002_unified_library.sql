-- foreign_keys: off
-- Migration 002: unified music library (physical + digital holdings, imports, crates, charts).
-- Rebuilds `copies` (to allow unresolved imported copies) and `wants` (flexible wants),
-- preserving every existing row. See docs/ARCHITECTURE.md for the model.

-- ───────────────────────── Recordings & track placements ─────────────────────────
-- A recording is one specific recording/version (a radio edit and an extended mix are
-- different recordings). `tracks` rows are track placements: a recording's position on an
-- edition, with the edition-specific title.
CREATE TABLE recordings (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  version_name     TEXT,               -- "Extended Mix", "Radio Edit", "Dub" …
  artist_credit    TEXT NOT NULL,
  duration_seconds INTEGER,
  created_at       TEXT NOT NULL
);
ALTER TABLE tracks ADD COLUMN recording_id INTEGER REFERENCES recordings(id);

-- ───────────────────────── Import sources ─────────────────────────
-- A source library is one user's export source, e.g. "Discogs collection" or "Rekordbox — laptop".
-- Rekordbox TrackIDs are only meaningful inside one source library.
CREATE TABLE source_libraries (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('discogs_collection', 'discogs_wantlist', 'rekordbox')),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, kind, name)
);

CREATE TABLE import_batches (
  id                 INTEGER PRIMARY KEY,
  owner_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_library_id  INTEGER NOT NULL REFERENCES source_libraries(id),
  filename           TEXT NOT NULL,
  file_fingerprint   TEXT NOT NULL,           -- sha256 of the uploaded bytes
  file_bytes         INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('previewed', 'committing', 'committed', 'failed', 'undone', 'discarded')),
  identical_to_batch_id INTEGER REFERENCES import_batches(id),
  counts             TEXT NOT NULL DEFAULT '{}',  -- JSON preview counts
  notices            TEXT NOT NULL DEFAULT '[]',  -- JSON file-level notices from the adapter
  pending_playlists  TEXT,                        -- JSON playlist tree parsed at preview, written at commit
  report             TEXT,                        -- JSON saved import report
  error              TEXT,
  rows_total         INTEGER NOT NULL DEFAULT 0,
  rows_applied       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  committed_at       TEXT,
  undone_at          TEXT
);
CREATE INDEX import_batches_fingerprint ON import_batches(source_library_id, file_fingerprint);

-- The latest known state of one entry in a source library (private).
CREATE TABLE source_entries (
  id                INTEGER PRIMARY KEY,
  owner_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_library_id INTEGER NOT NULL REFERENCES source_libraries(id),
  external_id       TEXT,               -- Discogs release_id or Rekordbox TrackID (scoped to the source library)
  identity_key      TEXT NOT NULL,      -- grouping key for multiset matching (never a copy id)
  hints             TEXT NOT NULL DEFAULT '[]',  -- JSON secondary identity hints (file location+size, artist|title|mix|duration)
  content_hash      TEXT NOT NULL,      -- hash of the normalised row content
  data              TEXT NOT NULL,      -- JSON: normalised fields + unfamiliar columns + private source info
  first_batch_id    INTEGER NOT NULL REFERENCES import_batches(id),
  last_seen_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX source_entries_external ON source_entries(source_library_id, external_id);
CREATE INDEX source_entries_identity ON source_entries(source_library_id, identity_key);

-- Parsed rows of an import, kept so preview → review → commit never needs a re-upload,
-- and so commit can resume row by row after a failure.
CREATE TABLE import_rows (
  id                  INTEGER PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number          INTEGER NOT NULL,       -- 1-based data row (or TRACK element index)
  external_id         TEXT,
  content_hash        TEXT,
  parsed              TEXT,                   -- JSON normalised fields (NULL when invalid)
  classification      TEXT NOT NULL CHECK (classification IN ('new', 'existing', 'changed', 'ambiguous', 'invalid')),
  candidate_entry_ids TEXT NOT NULL DEFAULT '[]',
  matched_entry_id    INTEGER REFERENCES source_entries(id),
  decision            TEXT CHECK (decision IN ('create', 'link', 'skip')),
  decision_entry_id   INTEGER REFERENCES source_entries(id),
  messages            TEXT NOT NULL DEFAULT '[]',
  applied             INTEGER NOT NULL DEFAULT 0,
  result_entry_id     INTEGER REFERENCES source_entries(id),
  previous_state      TEXT,                   -- JSON snapshot of what this row overwrote (used by undo)
  UNIQUE (batch_id, row_number)
);
CREATE INDEX import_rows_batch ON import_rows(batch_id, applied);

-- Rekordbox playlist tree, as exported (private). Replaced by each committed import.
CREATE TABLE source_playlists (
  id                INTEGER PRIMARY KEY,
  source_library_id INTEGER NOT NULL REFERENCES source_libraries(id),
  batch_id          INTEGER NOT NULL REFERENCES import_batches(id),
  parent_id         INTEGER REFERENCES source_playlists(id) ON DELETE CASCADE,
  node_type         TEXT NOT NULL CHECK (node_type IN ('folder', 'playlist')),
  name              TEXT NOT NULL,
  path              TEXT NOT NULL,          -- "Gigs / 2026 / Warm-up" (display only; not unique)
  position          INTEGER NOT NULL
);
-- Playlists shown in the library come from the latest committed (not undone) import of each
-- source library, so undoing an import automatically restores the previous tree.
CREATE VIEW current_source_playlists AS
SELECT sp.* FROM source_playlists sp
WHERE sp.batch_id = (SELECT MAX(b.id) FROM import_batches b WHERE b.source_library_id = sp.source_library_id AND b.status = 'committed'
                     AND EXISTS (SELECT 1 FROM source_playlists x WHERE x.batch_id = b.id));

CREATE TABLE source_playlist_items (
  playlist_id     INTEGER NOT NULL REFERENCES source_playlists(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  source_entry_id INTEGER NOT NULL REFERENCES source_entries(id),
  PRIMARY KEY (playlist_id, position)
);

-- ───────────────────────── Physical holdings (rebuild of copies) ─────────────────────────
-- A copy may now be "unresolved": imported or entered manually without a link to an archive
-- edition. Its descriptive *_text fields are private to the owner and never become catalog facts.
CREATE TABLE copies_new (
  id                     INTEGER PRIMARY KEY,
  owner_id               INTEGER NOT NULL REFERENCES users(id),
  edition_id             INTEGER REFERENCES editions(id),      -- NULL = unresolved
  artist_text            TEXT,
  title_text             TEXT,
  label_text             TEXT,
  catno_text             TEXT,
  format_raw             TEXT,              -- e.g. 'Vinyl, 12", 33 ⅓ RPM' exactly as imported
  format_group           TEXT,              -- Vinyl | CD | Cassette | Digital | Other
  release_year           INTEGER,
  genre_text             TEXT,              -- only when supplied by the user or source; never invented
  source_folder          TEXT,              -- e.g. Discogs CollectionFolder (private organisation, not a crate)
  media_condition        TEXT NOT NULL,
  sleeve_condition       TEXT NOT NULL,
  private_notes          TEXT,
  storage_location       TEXT,
  acquired_on            TEXT,
  acquired_from          TEXT,
  acquisition_cost_cents INTEGER,
  acquisition_currency   TEXT,
  dj_energy              INTEGER CHECK (dj_energy BETWEEN 1 AND 5),
  dj_bpm_notes           TEXT,
  date_added             TEXT NOT NULL,
  source_entry_id        INTEGER REFERENCES source_entries(id),
  created_by_batch_id    INTEGER REFERENCES import_batches(id),
  user_edited_at         TEXT,              -- set whenever the owner edits; protects against import overwrite/undo
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (edition_id IS NOT NULL OR (artist_text IS NOT NULL AND title_text IS NOT NULL))
);
INSERT INTO copies_new (id, owner_id, edition_id, media_condition, sleeve_condition, private_notes, storage_location, acquired_on, acquired_from,
  acquisition_cost_cents, acquisition_currency, dj_energy, dj_bpm_notes, date_added, created_at, updated_at, user_edited_at)
SELECT id, owner_id, edition_id, media_condition, sleeve_condition, private_notes, storage_location, acquired_on, acquired_from,
  acquisition_cost_cents, acquisition_currency, dj_energy, dj_bpm_notes, created_at, created_at, updated_at, updated_at
FROM copies;

-- ───────────────────────── Crates: ordered, multi-membership ─────────────────────────
ALTER TABLE crates ADD COLUMN description TEXT;
ALTER TABLE crates ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public'));
ALTER TABLE crates ADD COLUMN updated_at TEXT;
UPDATE crates SET updated_at = created_at;

CREATE TABLE crate_items (
  id         INTEGER PRIMARY KEY,
  crate_id   INTEGER NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  copy_id    INTEGER REFERENCES copies(id) ON DELETE CASCADE,
  digital_id INTEGER REFERENCES digital_holdings(id) ON DELETE CASCADE,
  added_at   TEXT NOT NULL,
  CHECK ((copy_id IS NULL) != (digital_id IS NULL))
);
CREATE UNIQUE INDEX crate_items_copy ON crate_items(crate_id, copy_id) WHERE copy_id IS NOT NULL;
CREATE UNIQUE INDEX crate_items_digital ON crate_items(crate_id, digital_id) WHERE digital_id IS NOT NULL;
CREATE INDEX crate_items_order ON crate_items(crate_id, position);
-- Carry over the old single-crate assignment, in title order.
INSERT INTO crate_items (crate_id, position, copy_id, added_at)
SELECT crate_id, ROW_NUMBER() OVER (PARTITION BY crate_id ORDER BY id), id, updated_at FROM copies WHERE crate_id IS NOT NULL;

DROP TABLE copies;
ALTER TABLE copies_new RENAME TO copies;
CREATE INDEX copies_owner ON copies(owner_id);
CREATE INDEX copies_source_entry ON copies(source_entry_id);

-- ───────────────────────── Digital holdings ─────────────────────────
-- Metadata about files or purchases. No audio is stored. Nothing here implies rights,
-- authenticity or a particular master; links to editions/copies are user-confirmed only.
CREATE TABLE digital_holdings (
  id                  INTEGER PRIMARY KEY,
  owner_id            INTEGER NOT NULL REFERENCES users(id),
  granularity         TEXT NOT NULL CHECK (granularity IN ('track', 'release')),
  holding_kind        TEXT NOT NULL DEFAULT 'unspecified' CHECK (holding_kind IN ('purchased', 'personal', 'linked_to_physical', 'unspecified')),
  artist_text         TEXT NOT NULL,
  title_text          TEXT NOT NULL,
  version_text        TEXT,          -- mix / version name, e.g. "Extended Mix"
  album_text          TEXT,
  label_text          TEXT,
  catno_text          TEXT,
  genre_text          TEXT,          -- from the user's own file tags
  release_year        INTEGER,
  file_format         TEXT,          -- "MP3", "AIFF", "FLAC", "WAV" …
  bitrate_kbps        INTEGER,
  sample_rate_hz      INTEGER,
  bit_depth           INTEGER,
  duration_seconds    INTEGER,
  file_size_bytes     INTEGER,
  bpm_x100            INTEGER,       -- 124.50 BPM stored as 12450
  musical_key         TEXT,
  rating              INTEGER CHECK (rating BETWEEN 0 AND 5),
  play_count          INTEGER,       -- cumulative, as exported; never turned into monthly history
  file_location       TEXT,          -- PRIVATE: local path from the export
  source_comments     TEXT,          -- PRIVATE: comments field from the export
  private_notes       TEXT,
  acquisition_source  TEXT,
  acquired_on         TEXT,
  edition_id          INTEGER REFERENCES editions(id),
  linked_copy_id      INTEGER REFERENCES copies(id) ON DELETE SET NULL,
  date_added          TEXT NOT NULL,
  source_entry_id     INTEGER REFERENCES source_entries(id),
  created_by_batch_id INTEGER REFERENCES import_batches(id),
  user_edited_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX digital_owner ON digital_holdings(owner_id);
CREATE INDEX digital_source_entry ON digital_holdings(source_entry_id);

CREATE TABLE digital_tags (
  digital_id INTEGER NOT NULL REFERENCES digital_holdings(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (digital_id, tag_id)
);

-- ───────────────────────── Wants (rebuild) ─────────────────────────
CREATE TABLE wants_new (
  id                  INTEGER PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  want_kind           TEXT NOT NULL CHECK (want_kind IN ('any_format', 'edition', 'configuration')),
  release_id          INTEGER REFERENCES releases(id),
  edition_id          INTEGER REFERENCES editions(id),
  artist_text         TEXT,
  title_text          TEXT,
  label_text          TEXT,
  catno_text          TEXT,
  format_raw          TEXT,
  format_group        TEXT,
  release_year        INTEGER,
  configuration_note  TEXT,          -- e.g. "first press, black vinyl, with poster"
  note                TEXT,
  source_entry_id     INTEGER REFERENCES source_entries(id),
  created_by_batch_id INTEGER REFERENCES import_batches(id),
  user_edited_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (release_id IS NOT NULL OR (artist_text IS NOT NULL AND title_text IS NOT NULL)),
  CHECK (want_kind != 'configuration' OR configuration_note IS NOT NULL)
);
INSERT INTO wants_new (id, user_id, want_kind, release_id, edition_id, note, created_at, updated_at)
SELECT id, user_id, CASE WHEN edition_id IS NULL THEN 'any_format' ELSE 'edition' END, release_id, edition_id, note, created_at, created_at FROM wants;
DROP TABLE wants;
ALTER TABLE wants_new RENAME TO wants;
CREATE UNIQUE INDEX wants_archive_unique ON wants(user_id, release_id, IFNULL(edition_id, 0), want_kind)
  WHERE release_id IS NOT NULL AND source_entry_id IS NULL AND want_kind != 'configuration';
CREATE INDEX wants_source_entry ON wants(source_entry_id);

-- ───────────────────────── Charts (Top 5) ─────────────────────────
CREATE TABLE charts (
  id           INTEGER PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  chart_type   TEXT NOT NULL CHECK (chart_type IN ('track', 'release')),
  scope        TEXT NOT NULL CHECK (scope IN ('favorites', 'discoveries', 'new_releases', 'all_time_favorites', 'most_played')),
  period_kind  TEXT NOT NULL CHECK (period_kind IN ('month', 'all_time')),
  period_month TEXT,                 -- 'YYYY-MM' for monthly charts
  commentary   TEXT,
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  published_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK ((period_kind = 'month') = (period_month IS NOT NULL)),
  CHECK (scope NOT IN ('favorites', 'discoveries', 'new_releases') OR period_kind = 'month'),
  CHECK (scope != 'all_time_favorites' OR period_kind = 'all_time')
);

CREATE TABLE chart_entries (
  id             INTEGER PRIMARY KEY,
  chart_id       INTEGER NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position BETWEEN 1 AND 5),
  copy_id        INTEGER REFERENCES copies(id) ON DELETE CASCADE,
  digital_id     INTEGER REFERENCES digital_holdings(id) ON DELETE CASCADE,
  track_position TEXT,               -- for a track chart pick taken from a physical copy
  commentary     TEXT,
  CHECK ((copy_id IS NULL) != (digital_id IS NULL)),
  UNIQUE (chart_id, position)
);

-- ───────────────────────── Preferences ─────────────────────────
CREATE TABLE user_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,             -- JSON
  PRIMARY KEY (user_id, key)
);

-- ───────────────────────── Unified library view ─────────────────────────
-- One row per holding. Resolved copies take display fields from the archive edition;
-- unresolved copies and digital holdings use their own private descriptive fields.
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
