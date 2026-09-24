/** Small reference vocabularies used for validation and display. */

// Common collector grading scale (media). Descriptions are original wording.
export const MEDIA_CONDITIONS = [
  { code: "M", label: "Mint (M)", note: "Unplayed, sealed or indistinguishable from new." },
  { code: "NM", label: "Near Mint (NM)", note: "Played rarely; no visible marks." },
  { code: "VG+", label: "Very Good Plus (VG+)", note: "Light signs of play; plays cleanly." },
  { code: "VG", label: "Very Good (VG)", note: "Visible marks; some surface noise on quiet passages." },
  { code: "G+", label: "Good Plus (G+)", note: "Noticeable noise; plays through without skipping." },
  { code: "G", label: "Good (G)", note: "Heavy wear; for completists or DJ tool use." },
  { code: "F", label: "Fair (F)", note: "Heavy wear and noise; still plays." },
  { code: "P", label: "Poor (P)", note: "Damaged; may skip." },
  { code: "NG", label: "Not graded", note: "No grade recorded (common for imported entries)." },
] as const;

export const SLEEVE_CONDITIONS = [
  ...MEDIA_CONDITIONS,
  { code: "GENERIC", label: "Generic sleeve", note: "Plain or non-original sleeve." },
  { code: "NONE", label: "No sleeve", note: "Sold without a sleeve." },
] as const;

export const MEDIA_CODES = MEDIA_CONDITIONS.map((c) => c.code) as string[];
export const SLEEVE_CODES = SLEEVE_CONDITIONS.map((c) => c.code) as string[];

/** Lower rank = better condition; used for sorting listings. */
export function conditionRank(code: string): number {
  const i = SLEEVE_CODES.indexOf(code);
  return i === -1 ? 99 : i;
}

export function conditionLabel(code: string): string {
  return SLEEVE_CONDITIONS.find((c) => c.code === code)?.label ?? code;
}

export const FORMATS = ["Vinyl", "CD", "Cassette", "File", "Other"] as const;

export const RELEASE_TYPES = ["album", "ep", "single", "compilation", "other"] as const;

/** Demo shipping zones. "region" means same zone as the seller's origin. */
export const COUNTRIES: Record<string, { name: string; zone: string }> = {
  US: { name: "United States", zone: "North America" },
  CA: { name: "Canada", zone: "North America" },
  MX: { name: "Mexico", zone: "North America" },
  GB: { name: "United Kingdom", zone: "Europe" },
  DE: { name: "Germany", zone: "Europe" },
  FR: { name: "France", zone: "Europe" },
  NL: { name: "Netherlands", zone: "Europe" },
  IT: { name: "Italy", zone: "Europe" },
  ES: { name: "Spain", zone: "Europe" },
  JP: { name: "Japan", zone: "Asia-Pacific" },
  AU: { name: "Australia", zone: "Asia-Pacific" },
  ZA: { name: "South Africa", zone: "Africa" },
  BR: { name: "Brazil", zone: "South America" },
};
export const COUNTRY_CODES = Object.keys(COUNTRIES);

/** Catalog countries are display text ("UK", "Germany", "UK & Europe"); ISO codes (used for shipping) map to names. */
export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return COUNTRIES[code]?.name ?? code;
}

/** Short keys accepted in contribution forms → canonical identifier type names (Discogs vocabulary). Any other type text is allowed too. */
export const IDENTIFIER_KINDS: Record<string, string> = {
  barcode: "Barcode",
  matrix_runout: "Matrix / Runout",
  label_code: "Label Code",
  rights_society: "Rights Society",
  other: "Other",
};

export const SOURCE_KINDS: Record<string, string> = {
  physical_copy: "Examined a physical copy",
  label_statement: "Label statement",
  artist_statement: "Artist statement",
  publication: "Publication",
  website: "Website",
  other: "Other",
};

/** Wording avoids implying more certainty than the evidence supports. */
export const VERIFICATION: Record<string, { label: string; explain: string }> = {
  unverified: {
    label: "Unverified",
    explain: "No source has been cited for this edition yet. Treat details as provisional.",
  },
  sourced: {
    label: "Sources cited",
    explain: "At least one source is cited, but a moderator has not reviewed this entry against it.",
  },
  reviewed: {
    label: "Moderator-reviewed",
    explain: "A moderator checked this entry against the cited sources. Reviewed does not mean certain.",
  },
  disputed: {
    label: "Disputed",
    explain: "Contributors disagree about some details. See notes and revision history.",
  },
};
