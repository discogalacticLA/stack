-- 009: two fixes found on the real 2025-12-01 import.
--
-- (A 0 id never links, so its internal FK is always NULL; saying so lets each UPDATE use the
-- unresolved-reference partial index instead of scanning the table.)
--
-- 1. Discogs writes 0 where a reference is absent (e.g. <master_id>0</master_id> on the 7.79M
--    releases that belong to no master). The importer stored 0 as a Discogs id, so those rows
--    counted as "unresolved". 0 is never a real Discogs id; it becomes NULL here (the parser now
--    reads it as "no reference"). Nothing else changes: the internal links were already NULL.
UPDATE releases SET discogs_master_id = NULL WHERE master_id IS NULL AND discogs_master_id = 0;
UPDATE masters SET main_release_discogs_id = NULL WHERE main_release_id IS NULL AND main_release_discogs_id = 0;
UPDATE labels SET parent_discogs_label_id = NULL WHERE parent_label_id IS NULL AND parent_discogs_label_id = 0;
UPDATE release_artists SET discogs_artist_id = NULL WHERE artist_id IS NULL AND discogs_artist_id = 0;
UPDATE release_extra_artists SET discogs_artist_id = NULL WHERE artist_id IS NULL AND discogs_artist_id = 0;
UPDATE release_track_artists SET discogs_artist_id = NULL WHERE artist_id IS NULL AND discogs_artist_id = 0;
UPDATE master_artists SET discogs_artist_id = NULL WHERE artist_id IS NULL AND discogs_artist_id = 0;
UPDATE release_labels SET discogs_label_id = NULL WHERE label_id IS NULL AND discogs_label_id = 0;
UPDATE release_series SET discogs_label_id = NULL WHERE label_id IS NULL AND discogs_label_id = 0;
UPDATE artist_aliases SET discogs_alias_id = NULL WHERE alias_artist_id IS NULL AND discogs_alias_id = 0;
UPDATE artist_members SET discogs_member_id = NULL WHERE member_artist_id IS NULL AND discogs_member_id = 0;
UPDATE companies SET discogs_company_id = NULL WHERE discogs_company_id = 0;

-- 2. library_items used group_concat(... ORDER BY ...), which needs SQLite 3.44+. Older sqlite3
--    tools (e.g. the one bundled with macOS) then refuse to open the whole database. Same result,
--    written with an ordered subquery instead.
DROP VIEW library_items;
CREATE VIEW library_items AS
SELECT
  'physical' AS item_type, c.id AS item_id, c.owner_id,
  COALESCE(c.artist_text, (SELECT group_concat(part, '') FROM (SELECT COALESCE(ra.anv, ra.name) || ra.join_text AS part FROM release_artists ra WHERE ra.release_id = r.id ORDER BY ra.position))) AS artist,
  COALESCE(c.title_text, r.title) AS title,
  NULL AS version,
  COALESCE(c.label_text, l.name) AS label,
  COALESCE(c.catno_text, r.catalog_number) AS catno,
  COALESCE(c.format_group, CASE WHEN r.format = 'File' THEN 'Digital' WHEN r.format IN ('Vinyl', 'CD', 'Cassette') THEN r.format WHEN r.format IS NULL THEN NULL ELSE 'Other' END) AS format_group,
  COALESCE(c.format_raw, r.format || COALESCE(', ' || r.format_details, '')) AS format_raw,
  COALESCE(c.release_year, r.year) AS year,
  COALESCE(c.genre_text, (SELECT group_concat(genre, ', ') FROM (SELECT rg.genre FROM release_genres rg WHERE rg.release_id = r.id ORDER BY rg.genre))) AS genre,
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
