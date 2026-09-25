# Discogs dump format coverage

**Status (2026-09-25): validated against the real 2025-12-01 dump** (`discogs_20251201_*`, sha256
verified against the published CHECKSUM.txt). The census ran on:
- the first 200,000 artists, labels and masters;
- the first 50,000 releases.

It ran on the owner's Mac, not in the build environment, which can't reach data.discogs.com.

Re-run the census on any new dump:

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

| Dump | Unknown paths |
|---|---|
| Labels (200k) | none |
| Artists (200k) | none |
| Masters (200k) | none |
| Releases (50k) | **`release/series/series[@name,@catno,@id]`**, in 3,280 of 50,000 releases (6.6%), e.g. `name="Profound Sounds" catno="Vol. 1" id="527772"` |

**Series are now imported** (migration 005, `release_series`). Series IDs share the label ID space,
so each row links to `labels` once that entity is imported, and is reconciled like `release_labels`.
Series names and numbers are included in release search.

Other real-data observations:
- **No `images` elements at all** in any of the four dumps.
- `artist/members/id` (older layout) doesn't occur; members carry `name@id`.
- `master/videos` appears in about 92% of masters and is deliberately ignored.
- `release/videos/video/description` holds free text, often a Discogs URL, and is ignored.

### Conventions found on the full import

- **`0` means "no reference".** Examples: `<master_id>0</master_id>` on 7.79M releases without a
  master, and credit or label IDs of 0. The parser now reads 0 as absent (migration 009 repairs
  earlier imports).
- **Placeholder artists aren't in the artists dump:** 194 Various, 355 Unknown Artist and 118760
  No Artist. They're kept as name-only credits and reported separately.

## PARSER CHANGES REQUIRED

1. `release/series` was added (parser, writer, reconcile, search, API, coverage list, migration 005,
   and tests).
2. A reference ID of `0` is now read as "none" (parser; migration 009 repairs earlier data). The synthetic fixture release 401 now carries two series: one resolved, one unresolved.

No other changes were needed. The parser already handles:
- the `<id>` child and the `id` attribute forms;
- missing optional elements, and empty elements (`<anv/>`, `<join/>`, `<images/>`);
- Unicode, including CJK and combining accents;
- invalid IDs, and records without a name or title (rejected and logged);
- duplicate IDs within a file, and oversized records and fields (truncated and logged).

## INVALID DATA FOUND

From the census counts on the real files:
- **Labels:** one of 200,000 has no `name`. It is rejected and logged as `invalid_record`.
- **Artists:** one of 200,000 has no `name` (rejected and logged). Two have an empty `realname`, and
  one has an empty name variation (filtered out).
- **Masters:** about 21 artist credits among 221,534 have no artist `id`. They're stored as
  name-only credits, since `discogs_artist_id` is NULL and they're never "unresolved".
- **Releases:** in the 50,000-record import benchmark, 0 records failed.

The synthetic fixtures also deliberately cover:
- a nameless artist;
- a titleless release;
- a non-numeric ID;
- a duplicate ID;
- malformed XML;
- a DOCTYPE/XXE attempt.
