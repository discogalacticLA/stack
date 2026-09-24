/**
 * Normalisation for matching and search. Display values are never modified; these helpers
 * produce a separate normalized_* column.
 *
 * normalizeName("José González")  → "jose gonzalez"
 * normalizeName("Kraftwerk (2)")  → "kraftwerk"         (Discogs disambiguation suffix removed)
 * normalizeName("The Beatles")    → "the beatles"       (articles kept: removing them is lossy)
 * normalizeName("井上 ひかり")      → "井上 ひかり"         (non-Latin scripts kept as-is)
 * normalizeName("AC/DC")          → "ac dc"
 */
export function normalizeName(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // strip combining marks (accents)
    .replace(/\s+\(\d+\)\s*$/u, "") // Discogs numbering suffix
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out || null;
}

/** Catalog numbers and barcodes: uppercase letters and digits only. "LLR-004 CD" → "LLR004CD". */
export function normalizeCode(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s.normalize("NFKD").replace(/\p{M}+/gu, "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
  return out && out !== "NONE" ? out : null;
}

/** "6:48" → 408, "1:02:03" → 3723; anything else → null. */
export function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const parts = s.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Discogs "released": '1981', '1981-05', '1981-05-10', '1981-00-00', '19810510' → year or null. */
export function yearFromReleased(s: string | null | undefined): number | null {
  const m = /^(\d{4})/.exec(s ?? "");
  const y = m ? Number(m[1]) : NaN;
  return y >= 1850 && y <= 2100 ? y : null;
}

/** Maps a physical format name to a coarse group used by library filters. New formats need no schema change. */
export function formatGroupOf(name: string | null | undefined): "Vinyl" | "CD" | "Cassette" | "Digital" | "Other" {
  const n = (name ?? "").toLowerCase();
  if (["vinyl", "lathe cut", "acetate", "flexi-disc", "shellac"].includes(n)) return "Vinyl";
  if (["cd", "cdr", "sacd", "hybrid", "cdv", "minidisc"].includes(n)) return "CD";
  if (["cassette", "microcassette"].includes(n)) return "Cassette";
  if (n === "file") return "Digital";
  return "Other"; // 8-Track Cartridge, Reel-To-Reel, DVD, Box Set, All Media …
}
