/**
 * Streaming reader for Discogs XML dumps (.xml or .xml.gz).
 *
 *   file ─► (gunzip if gzip magic bytes) ─► UTF-8 decode (chunk-boundary safe) ─► SAX events
 *        ─► one small tree per <artist>/<label>/<master>/<release> ─► onRecord()
 *
 * Only one record is held in memory at a time. The raw bytes are hashed (sha256) as they are read.
 * Untrusted-input protections: any DOCTYPE is refused (so no DTD, no custom or external entities —
 * saxes never resolves them anyway); text per element and elements per record are capped; nesting
 * depth is capped. XML syntax errors are fatal (a streaming parser can't safely resynchronise);
 * data problems inside a well-formed record are reported per record by the normaliser instead.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { SaxesParser } from "saxes";

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

export interface StreamLimits {
  maxTextLength: number;      // per element; longer text is truncated and flagged
  maxNodesPerRecord: number;  // a record bigger than this is skipped with an error
  maxDepth: number;
}
export const DEFAULT_LIMITS: StreamLimits = { maxTextLength: 64 * 1024, maxNodesPerRecord: 50_000, maxDepth: 32 };

export class FatalImportError extends Error {}

export interface StreamStats { bytesRead: number; fileSize: number; sha256: string | null; records: number }

export interface RecordMeta { index: number; truncated: boolean; oversized: boolean }

/**
 * Streams records named `recordTag` that are direct children of the root element.
 * `onRecord` may be async (it is awaited between chunks, giving natural backpressure).
 */
export async function streamRecords(
  filePath: string,
  recordTag: string,
  onRecord: (node: XNode | null, meta: RecordMeta) => void | Promise<void>,
  opts: { limits?: Partial<StreamLimits>; onBytes?: (bytesRead: number) => void; signal?: AbortSignal } = {},
): Promise<StreamStats> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const fileSize = fs.statSync(filePath).size;
  const head = Buffer.alloc(2);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;

  const hash = crypto.createHash("sha256");
  let bytesRead = 0;
  const raw = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  raw.on("data", (c) => {
    hash.update(c as Buffer);
    bytesRead += (c as Buffer).length;
  });
  const source: NodeJS.ReadableStream = gzipped ? raw.pipe(zlib.createGunzip()) : raw;
  const decoder = new StringDecoder("utf8");

  const parser = new SaxesParser({ xmlns: false, position: true });
  let depth = 0;
  let recordIndex = 0;
  let stack: XNode[] = [];
  let current: XNode | null = null;
  let nodes = 0;
  let truncated = false;
  let oversized = false;
  const pending: { node: XNode | null; meta: RecordMeta }[] = [];
  let parseError: Error | null = null;
  // Records completed before the first fatal error are still handed over (then the import stops).
  let goodRecords = Infinity;
  const fail = (e: Error) => {
    if (parseError) return;
    parseError = e;
    goodRecords = recordIndex;
  };

  parser.on("doctype", () => {
    fail(new FatalImportError("The file contains a DOCTYPE declaration. Discogs dumps don't, and DTDs are refused for safety (no entity expansion)."));
  });
  parser.on("error", (e) => {
    fail(new FatalImportError(`XML is not well-formed: ${e.message}`));
  });
  parser.on("opentag", (tag) => {
    depth++;
    if (depth > limits.maxDepth) {
      fail(new FatalImportError(`XML nesting deeper than ${limits.maxDepth} levels near line ${parser.line}.`));
      return;
    }
    if (depth === 2) {
      if (tag.name !== recordTag) return; // unexpected sibling element: ignored
      current = { name: tag.name, attrs: { ...(tag.attributes as Record<string, string>) }, children: [], text: "" };
      stack = [current];
      nodes = 1;
      truncated = false;
      oversized = false;
      return;
    }
    if (!current || oversized) return;
    if (++nodes > limits.maxNodesPerRecord) {
      oversized = true;
      return;
    }
    const node: XNode = { name: tag.name, attrs: { ...(tag.attributes as Record<string, string>) }, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  parser.on("text", (t) => {
    if (!current || oversized || depth < 2) return;
    const node = stack[stack.length - 1];
    if (node.text.length + t.length > limits.maxTextLength) {
      node.text = (node.text + t).slice(0, limits.maxTextLength);
      truncated = true;
    } else node.text += t;
  });
  parser.on("closetag", () => {
    if (depth === 2 && current) {
      pending.push({ node: oversized ? null : current, meta: { index: recordIndex++, truncated, oversized } });
      current = null;
      stack = [];
    } else if (current && !oversized && depth > 2) {
      stack.pop();
    }
    depth--;
  });

  const drain = async () => {
    while (pending.length) {
      const { node, meta } = pending.shift()!;
      if (meta.index >= goodRecords) { pending.length = 0; break; }
      await onRecord(node, meta);
    }
  };

  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (opts.signal?.aborted) throw new FatalImportError("Import cancelled.");
      parser.write(decoder.write(chunk));
      await drain();
      if (parseError) throw parseError;
      opts.onBytes?.(bytesRead);
    }
    parser.write(decoder.end());
    parser.close();
    await drain();
    if (parseError) throw parseError;
  } catch (e: any) {
    raw.destroy();
    if (e instanceof FatalImportError) throw e;
    if (e?.code === "Z_DATA_ERROR" || e?.code === "Z_BUF_ERROR") throw new FatalImportError(`The gzip data is corrupt or truncated (${e.message}).`);
    throw e;
  }
  opts.onBytes?.(bytesRead);
  return { bytesRead, fileSize, sha256: bytesRead === fileSize ? hash.digest("hex") : null, records: recordIndex };
}

// ───────── Tiny tree helpers ─────────
export const child = (n: XNode | undefined, name: string) => n?.children.find((c) => c.name === name);
export const childrenOf = (n: XNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
/** Text of a child element, trimmed; empty → null. */
export const text = (n: XNode | undefined, name?: string): string | null => {
  const t = (name ? child(n, name) : n)?.text?.trim();
  return t ? t : null;
};

/** Streams a whole file just to compute its sha256 (for verifying published checksums before importing). */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
