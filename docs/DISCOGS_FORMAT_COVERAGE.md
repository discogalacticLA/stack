# Discogs dump format coverage

**Status: NOT yet validated against a real Discogs dump.** The official source
(https://data.discogs.com/) was blocked by the build environment's network policy, and the
historical S3 location returned 403 AccessDenied (September 2026). Everything below comes from
the parser's code and the synthetic fixtures. Run the census on a real file to complete it:

```bash
npm run catalog -- census data/discogs-dumps/discogs_YYYYMMDD_artists.xml.gz  --limit 200000 --json data/census-artists.json
npm run catalog -- census data/discogs-dumps/discogs_YYYYMMDD_labels.xml.gz   --limit 200000 --json data/census-labels.json
npm run catalog -- census data/discogs-dumps/discogs_YYYYMMDD_masters.xml.gz  --limit 200000 --json data/census-masters.json
npm run catalog -- census data/discogs-dumps/discogs_YYYYMMDD_releases.xml.gz --limit 50000  --json data/census-releases.json
```

The census reads the file only; it writes nothing to the database. It lists every element and
attribute path it sees: how many records contain it, the occurrence count, the empty count and the
maximum length. Each path is marked **imported**, **ignored** (known, deliberately not imported)
or **unknown**. It exits with code 2 if anything is unknown. The lists live in
`src/services/importer/discogs/coverage.ts`, and a test keeps the fixtures at zero unknown paths.

## KNOWN AND IMPORTED

| Entity | Elements |
|---|---|
| Artists | `id`, `name`, `realname`, `profile`, `data_quality`, `urls/url`, `aliases/name[@id]`, `namevariations/name`, `members/name[@id]` |
| Labels | `id`, `name`, `profile`, `contactinfo`, `data_quality`, `urls/url`, `parentLabel[@id]` |
| Masters | `@id`, `main_release`, `title`, `year`, `data_quality`, `notes`, `artists/artist/{id,name,anv,join,role,tracks}`, `genres/genre`, `styles/style` |
| Releases | `@id`, `@status`, `title`, `released`, `country`, `notes`, `data_quality`, `master_id` |
| Release credits | `artists/artist/*`, `extraartists/artist/*` (role, tracks) |
| Release labels and companies | `labels/label[@id,@name,@catno]`; `companies/company/{id,name,catno,entity_type,entity_type_name}` |
| Release formats | `formats/format[@name,@qty,@text]/descriptions/description` |
| Release genres, styles, identifiers | `genres/genre`, `styles/style`, `identifiers/identifier[@type,@value,@description]` |
| Tracklist | `track/{position,title,duration,artists,extraartists,sub_tracks/track/…}`. Track types are derived: track, index (has sub-tracks), heading (no position and no duration), sub-track |
| Videos | `videos/video[@src]/title`. YouTube IDs only, validated |

## KNOWN BUT INTENTIONALLY IGNORED

| Path | Reason |
|---|---|
| `*/images/image[@type,@uri,@uri150,@width,@height]` | Image rights are not granted by the dumps |
| `artist/groups/name[@id]` | Derived from the group's own `members` |
| `artist/members/id` | Repeats `members/name@id` (older layout) |
| `label/sublabels/label[@id]` | Derived from each sublabel's `parentLabel` |
| `master/videos/*` | Videos are imported per release |
| `release/master_id@is_main_release` | The main release comes from `master/main_release` |
| `release/videos/video@duration`, `@embed`, `/description` | Not needed for a click-to-load embed |
| `release/companies/company/resource_url` | API URL; can be derived from the ID |

## NEW REAL-WORLD VARIANTS FOUND

None recorded yet. **No real dump has been read.**

One thing to look for first (unconfirmed): release series, which Discogs shows on release pages. If
the dumps carry them, it's probably as something like `release/series/series[@name,@catno,@id]`.
No fixture has this and the parser doesn't read it. If the census reports a series element, add it
to the schema (e.g. `release_series`) rather than ignoring it. The census test uses a structure like
this to prove unknown elements are reported.

## PARSER CHANGES REQUIRED

None proven yet. They depend on the real census. The parser already handles:
- the `<id>` child and the `id` attribute forms;
- missing optional elements, and empty elements (`<anv/>`, `<join/>`, `<images/>`);
- Unicode, including CJK and combining accents;
- invalid IDs, and records without a name or title (rejected and logged);
- duplicate IDs within a file, and oversized records and fields (truncated and logged).

## INVALID DATA FOUND

None recorded yet. Only synthetic fixtures have been read. They deliberately contain:
- a nameless artist;
- a titleless release;
- a non-numeric ID;
- a duplicate ID;
- malformed XML;
- a DOCTYPE/XXE attempt.
