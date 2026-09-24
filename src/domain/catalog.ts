import type { DB } from "../db/index.js";

export function normalizeCatno(catno: string | null | undefined): string | null {
  if (!catno) return null;
  const n = catno.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return n.length ? n : null;
}

// ───────────────────────── Credits ─────────────────────────
export function artistCredits(db: DB, releaseIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  if (!releaseIds.length) return map;
  const rows = db
    .prepare(
      `SELECT ra.release_id, a.name, ra.join_text FROM release_artists ra JOIN artists a ON a.id = ra.artist_id
       WHERE ra.release_id IN (${releaseIds.map(() => "?").join(",")}) ORDER BY ra.release_id, ra.position`,
    )
    .all(...releaseIds) as { release_id: number; name: string; join_text: string }[];
  for (const r of rows) map.set(r.release_id, (map.get(r.release_id) ?? "") + r.name + r.join_text);
  for (const id of releaseIds) if (!map.has(id)) map.set(id, "Unknown artist");
  return map;
}

export function artistCredit(db: DB, releaseId: number): string {
  return artistCredits(db, [releaseId]).get(releaseId)!;
}

// ───────────────────────── Search ─────────────────────────
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

export interface SearchResult {
  release_id: number;
  title: string;
  release_type: string;
  artist: string;
  edition_count: number;
  matched_edition_ids: number[];
  primary_edition: { id: number; catalog_number: string | null; label: string | null; format: string; format_details: string | null; country: string | null; release_year: number | null };
  image_id: number | null;
  placeholder_seed: string | null;
  earliest_year: number | null;
  for_sale_count: number;
  min_price_cents: number | null;
  terms: string[];
}

const SORTS: Record<SearchParams["sort"], string> = {
  relevance: "score DESC, r.title COLLATE NOCASE",
  title: "r.title COLLATE NOCASE, r.id",
  artist: "artist_sort COLLATE NOCASE, r.title COLLATE NOCASE",
  year_asc: "earliest_year IS NULL, earliest_year, r.title COLLATE NOCASE",
  year_desc: "earliest_year IS NULL, earliest_year DESC, r.title COLLATE NOCASE",
  price_asc: "min_price IS NULL, min_price, r.title COLLATE NOCASE",
};

export function searchReleases(db: DB, p: SearchParams): { total: number; results: SearchResult[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  const scoreParts: string[] = [];
  const scoreArgs: unknown[] = [];

  // Each word must match at least one of: artist, release title, label, catalog number.
  const tokens = p.q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const t of tokens) {
    const like = `%${t.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const norm = normalizeCatno(t);
    where.push(`(
      r.title LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM release_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.release_id = r.id AND a.name LIKE ? ESCAPE '\\')
      OR l.name LIKE ? ESCAPE '\\'
      OR e.catalog_number LIKE ? ESCAPE '\\'
      ${norm ? "OR e.catalog_number_norm LIKE ?" : ""}
    )`);
    args.push(like, like, like, like);
    if (norm) args.push(`%${norm}%`);
    scoreParts.push("(CASE WHEN e.catalog_number_norm = ? THEN 5 ELSE 0 END)", "(CASE WHEN r.title LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END)");
    scoreArgs.push(norm ?? "", like);
  }
  if (p.formats.length) {
    where.push(`e.format IN (${p.formats.map(() => "?").join(",")})`);
    args.push(...p.formats);
  }
  if (p.countries.length) {
    where.push(`e.country IN (${p.countries.map(() => "?").join(",")})`);
    args.push(...p.countries);
  }
  if (p.yearFrom != null) {
    where.push("e.release_year >= ?");
    args.push(p.yearFrom);
  }
  if (p.yearTo != null) {
    where.push("e.release_year <= ?");
    args.push(p.yearTo);
  }
  if (p.terms.length) {
    const ph = p.terms.map(() => "?").join(",");
    if (p.termMode === "all") {
      where.push(`(SELECT COUNT(DISTINCT term) FROM release_terms rt WHERE rt.release_id = r.id AND rt.term IN (${ph})) = ?`);
      args.push(...p.terms, new Set(p.terms).size);
    } else {
      where.push(`EXISTS (SELECT 1 FROM release_terms rt WHERE rt.release_id = r.id AND rt.term IN (${ph}))`);
      args.push(...p.terms);
    }
  }
  if (p.forSale) {
    where.push("EXISTS (SELECT 1 FROM listings li WHERE li.edition_id = e.id AND li.status = 'available')");
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const score = scoreParts.length ? scoreParts.join(" + ") : "0";

  const base = `
    SELECT r.id AS release_id, r.title, r.release_type,
      MAX(${score}) AS score,
      GROUP_CONCAT(e.id) AS matched_ids,
      MIN(e.release_year) AS earliest_year,
      (SELECT MIN(li.price_cents) FROM listings li WHERE li.status = 'available' AND li.edition_id IN
         (SELECT e2.id FROM editions e2 WHERE e2.release_id = r.id)) AS min_price,
      (SELECT a.sort_name FROM release_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.release_id = r.id ORDER BY ra.position LIMIT 1) AS artist_sort
    FROM editions e
    JOIN releases r ON r.id = e.release_id
    LEFT JOIN labels l ON l.id = e.label_id
    ${whereSql}
    GROUP BY r.id`;
  const allArgs = [...scoreArgs, ...args];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...allArgs) as { n: number }).n;
  const rows = db
    .prepare(`${base} ORDER BY ${SORTS[p.sort] ?? SORTS.relevance} LIMIT ? OFFSET ?`)
    .all(...allArgs, p.pageSize, (p.page - 1) * p.pageSize) as any[];

  const releaseIds = rows.map((r) => r.release_id);
  const credits = artistCredits(db, releaseIds);
  const results: SearchResult[] = rows.map((r) => {
    const matched = String(r.matched_ids).split(",").map(Number).sort((a, b) => a - b);
    const primary = db
      .prepare(
        `SELECT e.id, e.catalog_number, l.name AS label, e.format, e.format_details, e.country, e.release_year
         FROM editions e LEFT JOIN labels l ON l.id = e.label_id WHERE e.id = ?`,
      )
      .get(matched[0]) as SearchResult["primary_edition"];
    const img = db
      .prepare(
        `SELECT ai.id, ai.placeholder_seed FROM archive_images ai JOIN editions e ON e.id = ai.edition_id
         WHERE e.release_id = ? ORDER BY (ai.edition_id = ?) DESC, ai.kind = 'front' DESC, ai.id LIMIT 1`,
      )
      .get(r.release_id, matched[0]) as { id: number; placeholder_seed: string | null } | undefined;
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM editions WHERE release_id = ?) AS editions,
                (SELECT COUNT(*) FROM listings li JOIN editions e ON e.id = li.edition_id WHERE e.release_id = ? AND li.status = 'available') AS for_sale`,
      )
      .get(r.release_id, r.release_id) as { editions: number; for_sale: number };
    const terms = db
      .prepare("SELECT term FROM release_terms WHERE release_id = ? ORDER BY kind, term")
      .all(r.release_id)
      .map((t: any) => t.term as string);
    return {
      release_id: r.release_id,
      title: r.title,
      release_type: r.release_type,
      artist: credits.get(r.release_id)!,
      edition_count: counts.editions,
      matched_edition_ids: matched,
      primary_edition: primary,
      image_id: img?.id ?? null,
      placeholder_seed: img?.placeholder_seed ?? null,
      earliest_year: r.earliest_year,
      for_sale_count: counts.for_sale,
      min_price_cents: r.min_price,
      terms,
    };
  });
  return { total, results };
}

export function facetValues(db: DB) {
  return {
    genres: db.prepare("SELECT DISTINCT term FROM release_terms WHERE kind = 'genre' ORDER BY term").all().map((r: any) => r.term as string),
    styles: db.prepare("SELECT DISTINCT term FROM release_terms WHERE kind = 'style' ORDER BY term").all().map((r: any) => r.term as string),
    formats: db.prepare("SELECT DISTINCT format FROM editions ORDER BY format").all().map((r: any) => r.format as string),
    countries: db
      .prepare("SELECT DISTINCT country FROM editions WHERE country IS NOT NULL ORDER BY country")
      .all()
      .map((r: any) => r.country as string),
  };
}

// ───────────────────────── Releases & editions ─────────────────────────
export interface EditionSummary {
  id: number;
  release_id: number;
  label_id: number | null;
  label: string | null;
  catalog_number: string | null;
  format: string;
  format_details: string | null;
  country: string | null;
  release_year: number | null;
  release_month: number | null;
  release_day: number | null;
  date_note: string | null;
  edition_notes: string | null;
  verification_status: string;
  for_sale_count: number;
  min_price_cents: number | null;
  track_count: number;
}

const EDITION_SELECT = `
  SELECT e.*, l.name AS label,
    (SELECT COUNT(*) FROM listings li WHERE li.edition_id = e.id AND li.status = 'available') AS for_sale_count,
    (SELECT MIN(price_cents) FROM listings li WHERE li.edition_id = e.id AND li.status = 'available') AS min_price_cents,
    (SELECT COUNT(*) FROM tracks t WHERE t.edition_id = e.id) AS track_count
  FROM editions e LEFT JOIN labels l ON l.id = e.label_id`;

export function getRelease(db: DB, id: number) {
  const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(id) as any;
  if (!release) return null;
  const artists = db
    .prepare(
      "SELECT a.id, a.name, ra.join_text FROM release_artists ra JOIN artists a ON a.id = ra.artist_id WHERE ra.release_id = ? ORDER BY ra.position",
    )
    .all(id) as { id: number; name: string; join_text: string }[];
  const terms = db.prepare("SELECT kind, term FROM release_terms WHERE release_id = ? ORDER BY kind, term").all(id) as {
    kind: string;
    term: string;
  }[];
  const editions = db
    .prepare(`${EDITION_SELECT} WHERE e.release_id = ? ORDER BY e.release_year IS NULL, e.release_year, e.id`)
    .all(id) as EditionSummary[];
  return {
    ...release,
    artists,
    artist: artistCredit(db, id),
    genres: terms.filter((t) => t.kind === "genre").map((t) => t.term),
    styles: terms.filter((t) => t.kind === "style").map((t) => t.term),
    editions,
  };
}

export function getEditionSummary(db: DB, id: number): EditionSummary | null {
  return (db.prepare(`${EDITION_SELECT} WHERE e.id = ?`).get(id) as EditionSummary) ?? null;
}

export function getEdition(db: DB, id: number) {
  const edition = getEditionSummary(db, id);
  if (!edition) return null;
  const release = getRelease(db, edition.release_id)!;
  return {
    edition,
    release,
    tracks: getTracks(db, id),
    identifiers: db.prepare("SELECT * FROM edition_identifiers WHERE edition_id = ? ORDER BY kind, id").all(id) as any[],
    sources: db
      .prepare(
        "SELECT s.*, u.display_name AS added_by_name FROM archival_sources s LEFT JOIN users u ON u.id = s.added_by WHERE s.edition_id = ? ORDER BY s.id",
      )
      .all(id) as any[],
    images: db.prepare("SELECT * FROM archive_images WHERE edition_id = ? ORDER BY kind = 'front' DESC, id").all(id) as any[],
    mediaLinks: db
      .prepare("SELECT id, provider, external_id, track_position FROM edition_media_links WHERE edition_id = ? ORDER BY track_position IS NOT NULL, track_position, id")
      .all(id) as { id: number; provider: string; external_id: string; track_position: string | null }[],
    revisions: db
      .prepare(
        `SELECT rv.*, pu.display_name AS proposed_by_name, au.display_name AS accepted_by_name
         FROM edition_revisions rv LEFT JOIN users pu ON pu.id = rv.proposed_by LEFT JOIN users au ON au.id = rv.accepted_by
         WHERE rv.edition_id = ? ORDER BY rv.id DESC`,
      )
      .all(id) as any[],
    unavailable: db
      .prepare("SELECT status, COUNT(*) AS n FROM listings WHERE edition_id = ? AND status IN ('reserved','sold') GROUP BY status")
      .all(id) as { status: string; n: number }[],
    pendingProposals: (
      db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE target_edition_id = ? AND status = 'pending'").get(id) as { n: number }
    ).n,
  };
}

export function getTracks(db: DB, editionId: number) {
  return db
    .prepare("SELECT position, title, artist_credit, duration_seconds FROM tracks WHERE edition_id = ? ORDER BY sort_order")
    .all(editionId) as { position: string; title: string; artist_credit: string | null; duration_seconds: number | null }[];
}

export function formatDate(e: { release_year: number | null; release_month: number | null; release_day: number | null }): string {
  if (!e.release_year) return "Unknown";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (!e.release_month) return String(e.release_year);
  if (!e.release_day) return `${months[e.release_month - 1]} ${e.release_year}`;
  return `${e.release_day} ${months[e.release_month - 1]} ${e.release_year}`;
}

export function formatDuration(s: number | null): string {
  if (s == null) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ───────────────────────── Edition comparison ─────────────────────────
export interface CompareRow {
  field: string;
  values: string[];
  differs: boolean;
}

export function compareEditions(db: DB, ids: number[]) {
  const editions = ids.map((id) => getEdition(db, id)).filter((e): e is NonNullable<typeof e> => !!e);
  const identifierText = (e: (typeof editions)[number], kind: string) =>
    e.identifiers
      .filter((i) => i.kind === kind)
      .map((i) => i.value + (i.note ? ` (${i.note})` : ""))
      .join("\n") || "—";
  const fields: [string, (e: (typeof editions)[number]) => string][] = [
    ["Release", (e) => `${e.release.artist} — ${e.release.title}`],
    ["Label", (e) => e.edition.label ?? "Unknown"],
    ["Catalog number", (e) => e.edition.catalog_number ?? "None / unknown"],
    ["Format", (e) => [e.edition.format, e.edition.format_details].filter(Boolean).join(", ")],
    ["Country", (e) => e.edition.country ?? "Unknown"],
    ["Date", (e) => formatDate(e.edition) + (e.edition.date_note ? ` — ${e.edition.date_note}` : "")],
    ["Barcode", (e) => identifierText(e, "barcode")],
    ["Matrix / runout", (e) => identifierText(e, "matrix_runout")],
    ["Other identifiers", (e) =>
      e.identifiers
        .filter((i) => !["barcode", "matrix_runout"].includes(i.kind))
        .map((i) => `${i.kind}: ${i.value}`)
        .join("\n") || "—"],
    ["Track count", (e) => String(e.tracks.length)],
    ["Notes", (e) => e.edition.edition_notes ?? "—"],
    ["Verification", (e) => e.edition.verification_status],
    ["Sources cited", (e) => String(e.sources.length)],
  ];
  const rows: CompareRow[] = fields.map(([field, fn]) => {
    const values = editions.map(fn);
    return { field, values, differs: new Set(values).size > 1 };
  });

  // Track listing aligned by position.
  const positions: string[] = [];
  for (const e of editions) for (const t of e.tracks) if (!positions.includes(t.position)) positions.push(t.position);
  const trackRows: CompareRow[] = positions.map((pos) => {
    const values = editions.map((e) => {
      const t = e.tracks.find((x) => x.position === pos);
      return t ? `${t.title}${t.duration_seconds ? ` (${formatDuration(t.duration_seconds)})` : ""}` : "—";
    });
    return { field: pos, values, differs: new Set(values).size > 1 };
  });
  return { editions, rows, trackRows };
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

export interface DuplicateCandidate {
  edition: EditionSummary;
  release_title: string;
  artist: string;
  reasons: string[];
  score: number;
}

/**
 * Simple, explainable matching — not an identification engine. Scans all editions (fine at
 * prototype scale; a production version would use an indexed trigram search).
 */
export function findDuplicateCandidates(
  db: DB,
  input: { release_id: number; label_id: number | null; catalog_number: string | null; format: string; country: string | null; release_year: number | null },
  excludeEditionId?: number,
): DuplicateCandidate[] {
  const norm = normalizeCatno(input.catalog_number);
  const all = db.prepare(`${EDITION_SELECT}`).all() as EditionSummary[];
  const out: DuplicateCandidate[] = [];
  for (const e of all) {
    if (e.id === excludeEditionId) continue;
    const reasons: string[] = [];
    let score = 0;
    const en = normalizeCatno(e.catalog_number);
    if (norm && en) {
      if (en === norm) {
        reasons.push("Same catalog number (ignoring spaces, dashes and case)");
        score += 5;
      } else if (levenshtein(en, norm) === 1 || en.startsWith(norm) || norm.startsWith(en)) {
        reasons.push(`Similar catalog number (${e.catalog_number})`);
        score += 2;
      }
    }
    if (e.release_id === input.release_id) {
      score += 1;
      if (e.format === input.format && (e.country ?? "") === (input.country ?? "")) {
        reasons.push("Same release, format and country");
        score += 2;
      }
      if (input.release_year && e.release_year === input.release_year) {
        reasons.push("Same release and year");
        score += 1;
      }
    }
    if (input.label_id && e.label_id === input.label_id && score >= 2) {
      reasons.push("Same label");
      score += 1;
    }
    if (reasons.length && score >= 2) {
      const release = db.prepare("SELECT title FROM releases WHERE id = ?").get(e.release_id) as { title: string };
      out.push({ edition: e, release_title: release.title, artist: artistCredit(db, e.release_id), reasons, score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function listLabels(db: DB) {
  return db.prepare("SELECT id, name FROM labels ORDER BY name COLLATE NOCASE").all() as { id: number; name: string }[];
}

export function listReleasesBrief(db: DB) {
  const rows = db.prepare("SELECT id, title FROM releases ORDER BY title COLLATE NOCASE").all() as { id: number; title: string }[];
  const credits = artistCredits(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, artist: credits.get(r.id)! }));
}
