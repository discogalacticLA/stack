/**
 * Rekordbox collection XML ("File → Export Collection in xml format").
 *
 * Structure (per Pioneer DJ's published "XML format list"; re-verify — see docs/IMPORTS.md):
 *   <DJ_PLAYLISTS Version="1.0.0">
 *     <PRODUCT Name="rekordbox" Version="…" Company="…"/>
 *     <COLLECTION Entries="n">
 *       <TRACK TrackID Name Artist Composer Album Grouping Genre Kind Size TotalTime DiscNumber
 *              TrackNumber Year AverageBpm DateAdded BitRate SampleRate Comments PlayCount Rating
 *              Location Remixer Tonality Label Mix>
 *         <TEMPO Inizio Bpm Metro Battito/>  <POSITION_MARK Name Type Start End Num/>
 *       </TRACK>
 *     </COLLECTION>
 *     <PLAYLISTS><NODE Type="0" Name="ROOT"> … <NODE Type="1" Name KeyType Entries><TRACK Key/></NODE></NODE></PLAYLISTS>
 *   </DJ_PLAYLISTS>
 * NODE Type 0 = folder, 1 = playlist. KeyType 0 = TrackID, 1 = Location.
 * Rating is stored as 0/51/102/153/204/255 for 0–5 stars.
 *
 * Security: DOCTYPE and ENTITY declarations are refused outright, so no external or custom
 * entities are ever resolved. Only the five predefined XML entities and numeric references are decoded.
 * Privacy: Location (file path), Comments, cue points and tempo maps are private source data.
 * This adapter reads the file only; nothing is written back to Rekordbox.
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { contentHash, ImportFileError, normKey } from "../text.js";
import { MAX_IMPORT_ROWS, type ImportAdapter, type ParsedImport, type ParsedPlaylistNode, type ParsedRow } from "./types.js";

const KNOWN_TRACK_ATTRS = new Set([
  "TrackID", "Name", "Artist", "Composer", "Album", "Grouping", "Genre", "Kind", "Size", "TotalTime", "DiscNumber", "TrackNumber", "Year",
  "AverageBpm", "DateModified", "DateAdded", "BitRate", "SampleRate", "Comments", "PlayCount", "LastPlayed", "Rating", "Location", "Remixer",
  "Tonality", "Label", "Mix", "Colour",
]);

const asArray = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function int(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function ratingStars(raw: unknown, warnings: string[]): number | null {
  const n = int(raw);
  if (n == null) return null;
  const allowed = [0, 51, 102, 153, 204, 255];
  if (!allowed.includes(n)) warnings.push(`Unusual Rating value ${n}; rounded to the nearest star.`);
  return Math.max(0, Math.min(5, Math.round(n / 51)));
}

export function fileFormatFromKind(kind: string | undefined, location: string | null): string | null {
  const k = (kind ?? "").trim();
  const m = /^([A-Za-z0-9]+)\s+File$/i.exec(k);
  if (m) return m[1].toUpperCase();
  if (k) return k.slice(0, 20);
  const ext = location ? /\.([a-z0-9]{2,5})$/i.exec(location)?.[1] : null;
  return ext ? ext.toUpperCase() : null;
}

/** file://localhost/Users/a/Music/x.mp3 → /Users/a/Music/x.mp3 (kept private). */
export function decodeLocation(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/^file:\/\/localhost/i, "").replace(/^file:\/\//i, "");
  try { return decodeURIComponent(s); } catch { return s; }
}

function checkSafe(text: string) {
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new ImportFileError("This XML file contains a DOCTYPE or ENTITY declaration. Rekordbox exports don't include these, and they're refused for safety (external entities are never resolved).");
  }
}

export const rekordboxAdapter: ImportAdapter = {
  kind: "rekordbox",
  label: "Rekordbox collection XML",
  accept: ".xml,text/xml,application/xml",
  parse(text: string): ParsedImport {
    checkSafe(text);
    const valid = XMLValidator.validate(text);
    if (valid !== true) {
      throw new ImportFileError(`The XML is malformed near line ${valid.err.line}, column ${valid.err.col}: ${valid.err.msg.replace(/\.+$/, "")}. Re-export the collection from Rekordbox.`);
    }
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: false,
      parseTagValue: false,
      processEntities: true,
      htmlEntities: false,
      allowBooleanAttributes: true,
      isArray: (name) => ["TRACK", "NODE", "TEMPO", "POSITION_MARK"].includes(name),
    });
    const doc = parser.parse(text);
    const root = doc?.DJ_PLAYLISTS;
    if (!root) throw new ImportFileError("This isn't a Rekordbox collection XML file (no <DJ_PLAYLISTS> root). In Rekordbox use File → Export Collection in xml format.");
    const product = asArray(root.PRODUCT)[0] as any;
    const notices: string[] = [];
    if (product) notices.push(`Exported by ${product.Name ?? "unknown"} ${product.Version ?? ""}`.trim() + ".");
    if (root.Version && root.Version !== "1.0.0") notices.push(`XML format version ${root.Version} hasn't been tested; fields are read by name.`);
    const collection = asArray(root.COLLECTION)[0] as any;
    const tracks = asArray(collection?.TRACK) as any[];
    if (!collection) notices.push("No <COLLECTION> element found; only playlists (if any) can be read.");
    if (collection?.Entries && Number(collection.Entries) !== tracks.length) {
      notices.push(`The file says it has ${collection.Entries} tracks but contains ${tracks.length}. The export may be incomplete.`);
    }
    if (tracks.length > MAX_IMPORT_ROWS) throw new ImportFileError(`This collection has more than ${MAX_IMPORT_ROWS.toLocaleString()} tracks, above the prototype's limit.`);

    const seenIds = new Set<string>();
    const unknownAttrs = new Set<string>();
    const rows: ParsedRow[] = tracks.map((t, idx) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const id = String(t.TrackID ?? "").trim();
      if (!id) errors.push("TRACK has no TrackID.");
      else if (seenIds.has(id)) errors.push(`TrackID ${id} appears more than once in this file; only the first is used.`);
      seenIds.add(id);
      for (const k of Object.keys(t)) if (!KNOWN_TRACK_ATTRS.has(k) && k !== "TEMPO" && k !== "POSITION_MARK") unknownAttrs.add(k);
      const location = decodeLocation(t.Location);
      let title = String(t.Name ?? "").trim();
      if (!title) {
        const file = location?.split("/").pop();
        if (file) { title = file; warnings.push("Track has no title; showing its file name."); }
        else errors.push("Track has no title or file location.");
      }
      const artist = String(t.Artist ?? "").trim() || "Unknown artist";
      if (!t.Artist) warnings.push("Track has no artist.");
      const bpm = t.AverageBpm != null && t.AverageBpm !== "" ? Number(t.AverageBpm) : null;
      const bpmX100 = bpm != null && Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm * 100) : null;
      const year = int(t.Year);
      const dateAdded = /^\d{4}-\d{2}-\d{2}$/.test(String(t.DateAdded ?? "")) ? new Date(`${t.DateAdded}T00:00:00Z`).toISOString() : null;
      const cues = asArray(t.POSITION_MARK).map((p: any) => ({ name: p.Name ?? "", type: p.Type, start: p.Start, end: p.End, num: p.Num }));
      const tempo = asArray(t.TEMPO).map((p: any) => ({ inizio: p.Inizio, bpm: p.Bpm, metro: p.Metro, battito: p.Battito }));
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(t)) if (typeof v === "string") attrs[k] = v;
      const fields = {
        granularity: "track",
        artist_text: artist,
        title_text: title,
        version_text: String(t.Mix ?? "").trim() || null,
        album_text: String(t.Album ?? "").trim() || null,
        label_text: String(t.Label ?? "").trim() || null,
        genre_text: String(t.Genre ?? "").trim() || null,
        release_year: year && year >= 1900 && year <= 2100 ? year : null,
        file_format: fileFormatFromKind(t.Kind, location),
        bitrate_kbps: int(t.BitRate),
        sample_rate_hz: int(t.SampleRate),
        duration_seconds: int(t.TotalTime),
        file_size_bytes: int(t.Size),
        bpm_x100: bpmX100,
        musical_key: String(t.Tonality ?? "").trim() || null,
        rating: ratingStars(t.Rating, warnings),
        play_count: int(t.PlayCount),
        file_location: location,
        source_comments: String(t.Comments ?? "").trim() || null,
        date_added: dateAdded,
      };
      return {
        rowNumber: idx + 1,
        externalId: id || null,
        identityKey: `id:${id}`,
        contentHash: contentHash(attrs),
        fingerprintHints: [
          location && t.Size ? `loc:${location}|${t.Size}` : "",
          `meta:${normKey(artist)}|${normKey(title)}|${normKey(String(t.Mix ?? ""))}|${t.TotalTime ?? ""}`,
        ].filter(Boolean),
        target: "digital",
        fields,
        source: { attributes: attrs, cues, tempo },
        errors,
        warnings,
      };
    });
    if (unknownAttrs.size) notices.push(`Preserved unfamiliar track attributes as private source data: ${[...unknownAttrs].join(", ")}.`);
    const cueCount = rows.reduce((n, r) => n + ((r.source.cues as unknown[]).length ?? 0), 0);
    if (cueCount) notices.push(`${cueCount} cue/loop markers kept as private source information (read-only; not editable or re-exportable).`);

    const walk = (node: any): ParsedPlaylistNode => ({
      name: String(node.Name ?? "(unnamed)"),
      type: String(node.Type) === "1" ? "playlist" : "folder",
      keyType: String(node.KeyType) === "1" ? "location" : "id",
      trackKeys: asArray(node.TRACK).map((tr: any) => String(tr.Key ?? "")).filter(Boolean),
      children: asArray(node.NODE).map(walk),
    });
    const playlistsRoot = asArray(root.PLAYLISTS)[0] as any;
    const top = asArray(playlistsRoot?.NODE);
    // The exported tree starts at a ROOT folder; import its children.
    const playlists = top.length === 1 && String(top[0].Name).toUpperCase() === "ROOT" ? asArray(top[0].NODE).map(walk) : top.map(walk);
    return { kind: "rekordbox", rows, playlists, notices };
  },
};
