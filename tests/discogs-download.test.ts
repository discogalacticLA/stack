import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUMP_BASE_URL, downloadDumpFile, downloadDumps, dumpFileNames, dumpNameFromUrl, dumpUrl, isOfficialDumpHost, parseChecksums,
} from "../src/services/importer/discogs/download.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const BASE = "https://data.discogs.com/dumps";

/** A fake fetch serving `files` by URL; counts requests; can truncate or redirect. */
function fakeFetch(files: Record<string, Buffer | string>, o: { truncateAt?: number; lieLength?: number; status?: number; redirectTo?: string } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const body = files[url];
    if (o.status || body == null) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: o.status ?? 403 });
    const buf = Buffer.from(body);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(o.truncateAt != null ? buf.subarray(0, o.truncateAt) : buf); return; }
        if (o.truncateAt != null) c.error(new Error("socket hang up")); // connection drops mid-body
        else c.close();
      },
    });
    const res = new Response(stream, { status: 200, headers: { "content-length": String(o.lieLength ?? buf.length) } });
    if (o.redirectTo) Object.defineProperty(res, "url", { value: o.redirectTo });
    return res;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("dump URL construction", () => {
  it("builds official file names and {base}/{YYYY}/{name} URLs", () => {
    expect(dumpFileNames("20260901")).toEqual([
      "discogs_20260901_CHECKSUM.txt", "discogs_20260901_artists.xml.gz", "discogs_20260901_labels.xml.gz", "discogs_20260901_masters.xml.gz", "discogs_20260901_releases.xml.gz",
    ]);
    expect(dumpFileNames("20260901", ["labels"])).toEqual(["discogs_20260901_CHECKSUM.txt", "discogs_20260901_labels.xml.gz"]);
    expect(dumpUrl(DEFAULT_DUMP_BASE_URL, "discogs_20260901_releases.xml.gz"))
      .toBe("https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data/2026/discogs_20260901_releases.xml.gz");
    expect(dumpUrl("https://data.discogs.com/x/", "discogs_20251201_CHECKSUM.txt")).toBe("https://data.discogs.com/x/2025/discogs_20251201_CHECKSUM.txt");
    expect(() => dumpFileNames("2026-09-01")).toThrow(/YYYYMMDD/);
    expect(() => dumpFileNames("20260901", ["users"])).toThrow(/Unknown dump type/);
  });

  it("only accepts official hosts over https, and only official file names (no paths from the URL)", () => {
    expect(isOfficialDumpHost("https://data.discogs.com/a")).toBe(true);
    expect(isOfficialDumpHost("https://discogs-data-dumps.s3.us-west-2.amazonaws.com/data/2026/x")).toBe(true);
    expect(isOfficialDumpHost("http://data.discogs.com/a")).toBe(false);
    expect(isOfficialDumpHost("https://discogs.com.evil.example/a")).toBe(false);
    expect(isOfficialDumpHost("https://evil-discogs-data-dumps.s3.amazonaws.com/a")).toBe(false);
    expect(dumpNameFromUrl("https://data.discogs.com/d/2026/discogs_20260901_labels.xml.gz?sig=1")).toBe("discogs_20260901_labels.xml.gz");
    expect(() => dumpNameFromUrl("https://data.discogs.com/d/..%2F..%2Fetc%2Fpasswd")).toThrow(/not a Discogs dump file name/);
    expect(parseChecksums("abc\n" + "a".repeat(64) + " *discogs_20260901_labels.xml.gz\r\n")).toEqual(new Map([["discogs_20260901_labels.xml.gz", "a".repeat(64)]]));
  });
});

describe("dump download", () => {
  const body = Buffer.from("x".repeat(10_000));
  const url = `${BASE}/2026/discogs_20260901_labels.xml.gz`;
  const sumUrl = `${BASE}/2026/discogs_20260901_CHECKSUM.txt`;
  const checksum = `${sha(body)} discogs_20260901_labels.xml.gz\n`;

  it("streams to .part, verifies against CHECKSUM.txt, renames, records Content-Length, and skips a verified file next time", async () => {
    const dir = tmp();
    const f = fakeFetch({ [url]: body, [sumUrl]: checksum });
    const r = await downloadDumps([sumUrl, url], dir, { fetchImpl: f.impl });
    expect(r.map((x) => [x.name, x.status, x.verified])).toEqual([["discogs_20260901_CHECKSUM.txt", "downloaded", false], ["discogs_20260901_labels.xml.gz", "downloaded", true]]);
    expect(r[1]).toMatchObject({ bytes: 10_000, contentLength: 10_000, sha256: sha(body) });
    expect(fs.readdirSync(dir).sort()).toEqual(["discogs_20260901_CHECKSUM.txt", "discogs_20260901_labels.xml.gz", "discogs_20260901_labels.xml.gz.sha256"]);
    const again = await downloadDumps([sumUrl, url], dir, { fetchImpl: f.impl });
    expect(again[1].status).toBe("already-verified");
    expect(f.calls.filter((c) => c === url)).toHaveLength(1); // not re-downloaded
  });

  it("never leaves a truncated download under the real name", async () => {
    const dir = tmp();
    await expect(downloadDumpFile(url, dir, null, { fetchImpl: fakeFetch({ [url]: body }, { truncateAt: 4000 }).impl })).rejects.toThrow(/interrupted after \d+ bytes of 10000.*not renamed/s);
    expect(fs.existsSync(path.join(dir, "discogs_20260901_labels.xml.gz"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "discogs_20260901_labels.xml.gz.part"))).toBe(true);
    // Server closes cleanly but sends fewer bytes than Content-Length promised.
    await expect(downloadDumpFile(url, dir, null, { fetchImpl: fakeFetch({ [url]: body }, { lieLength: 20_000 }).impl })).rejects.toThrow(/incomplete: received 10000 of 20000/);
    expect(fs.existsSync(path.join(dir, "discogs_20260901_labels.xml.gz"))).toBe(false);
  });

  it("a checksum mismatch is set aside as .corrupt with a clear error; an existing bad file is replaced", async () => {
    const dir = tmp();
    const wrong = "0".repeat(64);
    await expect(downloadDumpFile(url, dir, wrong, { fetchImpl: fakeFetch({ [url]: body }).impl })).rejects.toThrow(/Checksum mismatch.*expected 0{64}/s);
    expect(fs.existsSync(path.join(dir, "discogs_20260901_labels.xml.gz"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "discogs_20260901_labels.xml.gz.corrupt"))).toBe(true);
    // A file already on disk that doesn't match the checksum is moved aside and downloaded again.
    fs.writeFileSync(path.join(dir, "discogs_20260901_labels.xml.gz"), "truncated");
    const r = await downloadDumpFile(url, dir, sha(body), { fetchImpl: fakeFetch({ [url]: body }).impl });
    expect(r).toMatchObject({ status: "downloaded", verified: true });
    expect(fs.readFileSync(path.join(dir, "discogs_20260901_labels.xml.gz"))).toEqual(body);
  });

  it("explains 403/404 and refuses non-official hosts and redirects", async () => {
    const dir = tmp();
    await expect(downloadDumpFile(url, dir, null, { fetchImpl: fakeFetch({}, { status: 403 }).impl })).rejects.toThrow(/HTTP 403.*data\.discogs\.com.*--url/s);
    await expect(downloadDumpFile("https://example.org/discogs_20260901_labels.xml.gz", dir, null)).rejects.toThrow(/only official Discogs dump hosts/);
    await expect(downloadDumpFile(url, dir, null, { fetchImpl: fakeFetch({ [url]: body }, { redirectTo: "https://mirror.example.org/x" }).impl })).rejects.toThrow(/not an official Discogs dump host/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a failed CHECKSUM refresh keeps the previous local copy", async () => {
    const dir = tmp();
    await downloadDumps([sumUrl], dir, { fetchImpl: fakeFetch({ [sumUrl]: checksum }).impl });
    await expect(downloadDumps([sumUrl], dir, { fetchImpl: fakeFetch({ [sumUrl]: checksum }, { truncateAt: 5 }).impl })).rejects.toThrow(/interrupted/);
    expect(fs.readFileSync(path.join(dir, "discogs_20260901_CHECKSUM.txt"), "utf8")).toBe(checksum);
  });
});
