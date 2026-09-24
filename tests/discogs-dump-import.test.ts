import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentFor, setup, type TestEnv } from "./helpers.js";
import { runImport, parseDumpFileName, getRun, runErrors } from "../src/services/importer/discogs/runner.js";
import { streamRecords, FatalImportError } from "../src/services/importer/discogs/stream.js";
import { reconcileReferences, unresolvedCounts } from "../src/services/importer/discogs/writer.js";
import { unifiedSearch, getReleaseRecord } from "../src/services/catalog-api/index.js";
import { normalizeName, normalizeCode } from "../src/services/catalog-api/normalize.js";
import { commitImport, previewImport, getBatch } from "../src/imports/service.js";

const FIX = path.join(__dirname, "fixtures", "discogs");
const f = (name: string) => path.join(FIX, name);
const logDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "catalog-logs-"));
const q = (env: TestEnv, sql: string, ...a: unknown[]) => env.db.prepare(sql).get(...a) as any;
const n = (env: TestEnv, sql: string, ...a: unknown[]) => (env.db.prepare(sql).get(...a) as { n: number }).n;
const byDiscogs = (env: TestEnv, table: string, col: string, id: number) => q(env, `SELECT * FROM ${table} WHERE ${col} = ?`, id);

async function importAll(env: TestEnv, suffix = ".xml.gz", files: Record<string, string> = {}) {
  const out: Record<string, any> = {};
  for (const t of ["artists", "labels", "masters", "releases"]) {
    out[t] = await runImport(env.db, { file: f(files[t] ?? `${t}${suffix}`), type: t as any, logDir: logDir() });
  }
  return out;
}

describe("streaming reader", () => {
  it("reads gzip and plain files identically, one record at a time, and hashes the raw bytes", async () => {
    const plain: string[] = [];
    const gz: string[] = [];
    await streamRecords(f("releases.xml"), "release", (node) => { plain.push(node!.attrs.id); });
    const stats = await streamRecords(f("releases.xml.gz"), "release", (node) => { gz.push(node!.attrs.id); });
    expect(gz).toEqual(plain);
    expect(gz).toEqual(["401", "402", "403", "404", "402", "405", "abc"]);
    expect(stats.sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(f("releases.xml.gz"))).digest("hex"));
    expect(stats.records).toBe(7);
  });

  it("refuses DOCTYPE/external entities and reports malformed XML as fatal", async () => {
    await expect(streamRecords(f("xxe.xml.gz"), "artist", () => {})).rejects.toThrow(/DOCTYPE/);
    await expect(streamRecords(f("malformed.xml"), "release", () => {})).rejects.toThrow(FatalImportError);
  });

  it("enforces per-field and per-record size limits", async () => {
    const tmp = path.join(os.tmpdir(), `big-${Date.now()}.xml`);
    fs.writeFileSync(tmp, `<artists><artist><id>1</id><name>${"x".repeat(5000)}</name></artist><artist><id>2</id>${"<name>n</name>".repeat(200)}</artist></artists>`);
    const seen: any[] = [];
    await streamRecords(tmp, "artist", (node, meta) => { seen.push({ node, meta }); }, { limits: { maxTextLength: 100, maxNodesPerRecord: 50 } });
    expect(seen[0].meta.truncated).toBe(true);
    expect(seen[0].node.children[1].text).toHaveLength(100);
    expect(seen[1].node).toBeNull();
    expect(seen[1].meta.oversized).toBe(true);
  });
});

describe("normalisation helpers", () => {
  it("normalises names without destroying the original", () => {
    expect(normalizeName("José González-Ñuñez")).toBe("jose gonzalez nunez");
    expect(normalizeName("Kovač Unit (2)")).toBe("kovac unit");
    expect(normalizeName("井上 ひかり")).toBe("井上 ひかり");
    expect(normalizeName("AC/DC")).toBe("ac dc");
    expect(normalizeCode("LLR-004 CD")).toBe("LLR004CD");
    expect(normalizeCode("none")).toBeNull();
    expect(parseDumpFileName("/x/discogs_20260901_releases.xml.gz")).toEqual({ type: "releases", version: "20260901", date: "2026-09-01" });
  });
});

describe("Discogs dump import", () => {
  it("imports artists with aliases, name variations, members and Unicode; logs the invalid record and continues", async () => {
    const env = setup();
    const r = await runImport(env.db, { file: f("artists.xml.gz"), logDir: logDir() });
    expect(r).toMatchObject({ status: "completed_with_errors", created: 9, failed: 1, processed: 10 });
    const kaan = byDiscogs(env, "artists", "discogs_artist_id", 101);
    expect(kaan).toMatchObject({ name: "Aurelia Kaan", real_name: "Aurelia Kaanström", data_quality: "Needs Vote" });
    expect(JSON.parse(kaan.urls)).toEqual(["https://example.org/aurelia"]);
    expect(env.db.prepare("SELECT name FROM artist_name_variations WHERE artist_id = ? ORDER BY name").all(kaan.id).map((x: any) => x.name)).toEqual(["A. Kaan", "Kaan"]);
    // Alias 102 is imported after 101 in the same file: resolved by reconciliation at the end of the run.
    const alias = q(env, "SELECT * FROM artist_aliases WHERE artist_id = ?", kaan.id);
    expect(alias).toMatchObject({ name: "Night Service", discogs_alias_id: 102, alias_artist_id: byDiscogs(env, "artists", "discogs_artist_id", 102).id });
    const group = byDiscogs(env, "artists", "discogs_artist_id", 103);
    expect(env.db.prepare("SELECT name FROM artist_members WHERE group_artist_id = ? ORDER BY name").all(group.id).map((x: any) => x.name)).toEqual(["Idris Vale", "Paz Olvera"]);
    expect(byDiscogs(env, "artists", "discogs_artist_id", 106)).toMatchObject({ name: "José González-Ñuñez", normalized_name: "jose gonzalez nunez" });
    expect(byDiscogs(env, "artists", "discogs_artist_id", 108)).toMatchObject({ name: "Kovač Unit (2)", normalized_name: "kovac unit" });
    const errors = runErrors(env.db, r.runId);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ external_id: "110", error_type: "invalid_record", message: "artist has no name" });
    // Internal ids are our own; Discogs ids are external references.
    expect(kaan.id).not.toBe(101);
    expect(q(env, "SELECT ei.external_id FROM external_identifiers ei JOIN catalog_sources s ON s.id = ei.source_id WHERE s.name = 'discogs' AND entity_type = 'artist' AND entity_id = ?", kaan.id).external_id).toBe("101");
  });

  it("imports labels with parent/sublabel relationships", async () => {
    const env = setup();
    await runImport(env.db, { file: f("labels.xml.gz"), logDir: logDir() });
    const parent = byDiscogs(env, "labels", "discogs_label_id", 201);
    const sub = byDiscogs(env, "labels", "discogs_label_id", 202);
    expect(parent).toMatchObject({ name: "Lowlight Recordings", contact_info: "Synthetic address, Demo City" });
    expect(sub.parent_label_id).toBe(parent.id);
    expect(n(env, "SELECT COUNT(*) AS n FROM labels WHERE discogs_label_id IS NOT NULL")).toBe(6);
  });

  it("imports masters with credits, genres and styles", async () => {
    const env = setup();
    await importAll(env);
    const m = byDiscogs(env, "masters", "discogs_master_id", 301);
    expect(m).toMatchObject({ title: "Nightbus Dialogues", year: 1997, main_release_discogs_id: 401 });
    expect(m.main_release_id).toBe(byDiscogs(env, "releases", "discogs_release_id", 401).id);
    const credits = env.db.prepare("SELECT name, anv, join_text, artist_id FROM master_artists WHERE master_id = ? ORDER BY position").all(m.id) as any[];
    expect(credits.map((c) => (c.anv || c.name) + c.join_text).join("")).toBe("Aurelia Kaan & José G.");
    expect(credits.every((c) => c.artist_id)).toBe(true);
    expect(env.db.prepare("SELECT genre FROM master_genres WHERE master_id = ? ORDER BY genre").all(m.id).map((x: any) => x.genre)).toEqual(["Electronic", "Jazz"]);
    // An artist that isn't in the artists dump stays unresolved (kept as a Discogs id + name).
    const orphan = byDiscogs(env, "masters", "discogs_master_id", 303);
    expect(q(env, "SELECT artist_id, discogs_artist_id, name FROM master_artists WHERE master_id = ?", orphan.id)).toEqual({ artist_id: null, discogs_artist_id: 998, name: "Unimported Artist" });
  });

  it("imports a release with every relationship", async () => {
    const env = setup();
    await importAll(env);
    const r = byDiscogs(env, "releases", "discogs_release_id", 401);
    expect(r).toMatchObject({ title: "Nightbus Dialogues", year: 1997, released_date: "1997-03-00", country: "UK", status: "Accepted", data_quality: "Correct",
      catalog_number: "LLR-004", catalog_number_norm: "LLR004", format: "Vinyl", verification_status: "sourced" });
    expect(r.master_id).toBe(byDiscogs(env, "masters", "discogs_master_id", 301).id);
    const rec = getReleaseRecord(env.db, r.id)!;
    expect(rec.artists.map((a: any) => [a.name, a.anv, a.join_text])).toEqual([["Aurelia Kaan", null, " & "], ["José González-Ñuñez", "José G.", ""]]);
    expect(rec.artists.every((a: any) => a.artist_id)).toBe(true);
    expect(rec.labels).toEqual([
      expect.objectContaining({ name: "Lowlight Recordings", catalog_number: "LLR-004", label_id: byDiscogs(env, "labels", "discogs_label_id", 201).id }),
      expect.objectContaining({ name: "Lowlight White", catalog_number: "LLRW-004", label_id: byDiscogs(env, "labels", "discogs_label_id", 202).id }),
    ]);
    expect(rec.formats).toEqual([{ name: "Vinyl", quantity: 2, text: "Clear", descriptions: ['12"', "33 ⅓ RPM", "EP"] }, { name: "CD", quantity: 1, text: null, descriptions: ["Promo"] }]);
    expect(rec.genres.sort()).toEqual(["Electronic", "Jazz"]);
    expect(rec.styles.sort()).toEqual(["Deep House", "Garage"]);
    expect(rec.extra_artists).toEqual([
      expect.objectContaining({ name: "Idris Vale", role: "Producer" }),
      expect.objectContaining({ name: "Paz Olvera", role: "Mastered By", tracks: "A1, B1" }),
    ]);
    expect(rec.companies.map((c: any) => [c.name, c.role, c.catalog_number])).toEqual([
      ["Sample Pressing Plant", "Pressed By", null], ["Demo Mastering Room", "Mastered At", "DMR-1"], ["Unknown Cutting Room", "Lacquer Cut At", null],
    ]);
    expect(rec.identifiers).toEqual([
      { type: "Barcode", value: "5 012345 678900", description: "Text" }, { type: "Matrix / Runout", value: "LLR-004-A ◇ LOW ◇", description: "Side A" },
      { type: "Label Code", value: "LC 00000", description: null }, { type: "SPARS Code", value: "DDD", description: null },
    ]);
    // Track types: heading, index track with sub-tracks, track-level credits.
    expect(rec.tracks.map((t: any) => [t.position, t.track_type, t.duration])).toEqual([
      ["A1", "track", "6:48"], ["A2", "track", "5:30"], ["", "heading", null], ["B1", "index", "12:02"], ["B1a", "subtrack", "6:00"], ["B1b", "subtrack", "6:02"], ["B2", "track", "7:40"],
    ]);
    const b1 = rec.tracks.find((t: any) => t.position === "B1")!;
    expect(rec.tracks.filter((t: any) => t.parent_track_id === b1.id).map((t: any) => t.position)).toEqual(["B1a", "B1b"]);
    expect(rec.tracks[0].artists[0]).toMatchObject({ name: "José González-Ñuñez" });
    expect(rec.tracks.find((t: any) => t.position === "B2")!.extra_artists[0]).toMatchObject({ role: "Remix", anv: "Kovač Unit" });
    // Only the YouTube video is kept, with Discogs provenance.
    expect(env.db.prepare("SELECT external_id, title FROM release_media_links WHERE release_id = ?").all(r.id)).toEqual([{ external_id: "abcdefghijk", title: "Nightbus Dialogues (synthetic video)" }]);
  });

  it("keeps missing optional fields empty, new formats as-is, and unresolved references for later", async () => {
    const env = setup();
    await importAll(env);
    expect(byDiscogs(env, "releases", "discogs_release_id", 403)).toMatchObject({ title: "夜明けのレコード", country: null, released_date: null, year: null, catalog_number: null, format: "Cassette" });
    const r404 = byDiscogs(env, "releases", "discogs_release_id", 404);
    expect(r404).toMatchObject({ master_id: null, discogs_master_id: 399, format: "8-Track Cartridge", year: 1975 });
    expect(q(env, "SELECT artist_id, discogs_artist_id FROM release_artists WHERE release_id = ?", r404.id)).toEqual({ artist_id: null, discogs_artist_id: 999 });
    expect(q(env, "SELECT label_id, discogs_label_id, catalog_number FROM release_labels WHERE release_id = ?", r404.id)).toEqual({ label_id: null, discogs_label_id: 299, catalog_number: "UL-1" });
    expect(unresolvedCounts(env.db)).toMatchObject({ releases_without_master: 1, release_artist_credits: 1, release_labels: 1 });
  });

  it("handles duplicate external ids within a file and records invalid releases without stopping", async () => {
    const env = setup();
    await importAll(env);
    const run = getRun(env.db);
    expect(run).toMatchObject({ entity_type: "releases", status: "completed_with_errors", records_processed: 7, records_created: 4, records_unchanged: 1, records_failed: 2 });
    expect(n(env, "SELECT COUNT(*) AS n FROM releases WHERE discogs_release_id = 402")).toBe(1);
    expect(runErrors(env.db, run.id).map((e: any) => [e.external_id, e.message])).toEqual([["405", "release has no title"], ["abc", "release: id “abc” is not a number"]]);
    expect(run.file_hash).toBe(crypto.createHash("sha256").update(fs.readFileSync(f("releases.xml.gz"))).digest("hex"));
    expect(fs.readFileSync(run.error_log_location, "utf8")).toContain("release has no title");
  });

  it("re-running the same dump is idempotent: nothing created or updated, ids unchanged", async () => {
    const env = setup();
    await importAll(env);
    const ids = env.db.prepare("SELECT id, discogs_release_id FROM releases WHERE discogs_release_id IS NOT NULL ORDER BY id").all();
    const children = n(env, "SELECT (SELECT COUNT(*) FROM release_tracks) + (SELECT COUNT(*) FROM release_labels) + (SELECT COUNT(*) FROM release_companies) + (SELECT COUNT(*) FROM companies) AS n");
    const again = await importAll(env);
    for (const t of ["artists", "labels", "masters", "releases"]) expect(again[t]).toMatchObject({ created: 0, updated: 0 });
    expect(again.releases.unchanged).toBe(5);
    expect(env.db.prepare("SELECT id, discogs_release_id FROM releases WHERE discogs_release_id IS NOT NULL ORDER BY id").all()).toEqual(ids);
    expect(n(env, "SELECT (SELECT COUNT(*) FROM release_tracks) + (SELECT COUNT(*) FROM release_labels) + (SELECT COUNT(*) FROM release_companies) + (SELECT COUNT(*) FROM companies) AS n")).toBe(children);
  });

  it("monthly update: changed → updated, new → inserted, absent → kept; internal ids and user copies preserved", async () => {
    const env = setup();
    await importAll(env);
    const r401 = byDiscogs(env, "releases", "discogs_release_id", 401);
    const { createCopy } = await import("../src/domain/library.js");
    const copyId = createCopy(env.db, env.clock, env.seed.users.mara, r401.id, { media_condition: "VG+", sleeve_condition: "VG", private_notes: "mine" });
    await runImport(env.db, { file: f("masters.xml.gz"), logDir: logDir() });
    const v2 = await runImport(env.db, { file: f("releases_v2.xml.gz"), type: "releases", logDir: logDir() });
    expect(v2).toMatchObject({ created: 1, updated: 1, unchanged: 2, failed: 0, status: "completed" });
    const after = byDiscogs(env, "releases", "discogs_release_id", 401);
    expect(after.id).toBe(r401.id);
    expect(after.notes).toContain("corrected in the v2 dump");
    expect(env.db.prepare("SELECT style FROM release_styles WHERE release_id = ? ORDER BY style").all(after.id).map((x: any) => x.style)).toEqual(["Broken Beat", "Deep House", "Garage"]);
    expect(byDiscogs(env, "releases", "discogs_release_id", 403)).toBeTruthy(); // absent from v2, not deleted
    const r406 = byDiscogs(env, "releases", "discogs_release_id", 406);
    expect(r406).toMatchObject({ format: "Reel-To-Reel", released_date: "2001-11" });
    expect(r406.master_id).toBe(byDiscogs(env, "masters", "discogs_master_id", 303).id);
    expect(q(env, "SELECT release_id, private_notes FROM copies WHERE id = ?", copyId)).toEqual({ release_id: r401.id, private_notes: "mine" });
  });

  it("does not overwrite releases with local editorial edits; logs a conflict instead", async () => {
    const env = setup();
    await importAll(env);
    const r401 = byDiscogs(env, "releases", "discogs_release_id", 401);
    env.db.prepare("UPDATE releases SET notes = 'Editorial note', local_edited_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(r401.id);
    const v2 = await runImport(env.db, { file: f("releases_v2.xml.gz"), type: "releases", logDir: logDir() });
    expect(v2.skippedLocal).toBe(1);
    expect(byDiscogs(env, "releases", "discogs_release_id", 401).notes).toBe("Editorial note");
    expect(runErrors(env.db, v2.runId).map((e: any) => e.error_type)).toContain("local_edit_conflict");
  });

  it("imports out of order gracefully and reconciles references afterwards", async () => {
    const env = setup();
    await runImport(env.db, { file: f("releases.xml.gz"), logDir: logDir() });
    const r401 = byDiscogs(env, "releases", "discogs_release_id", 401);
    expect(r401.master_id).toBeNull();
    expect(q(env, "SELECT artist_id FROM release_artists WHERE release_id = ? ORDER BY position", r401.id).artist_id).toBeNull();
    await runImport(env.db, { file: f("artists.xml.gz"), logDir: logDir() });
    await runImport(env.db, { file: f("labels.xml.gz"), logDir: logDir() });
    await runImport(env.db, { file: f("masters.xml.gz"), logDir: logDir() });
    const again = byDiscogs(env, "releases", "discogs_release_id", 401);
    expect(again.master_id).toBe(byDiscogs(env, "masters", "discogs_master_id", 301).id);
    expect(q(env, "SELECT artist_id FROM release_artists WHERE release_id = ? ORDER BY position", r401.id).artist_id).toBe(byDiscogs(env, "artists", "discogs_artist_id", 101).id);
    expect(again.label_id).toBe(byDiscogs(env, "labels", "discogs_label_id", 201).id);
    expect(Object.values(reconcileReferences(env.db)).every((v) => v === 0)).toBe(true); // already done at the end of each run
  });

  it("an interruption can be resumed from the checkpoint without duplicates", async () => {
    const env = setup();
    await expect(runImport(env.db, { file: f("releases.xml.gz"), batchSize: 2, failAfterRecords: 2, logDir: logDir() })).rejects.toThrow(/Simulated interruption/);
    const failed = getRun(env.db);
    expect(failed).toMatchObject({ status: "failed", checkpoint_record_index: 2, records_processed: 2 });
    expect(n(env, "SELECT COUNT(*) AS n FROM releases WHERE discogs_release_id IS NOT NULL")).toBe(2);
    const resumed = await runImport(env.db, { file: f("releases.xml.gz"), resumeRunId: failed.id, batchSize: 2, logDir: logDir() });
    expect(resumed.runId).toBe(failed.id);
    expect(resumed).toMatchObject({ processed: 7, created: 4, failed: 2, status: "completed_with_errors" });
    expect(n(env, "SELECT COUNT(*) AS n FROM releases WHERE discogs_release_id IS NOT NULL")).toBe(4);
    expect(n(env, "SELECT COUNT(*) AS n FROM release_labels rl JOIN releases r ON r.id = rl.release_id WHERE r.discogs_release_id = 401")).toBe(2);
  });

  it("--limit stops early as a resumable partial run", async () => {
    const env = setup();
    const partial = await runImport(env.db, { file: f("releases.xml.gz"), limit: 2, logDir: logDir() });
    expect(partial.status).toBe("cancelled");
    expect(getRun(env.db, partial.runId).checkpoint_record_index).toBe(2);
    const rest = await runImport(env.db, { file: f("releases.xml.gz"), resumeRunId: partial.runId, logDir: logDir() });
    expect(rest.status).toBe("completed_with_errors");
    expect(n(env, "SELECT COUNT(*) AS n FROM releases WHERE discogs_release_id IS NOT NULL")).toBe(4);
  });

  it("fatal errors mark the run failed with a message; committed batches survive", async () => {
    const env = setup();
    await expect(runImport(env.db, { file: f("malformed.xml"), type: "releases", batchSize: 1, logDir: logDir() })).rejects.toThrow(/not well-formed/);
    const run = getRun(env.db);
    expect(run.status).toBe("failed");
    expect(run.fatal_error).toMatch(/not well-formed/);
    expect(byDiscogs(env, "releases", "discogs_release_id", 501)).toBeTruthy();
    expect(byDiscogs(env, "releases", "discogs_release_id", 503)).toBeUndefined();
    const env2 = setup();
    await expect(runImport(env2.db, { file: f("xxe.xml.gz"), type: "artists", logDir: logDir() })).rejects.toThrow(/DOCTYPE/);
    expect(n(env2, "SELECT COUNT(*) AS n FROM artists WHERE name LIKE '%root%'")).toBe(0);
    // A second run of the same type can't start while one is marked running.
    env2.db.prepare("UPDATE catalog_import_runs SET status = 'running'").run();
    await expect(runImport(env2.db, { file: f("artists.xml.gz"), logDir: logDir() })).rejects.toThrow(/marked running/);
  });

  it("records dump version/date from official file names and flags checksum mismatches", async () => {
    const env = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dump-"));
    const named = path.join(dir, "discogs_20260901_labels.xml.gz");
    fs.copyFileSync(f("labels.xml.gz"), named);
    const r = await runImport(env.db, { file: named, expectedHash: "0".repeat(64), logDir: logDir() });
    const run = getRun(env.db, r.runId);
    expect(run).toMatchObject({ source_version: "20260901", dump_date: "2026-09-01", entity_type: "labels", status: "completed_with_errors" });
    expect(run.fatal_error).toMatch(/does not match the published checksum/);
  });
});

describe("catalog search and API after import", () => {
  it("finds artists, releases, labels, catalog numbers and barcodes (accent-insensitive)", async () => {
    const env = setup();
    await importAll(env);
    const types = (qs: string) => unifiedSearch(env.db, qs).map((r) => `${r.type}:${r.title}`);
    expect(types("Aurelia")).toContain("artist:Aurelia Kaan");
    expect(types("gonzalez")).toContain("artist:José González-Ñuñez");
    expect(types("Lowlight White")).toContain("label:Lowlight White");
    const catno = unifiedSearch(env.db, "LLRW004", { types: ["release"] });
    expect(catno.map((r) => r.id)).toEqual([byDiscogs(env, "releases", "discogs_release_id", 401).id]);
    const barcode = unifiedSearch(env.db, "5012345678900", { types: ["release"] });
    expect(barcode[0]).toMatchObject({ type: "release", title: "Nightbus Dialogues", catalog_number: "LLR-004", country: "UK" });
    expect(types("夜明け")).toContain("release:夜明けのレコード");
    expect(unifiedSearch(env.db, 'x" OR 1=1 --')).toEqual([]); // query syntax is neutralised
  });

  it("serves releases by internal and Discogs id, and relationship queries, over /api/v1", async () => {
    const env = setup();
    await importAll(env);
    const a = await agentFor(env);
    const r = (await a.get("/api/v1/releases/discogs/401")).body;
    expect(r).toMatchObject({ discogs_release_id: 401, title: "Nightbus Dialogues" });
    expect((await a.get(`/api/v1/releases/${r.id}`)).body.labels).toHaveLength(2);
    const plant = r.companies.find((c: any) => c.role === "Pressed By");
    const pressed = (await a.get(`/api/v1/companies/${plant.company_id}/releases?role=Pressed%20By`)).body.items.map((x: any) => x.title);
    expect(pressed).toEqual(["Nightbus Dialogues", "Nightbus Dialogues"]); // 401 and 402 pressed at the same plant
    const artist = r.artists[0].artist_id;
    expect((await a.get(`/api/v1/artists/${artist}/releases?limit=1`)).body.next_after).not.toBeNull();
    expect((await a.get("/api/v1/search?q=Kovac")).body.results.map((x: any) => x.type)).toContain("artist");
    for (const url of [`/releases/${r.id}`, `/masters/${r.master_id}`, `/artists/${artist}`, `/labels/${r.labels[0].label_id}`, `/companies/${plant.company_id}`, "/search?q=LLR-004", "/discover?q=nightbus"]) {
      expect((await a.get(url)).status, url).toBe(200);
    }
    expect((await a.get("/api/v1/releases/discogs/123456789")).status).toBe(404);
  });

  it("Discogs CSV collection rows match imported catalog releases by release_id", async () => {
    const env = setup();
    await importAll(env);
    const csv = "Catalog#,Artist,Title,Label,Format,Rating,Released,release_id,CollectionFolder,Date Added,Collection Media Condition,Collection Sleeve Condition\n" +
      'LLR-004,Aurelia Kaan,Nightbus Dialogues,Lowlight Recordings,"Vinyl, 12""",,1997,401,Uncategorized,2024-01-01 10:00:00,Very Good Plus (VG+),Very Good (VG)\n' +
      'X-1,Someone,Not In Catalog,Label,"Vinyl, 12""",,2000,77777777,Uncategorized,2024-01-01 10:00:00,Very Good (VG),Very Good (VG)\n';
    const id = previewImport(env.db, env.clock, env.seed.users.mara, { kind: "discogs_collection", sourceName: "", filename: "c.csv", buffer: Buffer.from(csv) });
    expect(getBatch(env.db, env.seed.users.mara, id).counts).toMatchObject({ new: 2, matched_catalog: 1 });
    commitImport(env.db, env.clock, env.seed.users.mara, id);
    const copies = env.db.prepare("SELECT title_text, release_id FROM copies WHERE created_by_batch_id = ? ORDER BY id").all(id) as any[];
    expect(copies[0]).toEqual({ title_text: "Nightbus Dialogues", release_id: byDiscogs(env, "releases", "discogs_release_id", 401).id });
    expect(copies[1]).toEqual({ title_text: "Not In Catalog", release_id: null });
    // The catalog release row itself holds no ownership data.
    expect(Object.keys(byDiscogs(env, "releases", "discogs_release_id", 401))).not.toContain("owner_id");
  });
});
