-- Restores the previous view definition. The 0 → NULL repair is not undone: 0 was never a real
-- Discogs id, and the parser no longer produces it.
DROP VIEW library_items;
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
