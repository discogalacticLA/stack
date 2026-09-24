/**
 * Reconciliation: classify each parsed row against what we already know from the same source
 * library. Pure function — no database access — so the rules are easy to test and review.
 *
 * Rules (see docs/IMPORTS.md):
 * - Rows are never matched by row number or file order.
 * - Discogs exports have no stable per-copy identifier. Rows are grouped by release_id (or a
 *   text key) and matched as a MULTISET on exact content: two identical rows = two copies.
 *   Rows left over in a group that already has unmatched known entries are AMBIGUOUS (the
 *   copy may have been edited, or it may be a new copy) and need a person to decide.
 * - Rekordbox TrackIDs are scoped to one source library. Same TrackID + same content =
 *   existing; same TrackID + changed content that still shares a file/metadata hint =
 *   changed (safe update of source fields); same TrackID but nothing else in common =
 *   ambiguous (the ID may have been reused). A new TrackID whose file or metadata matches a
 *   known entry that is absent from this file = ambiguous (the ID may have changed).
 * - Entries missing from a later export are reported, never deleted.
 */
import type { ParsedRow, SourceKind } from "./adapters/types.js";

export interface KnownEntry {
  id: number;
  external_id: string | null;
  identity_key: string;
  content_hash: string;
  hints: string[];
}

export type Classification = "new" | "existing" | "changed" | "ambiguous" | "invalid";

export interface RowResult {
  rowNumber: number;
  classification: Classification;
  matchedEntryId: number | null;
  candidateEntryIds: number[];
  reason: string;
}

export interface ReconcileResult {
  rows: RowResult[];
  missingEntryIds: number[];
}

export function reconcile(kind: SourceKind, rows: ParsedRow[], known: KnownEntry[]): ReconcileResult {
  return kind === "rekordbox" ? reconcileById(rows, known) : reconcileMultiset(rows, known);
}

function reconcileMultiset(rows: ParsedRow[], known: KnownEntry[]): ReconcileResult {
  const byKey = new Map<string, KnownEntry[]>();
  for (const e of known) byKey.set(e.identity_key, [...(byKey.get(e.identity_key) ?? []), e]);
  const used = new Set<number>();
  const results = new Map<number, RowResult>();
  const groups = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    if (r.errors.length) {
      results.set(r.rowNumber, { rowNumber: r.rowNumber, classification: "invalid", matchedEntryId: null, candidateEntryIds: [], reason: r.errors.join(" ") });
      continue;
    }
    groups.set(r.identityKey, [...(groups.get(r.identityKey) ?? []), r]);
  }
  for (const [key, groupRows] of groups) {
    const entries = byKey.get(key) ?? [];
    const leftovers: ParsedRow[] = [];
    // Pass 1: exact content matches, one entry per row.
    for (const r of groupRows) {
      const e = entries.find((x) => !used.has(x.id) && x.content_hash === r.contentHash);
      if (e) {
        used.add(e.id);
        results.set(r.rowNumber, { rowNumber: r.rowNumber, classification: "existing", matchedEntryId: e.id, candidateEntryIds: [], reason: "Identical to an entry already imported." });
      } else leftovers.push(r);
    }
    // Pass 2: leftovers are new unless unmatched known entries exist for the same release.
    const unmatched = entries.filter((x) => !used.has(x.id)).map((x) => x.id);
    for (const r of leftovers) {
      if (!unmatched.length) {
        const sameReleaseCount = groupRows.length;
        results.set(r.rowNumber, {
          rowNumber: r.rowNumber, classification: "new", matchedEntryId: null, candidateEntryIds: [],
          reason: sameReleaseCount > 1 ? `New; this file has ${sameReleaseCount} rows for the same release (kept as separate copies).` : "Not seen before in this source.",
        });
      } else {
        results.set(r.rowNumber, {
          rowNumber: r.rowNumber, classification: "ambiguous", matchedEntryId: null, candidateEntryIds: unmatched,
          reason: `Same release as ${unmatched.length} previously imported entr${unmatched.length === 1 ? "y" : "ies"} whose details differ. It may be an edited copy or an additional copy.`,
        });
      }
    }
  }
  const missingEntryIds = known.filter((e) => !used.has(e.id)).map((e) => e.id);
  return { rows: rows.map((r) => results.get(r.rowNumber)!), missingEntryIds };
}

function reconcileById(rows: ParsedRow[], known: KnownEntry[]): ReconcileResult {
  const byExternal = new Map(known.filter((e) => e.external_id).map((e) => [e.external_id!, e]));
  const idsInFile = new Set(rows.filter((r) => !r.errors.length && r.externalId).map((r) => r.externalId!));
  const byHint = new Map<string, KnownEntry[]>();
  for (const e of known) for (const h of e.hints) byHint.set(h, [...(byHint.get(h) ?? []), e]);
  const used = new Set<number>();
  const out: RowResult[] = rows.map((r) => {
    if (r.errors.length) return { rowNumber: r.rowNumber, classification: "invalid", matchedEntryId: null, candidateEntryIds: [], reason: r.errors.join(" ") };
    const hints = r.fingerprintHints ?? [];
    const e = r.externalId ? byExternal.get(r.externalId) : undefined;
    if (e) {
      used.add(e.id);
      if (e.content_hash === r.contentHash) return { rowNumber: r.rowNumber, classification: "existing", matchedEntryId: e.id, candidateEntryIds: [], reason: "Unchanged since the last import." };
      if (hints.some((h) => e.hints.includes(h))) return { rowNumber: r.rowNumber, classification: "changed", matchedEntryId: e.id, candidateEntryIds: [], reason: "Same TrackID and file; some fields changed (e.g. rating, BPM, comments)." };
      return { rowNumber: r.rowNumber, classification: "ambiguous", matchedEntryId: null, candidateEntryIds: [e.id], reason: "Same TrackID as a known track, but the file and metadata are different. Rekordbox may have reused the ID." };
    }
    const candidates = [...new Set(hints.flatMap((h) => byHint.get(h) ?? []))].filter((c) => !c.external_id || !idsInFile.has(c.external_id));
    if (candidates.length) {
      candidates.forEach((c) => used.add(c.id));
      return { rowNumber: r.rowNumber, classification: "ambiguous", matchedEntryId: null, candidateEntryIds: candidates.map((c) => c.id), reason: "New TrackID, but the same file or metadata as a known track that isn't in this export. The ID may have changed." };
    }
    return { rowNumber: r.rowNumber, classification: "new", matchedEntryId: null, candidateEntryIds: [], reason: "Not seen before in this source library." };
  });
  return { rows: out, missingEntryIds: known.filter((e) => !used.has(e.id)).map((e) => e.id) };
}
