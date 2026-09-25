/**
 * XML structure census for Discogs dumps: which element paths and attributes occur, how often, and
 * whether normalize.ts imports them, deliberately ignores them, or has never seen them.
 * Used by `npm run catalog -- census <file>` to audit a real dump before a full import.
 *
 * Paths are element names joined with "/", from the record element down, with attributes as
 * "@name" (e.g. "release/labels/label@catno"). Nested sub-tracks are written out as they occur.
 */
import { streamRecords, type XNode } from "./stream.js";

export type Coverage = "imported" | "ignored" | "unknown";

const T = "release/tracklist/track";
const trackPaths = (base: string) => [
  base, `${base}/position`, `${base}/title`, `${base}/duration`,
  ...credit(`${base}/artists/artist`), `${base}/artists`, ...credit(`${base}/extraartists/artist`), `${base}/extraartists`,
  `${base}/sub_tracks`,
];
function credit(base: string) {
  return [base, `${base}/id`, `${base}/name`, `${base}/anv`, `${base}/join`, `${base}/role`, `${base}/tracks`];
}

/** Everything normalize.ts reads. */
export const IMPORTED: Record<string, string[]> = {
  artist: ["artist", "artist/id", "artist/name", "artist/realname", "artist/profile", "artist/data_quality", "artist/urls", "artist/urls/url",
    "artist/aliases", "artist/aliases/name", "artist/aliases/name@id", "artist/namevariations", "artist/namevariations/name",
    "artist/members", "artist/members/name", "artist/members/name@id"],
  label: ["label", "label/id", "label/name", "label/profile", "label/contactinfo", "label/data_quality", "label/urls", "label/urls/url",
    "label/parentLabel", "label/parentLabel@id"],
  master: ["master", "master@id", "master/main_release", "master/title", "master/year", "master/data_quality", "master/notes",
    "master/artists", ...credit("master/artists/artist"), "master/genres", "master/genres/genre", "master/styles", "master/styles/style"],
  release: ["release", "release@id", "release@status", "release/title", "release/released", "release/country", "release/notes", "release/data_quality",
    "release/master_id", "release/artists", ...credit("release/artists/artist"), "release/extraartists", ...credit("release/extraartists/artist"),
    "release/labels", "release/labels/label", "release/labels/label@id", "release/labels/label@name", "release/labels/label@catno",
    "release/companies", "release/companies/company", ...["id", "name", "catno", "entity_type", "entity_type_name"].map((x) => `release/companies/company/${x}`),
    "release/formats", "release/formats/format", "release/formats/format@name", "release/formats/format@qty", "release/formats/format@text",
    "release/formats/format/descriptions", "release/formats/format/descriptions/description",
    "release/genres", "release/genres/genre", "release/styles", "release/styles/style",
    "release/tracklist", ...trackPaths(T), ...trackPaths(`${T}/sub_tracks/track`),
    "release/identifiers", "release/identifiers/identifier", "release/identifiers/identifier@type", "release/identifiers/identifier@value", "release/identifiers/identifier@description",
    "release/videos", "release/videos/video", "release/videos/video@src", "release/videos/video/title"],
};

/** Known parts of the format that are deliberately not imported, with the reason. */
export const IGNORED: Record<string, Record<string, string>> = {
  artist: {
    "artist/images": "Image references: rights not granted by the dump", "artist/images/image": "", "artist/groups": "Derived from other artists' <members>",
    "artist/groups/name": "", "artist/groups/name@id": "",
    "artist/members/id": "Repeats members/name@id (older dump layout)",
  },
  label: {
    "label/images": "Image references: rights not granted by the dump", "label/images/image": "",
    "label/sublabels": "Derived from each sublabel's own <parentLabel>", "label/sublabels/label": "", "label/sublabels/label@id": "",
  },
  master: {
    "master/images": "Image references: rights not granted by the dump", "master/images/image": "",
    "master/videos": "Videos are imported per release", "master/videos/video": "", "master/videos/video@src": "", "master/videos/video@duration": "",
    "master/videos/video@embed": "", "master/videos/video/title": "", "master/videos/video/description": "",
  },
  release: {
    "release/images": "Image references: rights not granted by the dump", "release/images/image": "",
    "release/master_id@is_main_release": "Main release comes from master/main_release",
    "release/videos/video@duration": "Not needed for a click-to-load embed", "release/videos/video@embed": "", "release/videos/video/description": "Free text; not shown",
    "release/companies/company/resource_url": "API URL; derivable from the id",
  },
};
// Image attributes are all ignored.
for (const [rec, base] of [["artist", "artist"], ["label", "label"], ["master", "master"], ["release", "release"]]) {
  for (const a of ["type", "uri", "uri150", "width", "height"]) IGNORED[rec][`${base}/images/image@${a}`] = "";
}

export function classify(record: string, p: string): Coverage {
  if (IMPORTED[record]?.includes(p)) return "imported";
  if (p in (IGNORED[record] ?? {})) return "ignored";
  return "unknown";
}

export interface PathStats { path: string; coverage: Coverage; records: number; occurrences: number; empty: number; maxTextLength: number; sample: string | null }

export interface CensusResult {
  record: string;
  records: number;
  paths: PathStats[];
  unknown: PathStats[];
  unicodeRecords: number;       // records containing non-ASCII text
  emptyElements: number;        // elements with no text and no children/attributes
}

/** Streams a dump (optionally only the first `limit` records) and tallies every path. */
export async function census(file: string, record: string, limit?: number): Promise<CensusResult> {
  const stats = new Map<string, PathStats>();
  let records = 0;
  let unicodeRecords = 0;
  let emptyElements = 0;
  class Stop extends Error {}
  const seenInRecord = new Set<string>();
  let unicode = false;
  const hit = (p: string, textValue: string | null) => {
    let s = stats.get(p);
    if (!s) stats.set(p, (s = { path: p, coverage: classify(record, p), records: 0, occurrences: 0, empty: 0, maxTextLength: 0, sample: null }));
    s.occurrences++;
    if (!seenInRecord.has(p)) { seenInRecord.add(p); s.records++; }
    const t = textValue?.trim() ?? "";
    if (!t) s.empty++;
    else {
      s.maxTextLength = Math.max(s.maxTextLength, t.length);
      if (s.sample == null) s.sample = t.slice(0, 80);
      if (/[^\x00-\x7f]/.test(t)) unicode = true;
    }
  };
  const walk = (n: XNode, p: string) => {
    hit(p, n.children.length ? null : n.text);
    if (!n.children.length && !n.text.trim() && !Object.keys(n.attrs).length) emptyElements++;
    for (const [k, v] of Object.entries(n.attrs)) hit(`${p}@${k}`, v);
    for (const c of n.children) walk(c, `${p}/${c.name}`);
  };
  try {
    await streamRecords(file, record, (node) => {
      if (limit != null && records >= limit) throw new Stop();
      records++;
      seenInRecord.clear();
      unicode = false;
      if (node) walk(node, record);
      if (unicode) unicodeRecords++;
    });
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  const paths = [...stats.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { record, records, paths, unknown: paths.filter((p) => p.coverage === "unknown"), unicodeRecords, emptyElements };
}
