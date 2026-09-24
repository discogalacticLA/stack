# Synthetic import fixtures

Every file here is **synthetic sample data** made for this prototype. Artists, titles, labels,
catalog numbers, Discogs release IDs (9xxxxxx) and Rekordbox TrackIDs are invented, and the file
paths point at a fictional `/Users/sample/` home folder. No real export or personal data is included.

| File | What it exercises |
|---|---|
| `discogs/synthetic-collection-v1.csv` | UTF-8 BOM, Unicode, quoted commas, a note with an embedded newline, blank fields, a custom-field column, two identical copies of one release, a `File` (digital) release, one malformed row (wrong column count) |
| `discogs/synthetic-collection-v1-reordered.csv` | Same rows as v1 in a different order, CRLF line endings, no BOM → must import as all "existing" |
| `discogs/synthetic-collection-v2-changed.csv` | A later export: one copy's condition changed (ambiguous: edited copy or another copy?), a third copy of a release already owned twice (new: both known copies still match exactly), the previously malformed row now valid (new), one new release (new), one copy absent (reported missing, never deleted) |
| `discogs/synthetic-wantlist.csv` | Wantlist export with Notes; one row with a blank release_id |
| `rekordbox/synthetic-library-v1.xml` | Collection + nested playlist folders, the same playlist name under two parents, cues/tempo markers, private paths and comments, Unicode, ratings 0–255 |
| `rekordbox/synthetic-library-v2.xml` | A later export: rating/BPM edits (changed), one track whose TrackID changed (ambiguous), a new track, one track removed (missing) |
| `rekordbox/malformed.xml` | Not well-formed (unclosed element) |
| `rekordbox/xxe.xml` | External-entity attack; must be refused without reading the entity |

Large files for performance checks are generated, not committed: `npm run fixtures:large`.
