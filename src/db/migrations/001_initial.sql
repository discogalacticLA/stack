-- Record Archive prototype: initial schema.
-- Money is stored as INTEGER minor units (cents) with an explicit currency code.
-- Timestamps are ISO-8601 UTC strings.

-- ───────────────────────── Accounts ─────────────────────────
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  country       TEXT NOT NULL DEFAULT 'US',       -- default shipping destination / seller origin
  bio           TEXT,
  is_demo       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Everyone can collect, buy and sell. Extra roles gate archive editing.
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('contributor', 'moderator')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                    -- sha256 of the cookie token
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  flash       TEXT,                                -- JSON, consumed on next render
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- ───────────────────────── Archive (public, shared) ─────────────────────────
CREATE TABLE artists (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_name  TEXT NOT NULL,
  profile    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE labels (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  profile    TEXT,
  created_at TEXT NOT NULL
);

-- A release is the shared identity of an album / EP / single.
CREATE TABLE releases (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  release_type TEXT NOT NULL CHECK (release_type IN ('album', 'ep', 'single', 'compilation', 'other')),
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE release_artists (
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  artist_id  INTEGER NOT NULL REFERENCES artists(id),
  position   INTEGER NOT NULL DEFAULT 0,
  join_text  TEXT NOT NULL DEFAULT '',              -- e.g. " & ", " feat. "
  PRIMARY KEY (release_id, artist_id)
);

CREATE TABLE release_terms (
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('genre', 'style')),
  term       TEXT NOT NULL,
  PRIMARY KEY (release_id, kind, term)
);

-- An edition (pressing / issue) of a release.
CREATE TABLE editions (
  id                  INTEGER PRIMARY KEY,
  release_id          INTEGER NOT NULL REFERENCES releases(id),
  label_id            INTEGER REFERENCES labels(id),     -- NULL = label unknown
  catalog_number      TEXT,                              -- NULL = none / unknown
  catalog_number_norm TEXT,                              -- uppercase, alphanumerics only (for matching)
  format              TEXT NOT NULL,                     -- e.g. Vinyl, CD, Cassette, File
  format_details      TEXT,                              -- e.g. 12", 33 ⅓ RPM, Test Pressing
  country             TEXT,                              -- ISO code or NULL = unknown
  release_year        INTEGER,                           -- NULL = unknown
  release_month       INTEGER,
  release_day         INTEGER,
  date_note           TEXT,                              -- uncertainty notes about the date
  edition_notes       TEXT,                              -- distinguishing details
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'sourced', 'reviewed', 'disputed')),
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX editions_release ON editions(release_id);
CREATE INDEX editions_catno ON editions(catalog_number_norm);

-- Edition-specific track listing: different editions can differ.
CREATE TABLE tracks (
  id               INTEGER PRIMARY KEY,
  edition_id       INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  position         TEXT NOT NULL,        -- A1, B2, 1, 2 ...
  title            TEXT NOT NULL,
  artist_credit    TEXT,                 -- when it differs from the release credit
  duration_seconds INTEGER,
  sort_order       INTEGER NOT NULL
);
CREATE INDEX tracks_edition ON tracks(edition_id);

CREATE TABLE edition_identifiers (
  id         INTEGER PRIMARY KEY,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('barcode', 'matrix_runout', 'label_code', 'rights_society', 'other')),
  value      TEXT NOT NULL,
  note       TEXT
);
CREATE INDEX identifiers_edition ON edition_identifiers(edition_id);

-- Where archival facts came from.
CREATE TABLE archival_sources (
  id         INTEGER PRIMARY KEY,
  edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('physical_copy', 'label_statement', 'artist_statement', 'publication', 'website', 'other')),
  citation   TEXT NOT NULL,
  url        TEXT,
  added_by   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Archive images describe the edition in general (NOT a specific copy for sale).
CREATE TABLE archive_images (
  id           INTEGER PRIMARY KEY,
  edition_id   INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'front' CHECK (kind IN ('front', 'back', 'label', 'runout', 'other')),
  storage_path TEXT,            -- uploaded file relative to UPLOAD_DIR
  placeholder_seed TEXT,        -- generated original placeholder artwork
  caption      TEXT,
  attribution  TEXT NOT NULL,   -- who supplied it and under what basis
  created_at   TEXT NOT NULL
);

-- External listening links (e.g. YouTube). The archive does not host audio; these are
-- moderated links to third-party players, loaded only when a viewer clicks.
CREATE TABLE edition_media_links (
  id             INTEGER PRIMARY KEY,
  edition_id     INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL CHECK (provider IN ('youtube')),
  external_id    TEXT NOT NULL,          -- validated video id
  track_position TEXT,                   -- NULL = whole record / playlist-style preview
  added_by       INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX media_links_edition ON edition_media_links(edition_id);

-- ───────────────────────── Contributions & history ─────────────────────────
CREATE TABLE proposals (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('new_edition', 'correction')),
  release_id        INTEGER NOT NULL REFERENCES releases(id),
  target_edition_id INTEGER REFERENCES editions(id),        -- set for corrections
  payload           TEXT NOT NULL,                          -- JSON of proposed edition fields
  source_notes      TEXT NOT NULL,
  duplicate_ack     TEXT,                                   -- JSON: candidate IDs shown to proposer
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  proposed_by       INTEGER NOT NULL REFERENCES users(id),
  reviewed_by       INTEGER REFERENCES users(id),
  review_note       TEXT,
  created_at        TEXT NOT NULL,
  reviewed_at       TEXT,
  resulting_edition_id INTEGER REFERENCES editions(id)
);

CREATE TABLE proposal_images (
  id           INTEGER PRIMARY KEY,
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  caption      TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE edition_revisions (
  id           INTEGER PRIMARY KEY,
  edition_id   INTEGER NOT NULL REFERENCES editions(id),
  proposal_id  INTEGER REFERENCES proposals(id),
  summary      TEXT NOT NULL,
  changes      TEXT NOT NULL,     -- JSON array of {field, before, after}
  proposed_by  INTEGER REFERENCES users(id),
  accepted_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL
);

-- ───────────────────────── Private collection ─────────────────────────
CREATE TABLE crates (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, name)
);

-- A specific physical copy. Private by default; never for sale unless a listing exists.
CREATE TABLE copies (
  id                     INTEGER PRIMARY KEY,
  owner_id               INTEGER NOT NULL REFERENCES users(id),
  edition_id             INTEGER NOT NULL REFERENCES editions(id),
  media_condition        TEXT NOT NULL,
  sleeve_condition       TEXT NOT NULL,
  crate_id               INTEGER REFERENCES crates(id) ON DELETE SET NULL,
  private_notes          TEXT,
  storage_location       TEXT,
  acquired_on            TEXT,
  acquired_from          TEXT,
  acquisition_cost_cents INTEGER,
  acquisition_currency   TEXT,
  dj_energy              INTEGER CHECK (dj_energy BETWEEN 1 AND 5),
  dj_bpm_notes           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX copies_owner ON copies(owner_id);

CREATE TABLE tags (
  id       INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  UNIQUE (owner_id, name)
);

CREATE TABLE copy_tags (
  copy_id INTEGER NOT NULL REFERENCES copies(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (copy_id, tag_id)
);

-- Photos of the actual physical copy (distinct from archive images).
CREATE TABLE copy_photos (
  id               INTEGER PRIMARY KEY,
  copy_id          INTEGER NOT NULL REFERENCES copies(id),
  storage_path     TEXT,
  placeholder_seed TEXT,
  caption          TEXT,
  deleted_at       TEXT,      -- soft delete keeps order snapshots intact
  created_at       TEXT NOT NULL
);

CREATE TABLE wants (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL REFERENCES releases(id),
  edition_id INTEGER REFERENCES editions(id),         -- NULL = any edition of the release
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX wants_unique ON wants(user_id, release_id, IFNULL(edition_id, 0));

-- ───────────────────────── Marketplace (simulated) ─────────────────────────
CREATE TABLE shipping_profiles (
  id                  INTEGER PRIMARY KEY,
  seller_id           INTEGER NOT NULL REFERENCES users(id),
  name                TEXT NOT NULL,
  origin_country      TEXT NOT NULL,
  domestic_first      INTEGER,     -- cents; NULL = does not ship to this zone
  domestic_additional INTEGER,
  region_first        INTEGER,
  region_additional   INTEGER,
  world_first         INTEGER,
  world_additional    INTEGER,
  currency            TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

-- One listing = one physical copy (pilot rule).
CREATE TABLE listings (
  id                  INTEGER PRIMARY KEY,
  copy_id             INTEGER NOT NULL REFERENCES copies(id),
  seller_id           INTEGER NOT NULL REFERENCES users(id),
  edition_id          INTEGER NOT NULL REFERENCES editions(id),
  price_cents         INTEGER NOT NULL CHECK (price_cents > 0),
  currency            TEXT NOT NULL,
  -- Public grades are stored on the listing so private copy edits never change a published offer.
  media_condition     TEXT NOT NULL,
  sleeve_condition    TEXT NOT NULL,
  condition_description TEXT NOT NULL,
  shipping_profile_id INTEGER NOT NULL REFERENCES shipping_profiles(id),
  status              TEXT NOT NULL CHECK (status IN ('draft', 'available', 'reserved', 'sold', 'withdrawn')),
  reserved_order_id   INTEGER,
  reserved_until      TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  published_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
-- Only one non-withdrawn listing per copy. Sold copies can't be relisted.
CREATE UNIQUE INDEX listings_one_active_per_copy ON listings(copy_id)
  WHERE status IN ('draft', 'available', 'reserved', 'sold');
CREATE INDEX listings_edition_status ON listings(edition_id, status);
CREATE INDEX listings_reserved_until ON listings(status, reserved_until);

CREATE TABLE listing_photos (
  listing_id    INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  copy_photo_id INTEGER NOT NULL REFERENCES copy_photos(id),
  position      INTEGER NOT NULL,
  PRIMARY KEY (listing_id, copy_photo_id)
);

CREATE TABLE cart_items (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE checkout_attempts (
  idempotency_key TEXT PRIMARY KEY,
  buyer_id        INTEGER NOT NULL REFERENCES users(id),
  order_ids       TEXT NOT NULL,     -- JSON array
  created_at      TEXT NOT NULL
);

CREATE TABLE orders (
  id                 INTEGER PRIMARY KEY,
  buyer_id           INTEGER NOT NULL REFERENCES users(id),
  seller_id          INTEGER NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'shipped', 'delivered', 'cancelled', 'expired')),
  currency           TEXT NOT NULL,
  items_subtotal_cents INTEGER NOT NULL,
  shipping_cents     INTEGER NOT NULL,
  total_cents        INTEGER NOT NULL,
  -- Snapshots: never recomputed from live data.
  seller_name_snapshot  TEXT NOT NULL,
  buyer_name_snapshot   TEXT NOT NULL,
  ship_to_name       TEXT NOT NULL,
  ship_to_line1      TEXT NOT NULL,
  ship_to_city       TEXT NOT NULL,
  ship_to_postcode   TEXT NOT NULL,
  ship_to_country    TEXT NOT NULL,
  shipping_rule_snapshot TEXT NOT NULL,
  reserved_until     TEXT,
  fulfillment_carrier TEXT,
  fulfillment_tracking TEXT,
  checkout_key       TEXT NOT NULL,
  simulated          INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (checkout_key, seller_id)
);
CREATE INDEX orders_buyer ON orders(buyer_id);
CREATE INDEX orders_seller ON orders(seller_id);

CREATE TABLE order_lines (
  id                    INTEGER PRIMARY KEY,
  order_id              INTEGER NOT NULL REFERENCES orders(id),
  listing_id            INTEGER NOT NULL REFERENCES listings(id),
  listing_version       INTEGER NOT NULL,
  copy_id               INTEGER NOT NULL,
  edition_id            INTEGER NOT NULL,
  artist_snapshot       TEXT NOT NULL,
  title_snapshot        TEXT NOT NULL,
  label_snapshot        TEXT,
  catalog_number_snapshot TEXT,
  format_snapshot       TEXT NOT NULL,
  country_snapshot      TEXT,
  year_snapshot         INTEGER,
  media_condition_snapshot  TEXT NOT NULL,
  sleeve_condition_snapshot TEXT NOT NULL,
  condition_description_snapshot TEXT NOT NULL,
  photo_ids_snapshot    TEXT NOT NULL,       -- JSON array of copy_photo ids
  price_cents           INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  buyer_copy_id         INTEGER REFERENCES copies(id)   -- set when the buyer adds the purchase to their collection
);
CREATE INDEX order_lines_order ON order_lines(order_id);

CREATE TABLE order_events (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    INTEGER REFERENCES users(id),   -- NULL = system (e.g. expiry)
  note        TEXT,
  created_at  TEXT NOT NULL
);
