/**
 * Import adapter contract. Each supported export format is one adapter that turns an uploaded
 * file into normalised rows. Adapters never touch the database; reconciliation and persistence
 * live in ../reconcile.ts and ../service.ts, so new formats (Traktor, Serato, …) only need a new adapter.
 */
export type SourceKind = "discogs_collection" | "discogs_wantlist" | "rekordbox";
export type TargetKind = "physical" | "digital" | "want";

export interface ParsedRow {
  rowNumber: number;
  /** Source identifier (Discogs release_id, Rekordbox TrackID) — NOT a copy identifier. */
  externalId: string | null;
  /** Grouping key used for multiset matching (release_id, or a text fallback). */
  identityKey: string;
  /** Hash of the normalised content; identical rows have identical hashes. */
  contentHash: string;
  /** Secondary identity hint for detecting changed identifiers (e.g. file location + size). */
  fingerprintHints?: string[];
  target: TargetKind;
  /** Normalised fields mapped to holding/want columns. */
  fields: Record<string, unknown>;
  /** Everything from the source row, including unfamiliar columns. Private. */
  source: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

export interface ParsedPlaylistNode {
  name: string;
  type: "folder" | "playlist";
  children: ParsedPlaylistNode[];
  /** Track references (Rekordbox TrackID or Location, per KeyType). */
  trackKeys: string[];
  keyType: "id" | "location";
}

export interface ParsedImport {
  kind: SourceKind;
  rows: ParsedRow[];
  playlists: ParsedPlaylistNode[];
  /** File-level notes: unrecognised columns, product/version info, skipped elements. */
  notices: string[];
  columns?: { recognised: string[]; preserved: string[] };
}

export interface ImportAdapter {
  kind: SourceKind;
  label: string;
  accept: string;             // file input accept attribute
  parse(text: string): ParsedImport;
}

export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
