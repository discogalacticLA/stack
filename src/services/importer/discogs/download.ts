/**
 * Downloads official Discogs monthly dump files.
 *
 * Source: the official data dumps only (https://data.discogs.com/). No Discogs web pages are
 * fetched or parsed. As of September 2026 the historical direct-S3 URL pattern
 * (DEFAULT_DUMP_BASE_URL) returns 403 AccessDenied, and the current structure behind
 * data.discogs.com could not be verified from the build environment. So:
 *   - `--date` builds URLs from a base you can override (`--base` / DISCOGS_DUMP_BASE_URL);
 *   - `--url` downloads exact links copied from https://data.discogs.com/ (preferred).
 * Hosts are restricted to Discogs-owned ones (see isOfficialDumpHost).
 *
 * Integrity: every file streams to `<name>.part` and is renamed only after the byte count matches
 * Content-Length (when sent) and the sha256 matches CHECKSUM.txt (when available). A checksum
 * mismatch renames the file to `<name>.corrupt`, so nothing truncated ever looks complete.
 * Verified files get a `<name>.sha256` sidecar and are not downloaded or re-hashed again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FatalImportError, sha256File } from "./stream.js";

/** Historical pattern `…/data/YYYY/discogs_YYYYMMDD_<type>.xml.gz`. UNVERIFIED; 403 as of 2026-09. */
export const DEFAULT_DUMP_BASE_URL = "https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data";
export const DUMP_TYPES = ["artists", "labels", "masters", "releases"] as const;
const DUMP_NAME = /^discogs_(\d{8})_(artists|labels|masters|releases)\.xml\.gz$|^discogs_(\d{8})_CHECKSUM\.txt$/;

export function dumpFileNames(date: string, types: readonly string[] = DUMP_TYPES): string[] {
  if (!/^\d{8}$/.test(date)) throw new FatalImportError(`Dump date must be YYYYMMDD (e.g. 20260901), got “${date}”.`);
  const bad = types.filter((t) => !(DUMP_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new FatalImportError(`Unknown dump type(s): ${bad.join(", ")}. Use ${DUMP_TYPES.join(", ")}.`);
  return [`discogs_${date}_CHECKSUM.txt`, ...types.map((t) => `discogs_${date}_${t}.xml.gz`)];
}

/** `{base}/{YYYY}/{name}` */
export function dumpUrl(base: string, name: string): string {
  const m = /^discogs_(\d{4})\d{4}_/.exec(name);
  if (!m) throw new FatalImportError(`Not a Discogs dump file name: ${name}`);
  return `${base.replace(/\/+$/, "")}/${m[1]}/${name}`;
}

export function isOfficialDumpHost(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return h === "discogs.com" || h.endsWith(".discogs.com") || /^discogs-data-dumps\.s3([.-][a-z0-9-]+)*\.amazonaws\.com$/.test(h);
}

/** The local file name for a URL: must be an official dump name (no paths from the URL are trusted). */
export function dumpNameFromUrl(url: string): string {
  const name = decodeURIComponent(path.posix.basename(new URL(url).pathname));
  if (!DUMP_NAME.test(name)) throw new FatalImportError(`“${name}” is not a Discogs dump file name (expected discogs_YYYYMMDD_<type>.xml.gz or discogs_YYYYMMDD_CHECKSUM.txt).`);
  return name;
}

export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out.set(path.basename(m[2].trim()), m[1].toLowerCase());
  }
  return out;
}

export interface DownloadResult {
  name: string;
  url: string;
  dest: string;
  status: "downloaded" | "already-verified" | "already-present-unverified";
  bytes: number;
  contentLength: number | null;
  sha256: string | null;
  verified: boolean;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  onProgress?: (name: string, bytes: number, total: number | null) => void;
}

const sidecar = (dest: string) => `${dest}.sha256`;

/** Returns the recorded sha256 when the sidecar still describes this exact file (size + mtime). */
function recordedHash(dest: string): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(sidecar(dest), "utf8"));
    const st = fs.statSync(dest);
    return s.size === st.size && s.mtimeMs === st.mtimeMs ? s.sha256 : null;
  } catch { return null; }
}

function recordHash(dest: string, sha256: string) {
  const st = fs.statSync(dest);
  fs.writeFileSync(sidecar(dest), JSON.stringify({ sha256, size: st.size, mtimeMs: st.mtimeMs, verifiedAt: new Date().toISOString() }) + "\n");
}

function httpError(status: number, url: string): FatalImportError {
  if (status === 403 || status === 404) {
    return new FatalImportError(
      `Download refused (HTTP ${status}) for ${url}.\n` +
      `Discogs no longer serves dumps from this address, or this file/date doesn't exist. Open https://data.discogs.com/, ` +
      `copy the exact link for the file, and run: npm run catalog -- download --url "<link>" (or pass --base with the new location).`);
  }
  return new FatalImportError(`Download failed (HTTP ${status}) for ${url}.`);
}

/**
 * Streams one URL to `dir/<name>`. `expectedSha` (from CHECKSUM.txt) makes verification mandatory.
 * An existing file is kept when its hash matches; without a checksum it is kept as-is (reported unverified).
 */
export async function downloadDumpFile(url: string, dir: string, expectedSha: string | null, opts: DownloadOptions & { refresh?: boolean } = {}): Promise<DownloadResult> {
  if (!isOfficialDumpHost(url)) throw new FatalImportError(`Refusing to download from ${url}: only official Discogs dump hosts (https, *.discogs.com or the discogs-data-dumps S3 bucket) are allowed.`);
  const name = dumpNameFromUrl(url);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  const base: Omit<DownloadResult, "status" | "bytes" | "sha256" | "verified"> = { name, url, dest, contentLength: null };

  if (fs.existsSync(dest) && !opts.refresh) {
    const known = recordedHash(dest) ?? (expectedSha ? await sha256File(dest) : null);
    if (expectedSha && known === expectedSha) {
      if (!recordedHash(dest)) recordHash(dest, known);
      return { ...base, status: "already-verified", bytes: fs.statSync(dest).size, sha256: known, verified: true };
    }
    if (!expectedSha) return { ...base, status: "already-present-unverified", bytes: fs.statSync(dest).size, sha256: known, verified: false };
    // Present but wrong: set it aside (never silently trusted, never silently deleted) and download again.
    fs.renameSync(dest, `${dest}.corrupt`);
    fs.rmSync(sidecar(dest), { force: true });
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { redirect: "follow" });
  } catch (e: any) {
    throw new FatalImportError(`Could not reach ${new URL(url).host}: ${e?.cause?.message ?? e?.message ?? e}. Check your connection or proxy.`);
  }
  if (res.url && !isOfficialDumpHost(res.url)) throw new FatalImportError(`${url} redirected to ${res.url}, which is not an official Discogs dump host. Stopped.`);
  if (!res.ok || !res.body) throw httpError(res.status, url);
  const lenHeader = res.headers.get("content-length");
  const contentLength = lenHeader != null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;

  const part = `${dest}.part`;
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      opts.onProgress?.(name, bytes, contentLength);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as any), meter, fs.createWriteStream(part));
  } catch (e: any) {
    throw new FatalImportError(`Download of ${name} was interrupted after ${bytes} bytes${contentLength != null ? ` of ${contentLength}` : ""} (${e?.message ?? e}). The partial file ${path.basename(part)} was not renamed; run the command again.`);
  }
  if (contentLength != null && bytes !== contentLength) {
    throw new FatalImportError(`Download of ${name} is incomplete: received ${bytes} of ${contentLength} bytes. The partial file ${path.basename(part)} was not renamed; run the command again.`);
  }
  const sha256 = hash.digest("hex");
  if (expectedSha && sha256 !== expectedSha) {
    fs.renameSync(part, `${dest}.corrupt`);
    throw new FatalImportError(`Checksum mismatch for ${name}: expected ${expectedSha}, got ${sha256}. Saved as ${name}.corrupt for inspection; download it again.`);
  }
  fs.renameSync(part, dest);
  if (expectedSha) recordHash(dest, sha256);
  return { ...base, contentLength, status: "downloaded", bytes, sha256, verified: !!expectedSha };
}

/**
 * Downloads a dump set. The CHECKSUM file is fetched first and every other file is verified
 * against it; without one, files are downloaded but reported as unverified.
 */
export async function downloadDumps(urls: string[], dir: string, opts: DownloadOptions = {}): Promise<DownloadResult[]> {
  const out: DownloadResult[] = [];
  let sums = new Map<string, string>();
  const checksumUrl = urls.find((u) => /_CHECKSUM\.txt$/i.test(new URL(u).pathname));
  if (checksumUrl) {
    // The checksum file has no published hash of its own; re-fetch it every time (it only replaces
    // the local copy once the new one has downloaded completely).
    const r = await downloadDumpFile(checksumUrl, dir, null, { ...opts, refresh: true });
    out.push(r);
    sums = parseChecksums(fs.readFileSync(r.dest, "utf8"));
  }
  for (const url of urls) {
    if (url === checksumUrl) continue;
    const name = dumpNameFromUrl(url);
    out.push(await downloadDumpFile(url, dir, sums.get(name) ?? null, opts));
  }
  return out;
}
