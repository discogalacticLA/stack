# Collection imports (Discogs CSV, Rekordbox XML)

These are **user** imports into a private library. The catalog-wide Discogs *dump* importer is a
separate thing; see [DISCOGS_IMPORT.md](DISCOGS_IMPORT.md).

## Flow

1. **Upload.** Accepted inputs are a Discogs collection CSV, a Discogs wantlist CSV or a Rekordbox
   collection XML, up to 30 MB and 50,000 rows.
2. **Preview.** The file is parsed and reconciled against what this *source library* already holds.
   Nothing is written to holdings yet. Each row is classified as *new*, *existing*, *changed*,
   *ambiguous* or *invalid*, with a reason. The preview also counts rows that match a catalog release
   (`matched_catalog`).
3. **Review ambiguous rows.** For each one, the owner chooses to create a new holding, update a
   candidate, or skip.
4. **Commit.** The batch is written in chunks of 250 rows, one transaction each, and each row is
   marked applied in the same transaction. A retry or crash never applies a row twice. Batches over
   1,500 rows commit in the background with a progress page.
5. **Report**, with optional **undo**.

Everything imported is **private**. Copies are not for sale.

## Integrity rules

- **Fingerprinting.** Each file's sha256 is stored, and so is a content hash per row.
- **Exact re-import creates nothing**, even when the rows are reordered or the line endings change.
- **Multiplicity is preserved.** Discogs exports have no per-copy ID, so rows are grouped by
  `release_id` and matched as a multiset on content. Two identical rows mean two copies.
- **Ambiguity is surfaced, not guessed.** Suppose a group has leftover rows *and* known copies that
  no longer match (e.g. a condition changed). The system can't tell an edit from a new copy, so it
  asks.
- **Rekordbox** rows match on TrackID, scoped to that source library, using file location and
  metadata as hints. A new TrackID that looks like a missing known track is ambiguous.
- **Never delete.** Holdings missing from a newer export are reported as missing and left alone.
- **User edits win.** Import updates touch only source fields the owner hasn't edited. Notes,
  tags, crates and charts are never overwritten.
- **Stale previews are refused.** If another import of the same source library was committed or
  undone after the preview, the commit is refused.
- **Undo** removes what the batch created, except records the user has since edited or organised.
  Those are kept and reported.
- **Catalog linking.** Rows with a Discogs `release_id` are linked to the catalog release when it
  exists. Rows that couldn't be linked earlier are linked on a later re-import.

## Formats (need checking against real exports)

The official Discogs and Pioneer DJ documentation couldn't be fetched from the build environment,
so the mappings below come from community references and the synthetic fixtures.
**They have not been checked against a real export.**

- **Discogs collection CSV**: columns are matched by header name, case- and space-insensitive:
  `Catalog#, Artist, Title, Label, Format, Rating, Released, release_id, CollectionFolder,
  Date Added, Collection Media Condition, Collection Sleeve Condition, Collection Notes`, plus
  custom-field columns. Unknown columns are preserved as private metadata.
- **Discogs wantlist CSV**: the same release columns plus `Notes`.
- **Rekordbox XML**: `DJ_PLAYLISTS/COLLECTION/TRACK` attributes (TrackID, Name, Artist, Album,
  Genre, Kind, Size, TotalTime, Year, AverageBpm, BitRate, SampleRate, Comments, PlayCount,
  Rating 0–255, Location, Tonality, Label, …), plus `PLAYLISTS` NODE trees (Type 0 is a folder,
  Type 1 a playlist; KeyType 0 is TrackID, 1 is Location).

## Security

- Rekordbox XML is refused if it contains DOCTYPE or ENTITY declarations, so there's no XXE or
  entity expansion. It is validated before parsing.
- The CSV parser reports errors per row and never evaluates anything.
- File locations, comments, cue points and tempo maps are private source data. They're never
  shown to other users.

## Fixtures

Synthetic only; see `fixtures/README.md`. Large files for timing come from `npm run fixtures:large`.
