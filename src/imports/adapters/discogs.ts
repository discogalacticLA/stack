/**
 * Discogs collection and wantlist CSV exports.
 *
 * Mapping is by header NAME (case/spacing-insensitive), never by column position. Observed
 * collection headers (to be re-verified against current exports — see docs/IMPORTS.md):
 *   Catalog#, Artist, Title, Label, Format, Rating, Released, release_id, CollectionFolder,
 *   Date Added, Collection Media Condition, Collection Sleeve Condition, Collection Notes,
 *   plus one column per user-defined custom field.
 * Wantlist exports share the release columns and carry a Notes column.
 * Any column we don't recognise is preserved verbatim as private source metadata.
 * Discogs CSVs carry no genre column, so no genre is set.
 */
import { parseCsv } from "../csv.js";
import { contentHash, ImportFileError, normKey } from "../text.js";
import { MAX_IMPORT_ROWS, type ImportAdapter, type ParsedImport, type ParsedRow } from "./types.js";

const ALIASES: Record<string, string[]> = {
  catno: ["catalog#", "catalognumber", "catno", "catalog"],
  artist: ["artist", "artists"],
  title: ["title"],
  label: ["label", "labels"],
  format: ["format", "formats"],
  rating: ["rating"],
  released: ["released", "year"],
  release_id: ["releaseid", "release_id", "discogsreleaseid"],
  folder: ["collectionfolder", "folder"],
  date_added: ["dateadded", "added"],
  media_condition: ["collectionmediacondition", "mediacondition"],
  sleeve_condition: ["collectionsleevecondition", "sleevecondition"],
  notes: ["collectionnotes", "notes"],
};

const CONDITION_MAP: [RegExp, string][] = [
  [/^mint\b|\(m\)$/i, "M"],
  [/near mint|\(nm|m-\)/i, "NM"],
  [/very good plus|\(vg\+\)/i, "VG+"],
  [/very good|\(vg\)/i, "VG"],
  [/good plus|\(g\+\)/i, "G+"],
  [/^good\b|\(g\)/i, "G"],
  [/fair|\(f\)/i, "F"],
  [/poor|\(p\)/i, "P"],
  [/generic/i, "GENERIC"],
  [/no cover|no sleeve/i, "NONE"],
  [/not graded/i, "NG"],
];

export function mapCondition(raw: string, warnings: string[], what: string): string {
  const v = raw.trim();
  if (!v) return "NG";
  for (const [re, code] of CONDITION_MAP) if (re.test(v)) return code;
  warnings.push(`Unrecognised ${what} “${v}” — kept as imported text, graded as “Not graded”.`);
  return "NG";
}

/** Normalised group for filtering; the raw Discogs format text is always kept too. */
export function formatGroup(raw: string): "Vinyl" | "CD" | "Cassette" | "Digital" | "Other" {
  const first = raw.split(/[,+]/)[0].trim().replace(/^\d+\s*[x×]\s*/i, "");
  if (/^(vinyl|lp|12"|10"|7"|lathe cut|acetate|flexi-?disc|shellac)/i.test(first)) return "Vinyl";
  if (/^(cd|cdr|sacd|hybrid|minidisc)/i.test(first)) return "CD";
  if (/^(cass|cassette|microcassette)/i.test(first)) return "Cassette";
  if (/^file/i.test(first)) return "Digital";
  return "Other";
}

export function parseYear(raw: string): number | null {
  const m = /(\d{4})/.exec(raw ?? "");
  const y = m ? Number(m[1]) : NaN;
  return y >= 1900 && y <= 2100 ? y : null;
}

/** "2019-03-02 14:22:10" → ISO string; returns null if unparseable. */
export function parseDateAdded(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Discogs disambiguates artist names with " (2)"; strip it for display, keep the raw value. */
export const displayArtist = (raw: string) => raw.replace(/\s+\(\d+\)(?=$|\s*[,&/])/g, "").trim();

function mapHeaders(headers: string[]) {
  const index: Record<string, number> = {};
  const recognised: string[] = [];
  const preserved: string[] = [];
  headers.forEach((h, i) => {
    const k = normKey(h);
    const field = Object.entries(ALIASES).find(([, al]) => al.some((a) => normKey(a) === k))?.[0];
    if (field && index[field] === undefined) {
      index[field] = i;
      recognised.push(h);
    } else preserved.push(h);
  });
  return { index, recognised, preserved };
}

function makeAdapter(kind: "discogs_collection" | "discogs_wantlist"): ImportAdapter {
  const isCollection = kind === "discogs_collection";
  return {
    kind,
    label: isCollection ? "Discogs collection CSV" : "Discogs wantlist CSV",
    accept: ".csv,text/csv",
    parse(text: string): ParsedImport {
      const csv = parseCsv(text, MAX_IMPORT_ROWS);
      if (csv.fatal) throw new ImportFileError(csv.fatal);
      if (csv.rows.length > MAX_IMPORT_ROWS) throw new ImportFileError(`This file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it and import the parts separately.`);
      const { index, recognised, preserved } = mapHeaders(csv.headers);
      if (index.artist === undefined || index.title === undefined) {
        throw new ImportFileError(`This doesn't look like a Discogs ${isCollection ? "collection" : "wantlist"} export: it needs “Artist” and “Title” columns. Found: ${csv.headers.join(", ") || "(none)"}.`);
      }
      const notices: string[] = [];
      if (index.release_id === undefined) notices.push("No release_id column: rows are matched by artist, title and catalog number, which is less reliable.");
      if (isCollection && index.media_condition === undefined) notices.push("No media condition column: copies will be marked “Not graded”.");
      if (!isCollection && index.media_condition !== undefined) notices.push("This file has collection columns (media condition). Did you mean to use the collection import?");
      if (isCollection && index.folder === undefined && index.media_condition === undefined && index.date_added === undefined) {
        notices.push("This looks like it may be a wantlist export. Check you chose the right import type.");
      }
      if (preserved.length) notices.push(`Preserved as private source metadata (not interpreted): ${preserved.join(", ")}.`);

      const rows: ParsedRow[] = csv.rows.map((r) => {
        const get = (f: string) => (index[f] === undefined ? "" : (r.cells[index[f]] ?? "").trim());
        const errors: string[] = r.error ? [r.error] : [];
        const warnings: string[] = [];
        const source: Record<string, unknown> = {};
        csv.headers.forEach((h, i) => { if (r.cells[i] !== undefined && r.cells[i] !== "") source[h] = r.cells[i]; });
        const artistRaw = get("artist");
        const title = get("title");
        if (!errors.length) {
          if (!artistRaw) errors.push("Artist is blank.");
          if (!title) errors.push("Title is blank.");
        }
        const releaseIdRaw = get("release_id");
        const releaseId = /^\d{1,12}$/.test(releaseIdRaw) ? releaseIdRaw : null;
        if (releaseIdRaw && !releaseId) warnings.push(`release_id “${releaseIdRaw}” isn't a number; matched by text instead.`);
        const formatRaw = get("format");
        const dateAddedRaw = get("date_added");
        const dateAdded = parseDateAdded(dateAddedRaw);
        if (dateAddedRaw && !dateAdded) warnings.push(`Couldn't read Date Added “${dateAddedRaw}”; using the import time.`);
        const custom: Record<string, string> = {};
        for (const h of preserved) {
          const v = r.cells[csv.headers.indexOf(h)];
          if (v) custom[h] = v;
        }
        const group = formatGroup(formatRaw);
        const fields: Record<string, unknown> = {
          artist_text: displayArtist(artistRaw) || artistRaw,
          title_text: title,
          label_text: get("label") || null,
          catno_text: get("catno") && get("catno") !== "none" ? get("catno") : null,
          format_raw: formatRaw || null,
          format_group: formatRaw ? group : "Other",
          release_year: parseYear(get("released")),
          date_added: dateAdded,
        };
        if (isCollection) {
          fields.media_condition = mapCondition(get("media_condition"), warnings, "media condition");
          fields.sleeve_condition = mapCondition(get("sleeve_condition"), warnings, "sleeve condition");
          fields.source_folder = get("folder") || null;
        }
        const normalised = {
          release_id: releaseId, artist: artistRaw, title, label: get("label"), catno: get("catno"), format: formatRaw,
          released: get("released"), rating: get("rating"), folder: get("folder"), date_added: dateAddedRaw,
          media: get("media_condition"), sleeve: get("sleeve_condition"), notes: get("notes"), custom,
        };
        return {
          rowNumber: r.rowNumber,
          externalId: releaseId,
          identityKey: releaseId ? `r:${releaseId}` : `t:${normKey(artistRaw)}|${normKey(title)}|${normKey(get("catno"))}`,
          contentHash: contentHash(normalised),
          target: isCollection ? (group === "Digital" ? "digital" : "physical") : "want",
          fields,
          source: {
            ...normalised,
            discogs_url: releaseId ? `https://www.discogs.com/release/${releaseId}` : null,
            line: r.line,
            original_columns: source,
          },
          errors,
          warnings,
        };
      });
      return { kind, rows, playlists: [], notices, columns: { recognised, preserved } };
    },
  };
}

export const discogsCollectionAdapter = makeAdapter("discogs_collection");
export const discogsWantlistAdapter = makeAdapter("discogs_wantlist");
