/**
 * Converts one Discogs XML record into a normalised object. Pure functions: no database access.
 * Invalid records throw RecordError (logged, import continues). Original display text is kept;
 * normalised variants are computed separately.
 *
 * Element names follow the published dump format (artists/labels/masters/releases). Both the
 * newer `<release id="…">` attribute form and an `<id>` child are accepted for robustness.
 */
import { normalizeCode, normalizeName, parseDuration, yearFromReleased } from "../../catalog-api/normalize.js";
import { parseYouTubeId } from "../../../lib/mediaLinks.js";
import { child, childrenOf, text, type XNode } from "./stream.js";

export class RecordError extends Error {
  constructor(message: string, public externalId: string | null = null) {
    super(message);
  }
}

const MAX = { name: 1000, title: 2000, profile: 20_000, notes: 20_000, short: 500 };
const clip = (s: string | null, n: number) => (s == null ? null : s.length > n ? s.slice(0, n) : s);

function discogsId(v: string | null | undefined, what: string, required = true): number | null {
  if (v == null || v === "") {
    if (required) throw new RecordError(`${what}: missing id`);
    return null;
  }
  if (!/^\d{1,12}$/.test(v.trim())) throw new RecordError(`${what}: id “${v.slice(0, 40)}” is not a number`);
  return Number(v.trim());
}

function recordId(n: XNode, what: string): number {
  return discogsId(n.attrs.id ?? text(n, "id"), what)!;
}

export interface Credit { discogs_artist_id: number | null; name: string; anv: string | null; join: string; role: string | null; tracks: string | null }

function credits(n: XNode | undefined): Credit[] {
  return childrenOf(n, "artist").map((a) => ({
    discogs_artist_id: discogsId(text(a, "id"), "artist credit", false),
    name: clip(text(a, "name"), MAX.name) ?? "Unknown artist",
    anv: clip(text(a, "anv"), MAX.name),
    join: clip(child(a, "join")?.text ?? "", 50)!.trim(),
    role: clip(text(a, "role"), MAX.short),
    tracks: clip(text(a, "tracks"), MAX.short),
  }));
}

/** Discogs join text is usually ",", "&", "Feat.", "Vs." — render it with sensible spacing. */
export function joinText(j: string): string {
  if (!j) return "";
  if (j === ",") return ", ";
  return ` ${j} `;
}

// ───────────────────────── Artists ─────────────────────────
export interface ArtistRecord {
  discogs_id: number; name: string; normalized_name: string | null; real_name: string | null; profile: string | null; urls: string[]; data_quality: string | null;
  aliases: { discogs_id: number | null; name: string }[];
  name_variations: string[];
  members: { discogs_id: number | null; name: string }[];
}

export function artistFromNode(n: XNode): ArtistRecord {
  const discogs_id = recordId(n, "artist");
  const name = clip(text(n, "name"), MAX.name);
  if (!name) throw new RecordError("artist has no name", String(discogs_id));
  const named = (el: XNode | undefined) => childrenOf(el, "name").map((x) => ({ discogs_id: discogsId(x.attrs.id, "alias", false), name: clip(x.text.trim(), MAX.name)! })).filter((x) => x.name);
  return {
    discogs_id, name, normalized_name: normalizeName(name), real_name: clip(text(n, "realname"), MAX.name), profile: clip(text(n, "profile"), MAX.profile),
    urls: childrenOf(child(n, "urls"), "url").map((u) => u.text.trim()).filter(Boolean).slice(0, 50),
    data_quality: clip(text(n, "data_quality"), 50),
    aliases: named(child(n, "aliases")).slice(0, 500),
    name_variations: [...new Set(childrenOf(child(n, "namevariations"), "name").map((x) => clip(x.text.trim(), MAX.name)!).filter(Boolean))].slice(0, 500),
    // <members> lists <name id="…"> (older dumps also repeat <id>); groups are derived from members.
    members: named(child(n, "members")).slice(0, 500),
  };
}

// ───────────────────────── Labels ─────────────────────────
export interface LabelRecord {
  discogs_id: number; name: string; normalized_name: string | null; profile: string | null; contact_info: string | null; urls: string[];
  data_quality: string | null; parent_discogs_id: number | null;
}

export function labelFromNode(n: XNode): LabelRecord {
  const discogs_id = recordId(n, "label");
  const name = clip(text(n, "name"), MAX.name);
  if (!name) throw new RecordError("label has no name", String(discogs_id));
  const parent = child(n, "parentLabel");
  return {
    discogs_id, name, normalized_name: normalizeName(name), profile: clip(text(n, "profile"), MAX.profile), contact_info: clip(text(n, "contactinfo"), MAX.short * 4),
    urls: childrenOf(child(n, "urls"), "url").map((u) => u.text.trim()).filter(Boolean).slice(0, 50),
    data_quality: clip(text(n, "data_quality"), 50),
    parent_discogs_id: parent ? discogsId(parent.attrs.id ?? text(parent, "id"), "parent label", false) : null,
  };
}

// ───────────────────────── Masters ─────────────────────────
export interface MasterRecord {
  discogs_id: number; title: string; normalized_title: string | null; year: number | null; main_release_discogs_id: number | null;
  data_quality: string | null; notes: string | null; artists: Credit[]; genres: string[]; styles: string[];
}

const terms = (n: XNode, group: string, item: string) => [...new Set(childrenOf(child(n, group), item).map((g) => clip(g.text.trim(), 100)!).filter(Boolean))].slice(0, 50);

export function masterFromNode(n: XNode): MasterRecord {
  const discogs_id = recordId(n, "master");
  const title = clip(text(n, "title"), MAX.title);
  if (!title) throw new RecordError("master has no title", String(discogs_id));
  const y = text(n, "year");
  return {
    discogs_id, title, normalized_title: normalizeName(title),
    year: y && /^\d{4}$/.test(y) && Number(y) > 0 ? Number(y) : null,
    main_release_discogs_id: discogsId(text(n, "main_release"), "main release", false),
    data_quality: clip(text(n, "data_quality"), 50), notes: clip(text(n, "notes"), MAX.notes),
    artists: credits(child(n, "artists")), genres: terms(n, "genres", "genre"), styles: terms(n, "styles", "style"),
  };
}

// ───────────────────────── Releases ─────────────────────────
export interface TrackRecord {
  position: string; title: string; duration: string | null; duration_seconds: number | null; track_type: "track" | "index" | "heading" | "subtrack";
  artists: Credit[]; extra_artists: Credit[]; sub_tracks: TrackRecord[];
}

export interface ReleaseRecord {
  discogs_id: number; status: string | null; title: string; normalized_title: string | null; year: number | null; released: string | null;
  country: string | null; notes: string | null; data_quality: string | null; master_discogs_id: number | null; is_main_release: boolean;
  artists: Credit[]; extra_artists: Credit[];
  labels: { discogs_id: number | null; name: string; catno: string | null }[];
  /** <series><series name catno id/></series>: series share the label id space. */
  series: { discogs_id: number | null; name: string; catno: string | null }[];
  companies: { discogs_id: number | null; name: string; catno: string | null; entity_type: number | null; role: string }[];
  formats: { name: string; qty: number | null; text: string | null; descriptions: string[] }[];
  genres: string[]; styles: string[];
  tracks: TrackRecord[];
  identifiers: { type: string; value: string; description: string | null }[];
  videos: { youtube_id: string; title: string | null }[];
}

function track(t: XNode, sub: boolean): TrackRecord {
  const position = clip(text(t, "position"), 50) ?? "";
  const title = clip(text(t, "title"), MAX.title) ?? "";
  const duration = clip(text(t, "duration"), 20);
  const subs = childrenOf(child(t, "sub_tracks"), "track").map((s) => track(s, true));
  const type = subs.length ? "index" : sub ? "subtrack" : !position && !duration ? "heading" : "track";
  return { position, title, duration, duration_seconds: parseDuration(duration), track_type: type, artists: credits(child(t, "artists")), extra_artists: credits(child(t, "extraartists")), sub_tracks: subs };
}

export function releaseFromNode(n: XNode): ReleaseRecord {
  const discogs_id = recordId(n, "release");
  const title = clip(text(n, "title"), MAX.title);
  if (!title) throw new RecordError("release has no title", String(discogs_id));
  const masterEl = child(n, "master_id");
  const released = clip(text(n, "released"), 20);
  const tracks = childrenOf(child(n, "tracklist"), "track").slice(0, 2000).map((t) => track(t, false)).filter((t) => t.title || t.position);
  return {
    discogs_id, status: clip(n.attrs.status ?? text(n, "status"), 30), title, normalized_title: normalizeName(title),
    year: yearFromReleased(released), released, country: clip(text(n, "country"), 100), notes: clip(text(n, "notes"), MAX.notes),
    data_quality: clip(text(n, "data_quality"), 50),
    master_discogs_id: masterEl ? discogsId(masterEl.text.trim(), "master reference", false) : null,
    is_main_release: masterEl?.attrs.is_main_release === "true",
    artists: credits(child(n, "artists")),
    extra_artists: credits(child(n, "extraartists")),
    labels: childrenOf(child(n, "labels"), "label").map((l) => ({
      discogs_id: discogsId(l.attrs.id, "label reference", false), name: clip(l.attrs.name ?? "", MAX.name) || "Unknown label",
      catno: clip(l.attrs.catno && l.attrs.catno.toLowerCase() !== "none" ? l.attrs.catno : null, 200),
    })).slice(0, 50),
    series: childrenOf(child(n, "series"), "series").map((x) => ({
      discogs_id: discogsId(x.attrs.id, "series reference", false), name: clip(x.attrs.name ?? "", MAX.name) || "Unknown series",
      catno: clip(x.attrs.catno && x.attrs.catno.toLowerCase() !== "none" ? x.attrs.catno : null, 200),
    })).slice(0, 50),
    companies: childrenOf(child(n, "companies"), "company").map((c) => ({
      discogs_id: discogsId(text(c, "id"), "company", false), name: clip(text(c, "name"), MAX.name) ?? "Unknown company",
      catno: clip(text(c, "catno"), 200), entity_type: /^\d+$/.test(text(c, "entity_type") ?? "") ? Number(text(c, "entity_type")) : null,
      role: clip(text(c, "entity_type_name"), 100) ?? "Company",
    })).slice(0, 200),
    formats: childrenOf(child(n, "formats"), "format").map((f) => ({
      name: clip(f.attrs.name ?? "", 100) || "Unknown",
      qty: /^\d{1,4}$/.test(f.attrs.qty ?? "") ? Number(f.attrs.qty) : null,
      text: clip(f.attrs.text || null, MAX.short),
      descriptions: childrenOf(child(f, "descriptions"), "description").map((d) => clip(d.text.trim(), 100)!).filter(Boolean).slice(0, 30),
    })).slice(0, 50),
    genres: terms(n, "genres", "genre"), styles: terms(n, "styles", "style"),
    tracks,
    identifiers: childrenOf(child(n, "identifiers"), "identifier").map((i) => ({
      type: clip(i.attrs.type ?? "Other", 60) || "Other", value: clip(i.attrs.value ?? "", 500) ?? "", description: clip(i.attrs.description || null, MAX.short),
    })).filter((i) => i.value).slice(0, 200),
    videos: childrenOf(child(n, "videos"), "video").map((v) => ({ youtube_id: parseYouTubeId(v.attrs.src ?? ""), title: clip(text(v, "title"), 300) }))
      .filter((v): v is { youtube_id: string; title: string | null } => !!v.youtube_id).slice(0, 30),
  };
}

/** Primary display values derived from the full record (first label, first format). */
export function releasePrimary(r: ReleaseRecord) {
  const l = r.labels[0];
  const f = r.formats[0];
  return {
    catalog_number: l?.catno ?? null,
    catalog_number_norm: normalizeCode(l?.catno ?? null),
    format: f?.name ?? "Unknown",
    format_details: f ? [f.qty && f.qty > 1 ? `${f.qty}×` : "", ...f.descriptions, f.text ?? ""].filter(Boolean).join(", ") || null : null,
  };
}
