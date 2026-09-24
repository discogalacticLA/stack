/**
 * Catalog reads for the web app: browsing, master/release pages, comparison and duplicate hints.
 * Vocabulary: a MASTER groups the versions of one work; a RELEASE is one published version
 * (a specific pressing/issue). Releases may have no master. Catalog rows never hold ownership data.
 */
import type { DB } from "../db/index.js";
import { normalizeCode } from "../services/catalog-api/normalize.js";
import { searchBackend } from "../services/search/index.js";

export const normalizeCatno = (catno: string | null | undefined) => normalizeCode(catno);

// ───────────────────────── Credits ─────────────────────────
const creditText = (rows: { name: string; anv: string | null; join_text: string }[]) =>
  rows.map((r) => (r.anv || r.name) + r.join_text).join("").trim() || "Unknown artist";

export function masterCredits(db: DB, masterIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  const q = db.prepare("SELECT name, anv, join_text FROM master_artists WHERE master_id = ? ORDER BY position");
  for (const id of new Set(masterIds)) map.set(id, creditText(q.all(id) as any[]));
  return map;
}

export function releaseCredit(db: DB, releaseId: number): string {
  return creditText(db.prepare("SELECT name, anv, join_text FROM release_artists WHERE release_id = ? ORDER BY position").all(releaseId) as any[]);
}

export function artistCredit(db: DB, masterId: number): string {
  return masterCredits(db, [masterId]).get(masterId)!;
}

/** Credit for a release: its master's credit when it has one, otherwise its own. */
export function creditForRelease(db: DB, r: { id: number; master_id: number | null }): string {
  return r.master_id ? artistCredit(db, r.master_id) : releaseCredit(db, r.id);
}

// ───────────────────────── Browsing ("Discover") ─────────────────────────
export interface SearchParams {
  q: string;
  terms: string[];
  termMode: "any" | "all";
  formats: string[];
  countries: string[];
  yearFrom: number | null;
  yearTo: number | null;
  forSale: boolean;
  sort: "relevance" | "title" | "artist" | "year_asc" | "year_desc" | "price_asc";
  page: number;
  pageSize: number;
}

/** One result per work: a master with its matching versions, or a release that has no master. */
export interface SearchResult {
  kind: "master" | "release";
  id: number;
  master_id: number | null;
  title: string;
  artist: string;
  version_count: number;
  matched_release_ids: number[];
  primary_release: { id: number; catalog_number: string | null; label: string | null; format: string; format_details: string | null; country: string | null; year: number | null };
  image_id: number | null;
  earliest_year: number | null;
  for_sale_count: number;
  min_price_cents: number | null;
}

const SORTS: Record<SearchParams["sort"], string> = {
  relevance: "best_rank, title COLLATE NOCASE",
  title: "title COLLATE NOCASE, gkey",
  artist: "artist_sort COLLATE NOCASE, title COLLATE NOCASE",
  year_asc: "earliest_year IS NULL, earliest_year, title COLLATE NOCASE",
  year_desc: "earliest_year IS NULL, earliest_year DESC, title COLLATE NOCASE",
  price_asc: "min_price IS NULL, min_price, title COLLATE NOCASE",
};

/** Text search narrows to at most this many releases before filters apply (documented limit). */
export const MAX_TEXT_CANDIDATES = 5000;

export function browseCatalog(db: DB, p: SearchParams): { total: number; results: SearchResult[]; truncated: boolean } {
  const where: string[] = [];
  const args: unknown[] = [];
  let rankJoin = "";
  let truncated = false;
  if (p.q.trim()) {
    // Text search goes through the search backend (FTS today); structured filters apply in SQL.
    const hits = searchBackend(db).search(p.q, { types: ["release"], limit: MAX_TEXT_CANDIDATES });
    truncated = hits.length >= MAX_TEXT_CANDIDATES;
    if (!hits.length) return { total: 0, results: [], truncated: false };
    rankJoin = "JOIN (SELECT CAST(value AS INTEGER) AS rid, CAST(key AS INTEGER) AS rnk FROM json_each(?)) hit ON hit.rid = e.id";
    args.push(JSON.stringify(hits.map((h) => h.id)));
  }
  if (p.formats.length) { where.push(`e.format IN (${p.formats.map(() => "?").join(",")})`); args.push(...p.formats); }
  if (p.countries.length) { where.push(`e.country IN (${p.countries.map(() => "?").join(",")})`); args.push(...p.countries); }
  if (p.yearFrom != null) { where.push("e.year >= ?"); args.push(p.yearFrom); }
  if (p.yearTo != null) { where.push("e.year <= ?"); args.push(p.yearTo); }
  if (p.terms.length) {
    const ph = p.terms.map(() => "?").join(",");
    const termSet = `(SELECT genre AS t FROM release_genres WHERE release_id = e.id UNION SELECT style FROM release_styles WHERE release_id = e.id)`;
    if (p.termMode === "all") {
      where.push(`(SELECT COUNT(DISTINCT t) FROM ${termSet} WHERE t IN (${ph})) = ?`);
      args.push(...p.terms, new Set(p.terms).size);
    } else {
      where.push(`EXISTS (SELECT 1 FROM ${termSet} WHERE t IN (${ph}))`);
      args.push(...p.terms);
    }
  }
  if (p.forSale) where.push("EXISTS (SELECT 1 FROM listings li WHERE li.release_id = e.id AND li.status = 'available')");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const base = `
    SELECT COALESCE('m' || e.master_id, 'r' || e.id) AS gkey, e.master_id,
      MIN(e.id) AS any_release_id,
      COALESCE(m.title, MIN(e.title)) AS title,
      ${rankJoin ? "MIN(hit.rnk)" : "0"} AS best_rank,
      GROUP_CONCAT(e.id) AS matched_ids,
      MIN(e.year) AS earliest_year,
      MIN((SELECT MIN(li.price_cents) FROM listings li WHERE li.status = 'available' AND li.release_id = e.id)) AS min_price,
      MIN(COALESCE((SELECT ma.name FROM master_artists ma WHERE ma.master_id = e.master_id ORDER BY ma.position LIMIT 1),
                   (SELECT ra.name FROM release_artists ra WHERE ra.release_id = e.id ORDER BY ra.position LIMIT 1))) AS artist_sort
    FROM releases e ${rankJoin}
    LEFT JOIN masters m ON m.id = e.master_id
    ${whereSql}
    GROUP BY gkey`;

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...args) as { n: number }).n;
  const rows = db.prepare(`${base} ORDER BY ${SORTS[p.sort] ?? SORTS.relevance} LIMIT ? OFFSET ?`).all(...args, p.pageSize, (p.page - 1) * p.pageSize) as any[];

  const primaryQ = db.prepare(`SELECT e.id, e.catalog_number, l.name AS label, e.format, e.format_details, e.country, e.year FROM releases e LEFT JOIN labels l ON l.id = e.label_id WHERE e.id = ?`);
  const imageQ = db.prepare(`SELECT ai.id FROM archive_images ai JOIN releases e ON e.id = ai.release_id WHERE (e.master_id = ? OR e.id = ?) ORDER BY (ai.release_id = ?) DESC, ai.kind = 'front' DESC, ai.id LIMIT 1`);
  const versionsQ = db.prepare("SELECT COUNT(*) AS n FROM releases WHERE master_id = ?");
  const saleQ = db.prepare(`SELECT COUNT(*) AS n FROM listings li JOIN releases e ON e.id = li.release_id WHERE li.status = 'available' AND (e.master_id = ? OR e.id = ?)`);
  const results: SearchResult[] = rows.map((r) => {
    const matched = String(r.matched_ids).split(",").map(Number).sort((a, b) => a - b);
    const isMaster = r.master_id != null;
    return {
      kind: isMaster ? "master" : "release",
      id: isMaster ? r.master_id : r.any_release_id,
      master_id: r.master_id,
      title: r.title,
      artist: isMaster ? artistCredit(db, r.master_id) : releaseCredit(db, r.any_release_id),
      version_count: isMaster ? (versionsQ.get(r.master_id) as any).n : 1,
      matched_release_ids: matched,
      primary_release: primaryQ.get(matched[0]) as SearchResult["primary_release"],
      image_id: (imageQ.get(r.master_id ?? -1, r.any_release_id, matched[0]) as any)?.id ?? null,
      earliest_year: r.earliest_year,
      for_sale_count: (saleQ.get(r.master_id ?? -1, isMaster ? -1 : r.any_release_id) as any).n,
      min_price_cents: r.min_price,
    };
  });
  return { total, results, truncated };
}

export function facetValues(db: DB) {
  const col = (sql: string) => db.prepare(sql).all().map((r: any) => r.v as string);
  return {
    genres: col("SELECT DISTINCT genre AS v FROM release_genres ORDER BY genre LIMIT 200"),
    styles: col("SELECT DISTINCT style AS v FROM release_styles ORDER BY style LIMIT 500"),
    formats: col("SELECT DISTINCT format AS v FROM releases ORDER BY format LIMIT 100"),
    countries: col("SELECT DISTINCT country AS v FROM releases WHERE country IS NOT NULL ORDER BY country LIMIT 300"),
  };
}

// ───────────────────────── Masters & releases ─────────────────────────
export interface ReleaseSummary {
  id: number;
  master_id: number | null;
  discogs_release_id: number | null;
  title: string;
  label_id: number | null;
  label: string | null;
  catalog_number: string | null;
  format: string;
  format_details: string | null;
  country: string | null;
  year: number | null;
  released_date: string | null;
  date_note: string | null;
  notes: string | null;
  verification_status: string;
  data_quality: string | null;
  for_sale_count: number;
  min_price_cents: number | null;
  track_count: number;
}

const RELEASE_SELECT = `
  SELECT e.*, l.name AS label,
    (SELECT COUNT(*) FROM listings li WHERE li.release_id = e.id AND li.status = 'available') AS for_sale_count,
    (SELECT MIN(price_cents) FROM listings li WHERE li.release_id = e.id AND li.status = 'available') AS min_price_cents,
    (SELECT COUNT(*) FROM release_tracks t WHERE t.release_id = e.id AND t.track_type = 'track') AS track_count
  FROM releases e LEFT JOIN labels l ON l.id = e.label_id`;

export function getMaster(db: DB, id: number) {
  const master = db.prepare("SELECT * FROM masters WHERE id = ?").get(id) as any;
  if (!master) return null;
  const releases = db.prepare(`${RELEASE_SELECT} WHERE e.master_id = ? ORDER BY e.year IS NULL, e.year, e.id`).all(id) as ReleaseSummary[];
  return {
    ...master,
    artists: db.prepare("SELECT artist_id AS id, COALESCE(anv, name) AS name, join_text FROM master_artists WHERE master_id = ? ORDER BY position").all(id) as any[],
    artist: artistCredit(db, id),
    genres: db.prepare("SELECT DISTINCT genre FROM master_genres WHERE master_id = ? ORDER BY genre").all(id).map((r: any) => r.genre as string),
    styles: db.prepare("SELECT DISTINCT style FROM master_styles WHERE master_id = ? ORDER BY style").all(id).map((r: any) => r.style as string),
    releases,
  };
}

export function getReleaseSummary(db: DB, id: number): ReleaseSummary | null {
  return (db.prepare(`${RELEASE_SELECT} WHERE e.id = ?`).get(id) as ReleaseSummary) ?? null;
}

export function getReleaseDetail(db: DB, id: number) {
  const release = getReleaseSummary(db, id);
  if (!release) return null;
  const master = release.master_id ? getMaster(db, release.master_id) : null;
  return {
    release,
    master,
    siblings: master ? master.releases : [release],
    credit: releaseCredit(db, id),
    artists: db.prepare("SELECT artist_id AS id, COALESCE(anv, name) AS name, join_text FROM release_artists WHERE release_id = ? ORDER BY position").all(id) as any[],
    genres: db.prepare("SELECT DISTINCT genre FROM release_genres WHERE release_id = ? ORDER BY genre").all(id).map((r: any) => r.genre as string),
    styles: db.prepare("SELECT DISTINCT style FROM release_styles WHERE release_id = ? ORDER BY style").all(id).map((r: any) => r.style as string),
    labels: db.prepare("SELECT * FROM release_labels WHERE release_id = ? ORDER BY position, id").all(id) as any[],
    formats: (db.prepare("SELECT * FROM release_formats WHERE release_id = ? ORDER BY position, id").all(id) as any[]).map((f) => ({
      ...f, descriptions: db.prepare("SELECT description FROM release_format_descriptions WHERE format_id = ? ORDER BY position").all(f.id).map((d: any) => d.description as string),
    })),
    companies: db.prepare("SELECT rc.*, c.name FROM release_companies rc LEFT JOIN companies c ON c.id = rc.company_id WHERE rc.release_id = ? ORDER BY rc.position, rc.id").all(id) as any[],
    credits: db.prepare("SELECT * FROM release_extra_artists WHERE release_id = ? AND track_id IS NULL ORDER BY position, id").all(id) as any[],
    tracks: getTracks(db, id),
    identifiers: db.prepare("SELECT * FROM release_identifiers WHERE release_id = ? ORDER BY identifier_type, id").all(id) as any[],
    sources: db.prepare("SELECT s.*, u.display_name AS added_by_name FROM archival_sources s LEFT JOIN users u ON u.id = s.added_by WHERE s.release_id = ? ORDER BY s.id").all(id) as any[],
    images: db.prepare("SELECT * FROM archive_images WHERE release_id = ? ORDER BY kind = 'front' DESC, id").all(id) as any[],
    mediaLinks: db.prepare("SELECT id, provider, external_id, track_position, source_id, title FROM release_media_links WHERE release_id = ? ORDER BY track_position IS NOT NULL, track_position, id")
      .all(id) as { id: number; provider: string; external_id: string; track_position: string | null; source_id: number | null; title: string | null }[],
    revisions: db.prepare(
      `SELECT rv.*, pu.display_name AS proposed_by_name, au.display_name AS accepted_by_name FROM release_revisions rv
       LEFT JOIN users pu ON pu.id = rv.proposed_by LEFT JOIN users au ON au.id = rv.accepted_by WHERE rv.release_id = ? ORDER BY rv.id DESC`,
    ).all(id) as any[],
    unavailable: db.prepare("SELECT status, COUNT(*) AS n FROM listings WHERE release_id = ? AND status IN ('reserved','sold') GROUP BY status").all(id) as { status: string; n: number }[],
    pendingProposals: (db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE target_release_id = ? AND status = 'pending'").get(id) as { n: number }).n,
    discogsUrl: release.discogs_release_id ? `https://www.discogs.com/release/${release.discogs_release_id}` : null,
  };
}

export interface TrackRow { id: number; position: string; title: string; artist_credit: string | null; duration_seconds: number | null; duration: string | null; track_type: string; parent_track_id: number | null }

export function getTracks(db: DB, releaseId: number): TrackRow[] {
  return db.prepare("SELECT id, position, title, artist_credit, duration_seconds, duration, track_type, parent_track_id FROM release_tracks WHERE release_id = ? ORDER BY sequence, id").all(releaseId) as TrackRow[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** '1981-05-10' → '10 May 1981', '1981-05' → 'May 1981', '1981-00-00' → '1981'. */
export function formatDate(e: { released_date?: string | null; year?: number | null }): string {
  const s = e.released_date ?? (e.year ? String(e.year) : "");
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(s);
  if (!m) return "Unknown";
  const [, y, mo, d] = m;
  if (!mo || mo === "00" || Number(mo) > 12) return y;
  if (!d || d === "00") return `${MONTHS[Number(mo) - 1]} ${y}`;
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
}

export function formatDuration(s: number | null): string {
  if (s == null) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatText(f: { name: string; quantity: number | null; text: string | null; descriptions: string[] }) {
  return [f.quantity && f.quantity > 1 ? `${f.quantity}×` : "", f.name, f.descriptions.length ? `, ${f.descriptions.join(", ")}` : "", f.text ? ` (${f.text})` : ""].join("");
}

// ───────────────────────── Comparing releases ─────────────────────────
export interface CompareRow { field: string; values: string[]; differs: boolean }

export function compareReleases(db: DB, ids: number[]) {
  const releases = ids.map((id) => getReleaseDetail(db, id)).filter((e): e is NonNullable<typeof e> => !!e);
  const identifierText = (e: (typeof releases)[number], type: string) =>
    e.identifiers.filter((i) => i.identifier_type === type).map((i) => i.value + (i.description ? ` (${i.description})` : "")).join("\n") || "—";
  const fields: [string, (e: (typeof releases)[number]) => string][] = [
    ["Title", (e) => `${e.credit} — ${e.release.title}`],
    ["Label", (e) => e.labels.map((l) => l.name).join("\n") || e.release.label || "Unknown"],
    ["Catalog number", (e) => e.labels.map((l) => l.catalog_number).filter(Boolean).join("\n") || e.release.catalog_number || "None / unknown"],
    ["Format", (e) => e.formats.map(formatText).join("\n") || e.release.format],
    ["Country", (e) => e.release.country ?? "Unknown"],
    ["Date", (e) => formatDate(e.release) + (e.release.date_note ? ` — ${e.release.date_note}` : "")],
    ["Barcode", (e) => identifierText(e, "Barcode")],
    ["Matrix / runout", (e) => identifierText(e, "Matrix / Runout")],
    ["Other identifiers", (e) => e.identifiers.filter((i) => !["Barcode", "Matrix / Runout"].includes(i.identifier_type)).map((i) => `${i.identifier_type}: ${i.value}`).join("\n") || "—"],
    ["Companies", (e) => e.companies.map((c) => `${c.role}: ${c.name ?? "?"}`).join("\n") || "—"],
    ["Track count", (e) => String(e.tracks.filter((t) => t.track_type === "track").length)],
    ["Notes", (e) => e.release.notes ?? "—"],
    ["Verification", (e) => e.release.verification_status],
    ["Sources cited", (e) => String(e.sources.length)],
  ];
  const rows: CompareRow[] = fields.map(([field, fn]) => {
    const values = releases.map(fn);
    return { field, values, differs: new Set(values).size > 1 };
  });
  const positions: string[] = [];
  for (const e of releases) for (const t of e.tracks) if (t.track_type === "track" && !positions.includes(t.position)) positions.push(t.position);
  const trackRows: CompareRow[] = positions.map((pos) => {
    const values = releases.map((e) => {
      const t = e.tracks.find((x) => x.position === pos && x.track_type === "track");
      return t ? `${t.title}${t.duration_seconds ? ` (${formatDuration(t.duration_seconds)})` : ""}` : "—";
    });
    return { field: pos, values, differs: new Set(values).size > 1 };
  });
  return { releases, rows, trackRows };
}

// ───────────────────────── Duplicate candidates ─────────────────────────
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export interface DuplicateCandidate { release: ReleaseSummary; title: string; artist: string; reasons: string[]; score: number }

/**
 * Simple, explainable matching — not an identification engine. Only looks at releases of the same
 * master and at releases whose normalised catalog number shares a prefix (an indexed range scan),
 * so it stays cheap on a large catalog.
 */
export function findDuplicateCandidates(
  db: DB,
  input: { master_id: number; label_id: number | null; catalog_number: string | null; format: string; country: string | null; year: number | null },
  excludeReleaseId?: number,
): DuplicateCandidate[] {
  const norm = normalizeCode(input.catalog_number);
  const pool = new Map<number, ReleaseSummary>();
  for (const r of db.prepare(`${RELEASE_SELECT} WHERE e.master_id = ? LIMIT 500`).all(input.master_id) as ReleaseSummary[]) pool.set(r.id, r);
  if (norm && norm.length >= 3) {
    const prefix = norm.slice(0, Math.max(3, norm.length - 2));
    for (const r of db.prepare(`${RELEASE_SELECT} WHERE e.catalog_number_norm >= ? AND e.catalog_number_norm < ? LIMIT 200`).all(prefix, prefix + "￿") as ReleaseSummary[]) pool.set(r.id, r);
  }
  const out: DuplicateCandidate[] = [];
  for (const e of pool.values()) {
    if (e.id === excludeReleaseId) continue;
    const reasons: string[] = [];
    let score = 0;
    const en = normalizeCode(e.catalog_number);
    if (norm && en) {
      if (en === norm) { reasons.push("Same catalog number (ignoring spaces, dashes and case)"); score += 5; }
      else if (levenshtein(en, norm) === 1 || en.startsWith(norm) || norm.startsWith(en)) { reasons.push(`Similar catalog number (${e.catalog_number})`); score += 2; }
    }
    if (e.master_id === input.master_id) {
      score += 1;
      if (e.format === input.format && (e.country ?? "") === (input.country ?? "")) { reasons.push("Same master, format and country"); score += 2; }
      if (input.year && e.year === input.year) { reasons.push("Same master and year"); score += 1; }
    }
    if (input.label_id && e.label_id === input.label_id && score >= 2) { reasons.push("Same label"); score += 1; }
    if (reasons.length && score >= 2) out.push({ release: e, title: e.title, artist: creditForRelease(db, e), reasons, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function listLabels(db: DB, limit = 200) {
  return db.prepare("SELECT id, name FROM labels ORDER BY name COLLATE NOCASE LIMIT ?").all(limit) as { id: number; name: string }[];
}

export function listMastersBrief(db: DB, limit = 1000) {
  const rows = db.prepare("SELECT id, title FROM masters ORDER BY title COLLATE NOCASE LIMIT ?").all(limit) as { id: number; title: string }[];
  const credits = masterCredits(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, artist: credits.get(r.id)! }));
}
