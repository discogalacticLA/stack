import crypto from "node:crypto";

export class ImportFileError extends Error {}

/** Decodes an uploaded file as strict UTF-8 (BOM removed). Invalid bytes produce an actionable error. */
export function decodeUtf8(buf: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new ImportFileError("This file isn't valid UTF-8 text. Re-export it from the source (Discogs and Rekordbox exports are UTF-8), or re-save it as “CSV UTF-8”.");
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** Stable hash of a plain object (keys sorted) — used as a row content hash. */
export function contentHash(obj: Record<string, unknown>): string {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as any)[k])]))
      : Array.isArray(v) ? v.map(norm) : v ?? null;
  return sha256(JSON.stringify(norm(obj)));
}

export const normKey = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^a-z0-9#]/g, "");
