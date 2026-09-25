import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setup, type TestEnv } from "./helpers.js";
import { getRun, runImport, runImportAll } from "../src/services/importer/discogs/runner.js";
import { reindexAll, searchIndexState, type SearchBackend, type SearchDocument } from "../src/services/search/index.js";
import { unifiedSearch } from "../src/services/catalog-api/index.js";
import { DiscogsCatalogWriter, reconcileReferences, staleReferenceCounts } from "../src/services/importer/discogs/writer.js";
import { masterFromNode, releaseFromNode } from "../src/services/importer/discogs/normalize.js";
import { streamRecords } from "../src/services/importer/discogs/stream.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hardening-"));
const logDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "catalog-logs-"));
const q = (env: TestEnv, sql: string, ...a: unknown[]) => env.db.prepare(sql).get(...a) as any;

function dump(name: string, root: string, body: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<${root}>\n${body}\n</${root}>\n`);
  return file;
}
const master = (id: number, main: number | null, title = `Master ${id}`) =>
  `<master id="${id}">${main != null ? `<main_release>${main}</main_release>` : ""}<artists><artist><id>9001</id><name>Hardening Artist</name><anv/><join/><role/><tracks/></artist></artists><year>2000</year><title>${title}</title><data_quality>Correct</data_quality></master>`;
const release = (id: number, masterId: number | null, title = `Release ${id}`) =>
  `<release id="${id}" status="Accepted"><artists><artist><id>9001</id><name>Hardening Artist</name><anv/><join/><role/><tracks/></artist></artists><title>${title}</title><labels><label name="Hardening Label" catno="HL ${id}" id="9101"/></labels><formats><format name="Vinyl" qty="1" text=""/></formats>${masterId != null ? `<master_id is_main_release="false">${masterId}</master_id>` : ""}<tracklist><track><position>A</position><title>One</title><duration/></track></tracklist></release>`;
const label = (id: number, parent: number | null) =>
  `<label><id>${id}</id><name>Label ${id}</name>${parent != null ? `<parentLabel id="${parent}">Label ${parent}</parentLabel>` : ""}<data_quality>Correct</data_quality></label>`;

const imp = (env: TestEnv, file: string, type: string) => runImport(env.db, { file, type: type as any, logDir: logDir() });
const releaseRow = (env: TestEnv, discogs: number) => q(env, "SELECT id, master_id, discogs_master_id FROM releases WHERE discogs_release_id = ?", discogs);
const masterRow = (env: TestEnv, discogs: number) => q(env, "SELECT id, main_release_id, main_release_discogs_id FROM masters WHERE discogs_master_id = ?", discogs);
const noStale = (env: TestEnv) => expect(Object.values(staleReferenceCounts(env.db)).every((v) => v === 0)).toBe(true);

/** Parses a dump file and writes it with the writer alone: no runner, no reconciliation. */
async function writeOnly(env: TestEnv, file: string, type: "masters" | "releases") {
  const recs: any[] = [];
  await streamRecords(file, type.slice(0, -1), (n) => { recs.push(type === "masters" ? masterFromNode(n!) : releaseFromNode(n!)); });
  const runId = Number(env.db.prepare("INSERT INTO catalog_import_runs (source, entity_type, file_name, status, started_at, created_at, updated_at) VALUES ('discogs', ?, 'test', 'running', 'now', 'now', 'now')").run(type).lastInsertRowid);
  const w = new DiscogsCatalogWriter(env.db, runId, () => new Date().toISOString());
  return env.db.transaction(() => (type === "masters" ? w.writeMasters(recs) : w.writeReleases(recs)))();
}

describe("paired Discogs id + internal FK stay consistent", () => {
  it("the writer itself never keeps an old internal FK when the Discogs relationship changes (no reconcile involved)", async () => {
    const env = setup();
    await writeOnly(env, dump("w-m1.xml", "masters", master(8150, 8550)), "masters");
    await writeOnly(env, dump("w-r1.xml", "releases", release(8550, 8150)), "releases");
    const old = masterRow(env, 8150).id;
    expect(releaseRow(env, 8550).master_id).toBe(old);
    // Update the master link to an unimported master, and the main release to an unimported release.
    await writeOnly(env, dump("w-r2.xml", "releases", release(8550, 8250, "moved")), "releases");
    await writeOnly(env, dump("w-m2.xml", "masters", master(8150, 8559, "new main")), "masters");
    expect(releaseRow(env, 8550)).toEqual({ id: releaseRow(env, 8550).id, master_id: null, discogs_master_id: 8250 });
    expect(masterRow(env, 8150)).toMatchObject({ main_release_id: null, main_release_discogs_id: 8559 });
    noStale(env);
  });

  it("release → master: changing to a not-yet-imported master clears the old link; importing it later links the new one", async () => {
    const env = setup();
    await imp(env, dump("m1.xml", "masters", master(8100, 8500)), "masters");
    await imp(env, dump("r1.xml", "releases", release(8500, 8100)), "releases");
    const oldMaster = masterRow(env, 8100);
    expect(releaseRow(env, 8500)).toMatchObject({ master_id: oldMaster.id, discogs_master_id: 8100 });

    // New dump: release 8500 now belongs to master 8200, which isn't in the catalog yet.
    const r = await imp(env, dump("r2.xml", "releases", release(8500, 8200, "Release 8500 (moved)")), "releases");
    expect(r.updated).toBe(1);
    const moved = releaseRow(env, 8500);
    expect(moved.discogs_master_id).toBe(8200);
    expect(moved.master_id).toBeNull();                 // the OLD internal link must be gone…
    expect(moved.master_id).not.toBe(oldMaster.id);
    expect(reconcileReferences(env.db).release_master).toBe(0); // …and reconciliation can't resurrect it
    expect(releaseRow(env, 8500).master_id).toBeNull();
    noStale(env);

    // Master 8200 arrives in a later masters import: the import's reconcile links the new master.
    await imp(env, dump("m2.xml", "masters", master(8200, 8500)), "masters");
    const newMaster = masterRow(env, 8200);
    expect(releaseRow(env, 8500)).toMatchObject({ master_id: newMaster.id, discogs_master_id: 8200 });
    expect(newMaster.main_release_id).toBe(releaseRow(env, 8500).id);
    noStale(env);
  });

  it("release → master: a relationship removed by Discogs is removed locally too", async () => {
    const env = setup();
    await imp(env, dump("m3.xml", "masters", master(8110, null)), "masters");
    await imp(env, dump("r3.xml", "releases", release(8510, 8110)), "releases");
    expect(releaseRow(env, 8510).master_id).toBe(masterRow(env, 8110).id);
    await imp(env, dump("r4.xml", "releases", release(8510, null, "Now standalone")), "releases");
    expect(releaseRow(env, 8510)).toMatchObject({ master_id: null, discogs_master_id: null });
    noStale(env);
  });

  it("master → main release: changing to a not-yet-imported release clears the old link; importing it later links the new one", async () => {
    const env = setup();
    await imp(env, dump("r5.xml", "releases", [release(8520, 8120), release(8521, 8120)].join("\n")), "releases");
    await imp(env, dump("m5.xml", "masters", master(8120, 8520)), "masters");
    const oldMain = releaseRow(env, 8520).id;
    expect(masterRow(env, 8120)).toMatchObject({ main_release_id: oldMain, main_release_discogs_id: 8520 });

    // Discogs promotes release 8599 (not imported yet) to main release.
    await imp(env, dump("m6.xml", "masters", master(8120, 8599, "Master 8120 (new main)")), "masters");
    const m = masterRow(env, 8120);
    expect(m.main_release_discogs_id).toBe(8599);
    expect(m.main_release_id).toBeNull();
    expect(m.main_release_id).not.toBe(oldMain);
    expect(reconcileReferences(env.db).master_main_release).toBe(0);
    noStale(env);

    await imp(env, dump("r6.xml", "releases", release(8599, 8120)), "releases");
    expect(masterRow(env, 8120).main_release_id).toBe(releaseRow(env, 8599).id);
    noStale(env);
  });

  it("label → parent label: a changed parent that isn't imported yet clears the old link, then reconciles", async () => {
    const env = setup();
    await imp(env, dump("l1.xml", "labels", [label(8301, null), label(8303, 8301)].join("\n")), "labels");
    const lab = () => q(env, "SELECT parent_label_id, parent_discogs_label_id FROM labels WHERE discogs_label_id = 8303");
    const oldParent = q(env, "SELECT id FROM labels WHERE discogs_label_id = 8301").id;
    expect(lab().parent_label_id).toBe(oldParent);
    await imp(env, dump("l2.xml", "labels", label(8303, 8302)), "labels");
    expect(lab()).toEqual({ parent_label_id: null, parent_discogs_label_id: 8302 });
    await imp(env, dump("l3.xml", "labels", label(8302, null)), "labels");
    expect(lab().parent_label_id).toBe(q(env, "SELECT id FROM labels WHERE discogs_label_id = 8302").id);
    noStale(env);
  });

  it("reconcile repairs rows left inconsistent by the earlier COALESCE writer, and never touches locally edited rows", async () => {
    const env = setup();
    await imp(env, dump("m7.xml", "masters", [master(8130, 8530), master(8131, null)].join("\n")), "masters");
    await imp(env, dump("r7.xml", "releases", [release(8530, 8130), release(8531, 8130), release(8532, 8130)].join("\n")), "releases");
    const m8130 = masterRow(env, 8130).id;
    const m8131 = masterRow(env, 8131).id;
    // Simulate the old bug's damage: the external id moved on, the internal link didn't.
    env.db.prepare("UPDATE releases SET discogs_master_id = 8131 WHERE discogs_release_id = 8530").run();       // → wrong master
    env.db.prepare("UPDATE releases SET discogs_master_id = 8199 WHERE discogs_release_id = 8531").run();       // → unimported master
    env.db.prepare("UPDATE masters SET main_release_discogs_id = 8598 WHERE discogs_master_id = 8130").run();   // → unimported release
    expect(staleReferenceCounts(env.db)).toMatchObject({ stale_release_master: 2, stale_master_main_release: 1 });
    // A local editorial edit is left alone even if it disagrees.
    env.db.prepare("UPDATE releases SET discogs_master_id = 8131, local_edited_at = '2026-01-01' WHERE discogs_release_id = 8532").run();

    const res = reconcileReferences(env.db);
    expect(res.stale_release_master).toBe(2);
    expect(res.stale_master_main_release).toBe(1);
    expect(releaseRow(env, 8530).master_id).toBe(m8131);  // cleared, then re-linked to the right master
    expect(releaseRow(env, 8531).master_id).toBeNull();   // cleared; waits for master 8199
    expect(masterRow(env, 8130).main_release_id).toBeNull();
    expect(releaseRow(env, 8532).master_id).toBe(m8130);  // local edit untouched
    expect(staleReferenceCounts(env.db)).toEqual({ stale_release_master: 0, stale_master_main_release: 0, stale_label_parent: 0 });
  });
});

const FIX = path.join(__dirname, "fixtures", "discogs");
const QUERIES = ["Aurelia", "gonzalez", "Lowlight White", "LLRW004", "5012345678900", "夜明け", "Nightbus", "Tidal Rooms", "Orphan"];
const results = (env: TestEnv) => Object.fromEntries(QUERIES.map((qs) => [qs, unifiedSearch(env.db, qs).map((r) => `${r.type}:${r.id}:${r.title}`).sort()]));
const CATALOG_TABLES = ["artists", "artist_aliases", "artist_members", "labels", "companies", "masters", "master_artists", "releases", "release_artists", "release_extra_artists",
  "release_labels", "release_companies", "release_tracks", "release_track_artists", "release_formats", "release_format_descriptions", "release_identifiers", "release_genres",
  "release_styles", "release_media_links", "external_identifiers", "catalog_provenance"];
const tableCounts = (env: TestEnv) => Object.fromEntries(CATALOG_TABLES.map((t) => [t, q(env, `SELECT COUNT(*) AS n FROM ${t}`).n]));
function fixtureDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dumps-"));
  for (const t of ["artists", "labels", "masters", "releases"]) fs.copyFileSync(path.join(FIX, `${t}.xml.gz`), path.join(d, `discogs_20260901_${t}.xml.gz`));
  return d;
}

describe("deferred-search bulk import", () => {
  it("writes identical catalog data, leaves search intentionally stale, and one reindex restores identical results", async () => {
    const d = fixtureDir();
    const normal = setup();
    const n = await runImportAll(normal.db, { dir: d, logDir: logDir() });
    expect(n.reindexed).toBeNull();
    expect(n.runs.every((r) => r.searchMode === "incremental")).toBe(true);
    expect(searchIndexState(normal.db).stale_since).toBeNull();

    // Deferred single-file imports (as `catalog import --defer-search` does): catalog written, search untouched.
    const bulk = setup();
    for (const t of ["artists", "labels", "masters", "releases"]) {
      const r = await runImport(bulk.db, { file: path.join(d, `discogs_20260901_${t}.xml.gz`), deferSearch: true, logDir: logDir() });
      expect(r.searchMode).toBe("deferred");
      expect(getRun(bulk.db, r.runId).search_mode).toBe("deferred");
      expect(r.timings.writer.search).toBe(0);
    }
    expect(tableCounts(bulk)).toEqual(tableCounts(normal));
    const rel = (env: TestEnv) => q(env, "SELECT title, master_id IS NOT NULL AS has_master, catalog_number, country FROM releases WHERE discogs_release_id = 401");
    expect(rel(bulk)).toEqual(rel(normal));
    // Search is absent for imported records, and the state says why.
    const imported = (env: TestEnv, qs: string) => unifiedSearch(env.db, qs).filter((r) =>
      q(env, `SELECT 1 AS x FROM ${({ artist: "artists", label: "labels", master: "masters", release: "releases" } as any)[r.type]} WHERE id = ? AND discogs_${r.type}_id IS NOT NULL`, r.id));
    for (const qs of QUERIES) expect(imported(normal, qs).length, qs).toBeGreaterThan(0);
    for (const qs of QUERIES) expect(imported(bulk, qs), qs).toEqual([]);
    expect(searchIndexState(bulk.db)).toMatchObject({ stale_reason: expect.stringMatching(/deferred search/) });
    expect(searchIndexState(bulk.db).stale_since).not.toBeNull();

    reindexAll(bulk.db);
    expect(searchIndexState(bulk.db).stale_since).toBeNull();
    // The seed catalog shares internal ids between the two setups, so results are directly comparable.
    expect(results(bulk)).toEqual(results(normal));
    expect(results(bulk)["LLRW004"].length).toBeGreaterThan(0);
  });

  it("import-all --defer-search reconciles and reindexes once at the end", async () => {
    const d = fixtureDir();
    const normal = setup();
    await runImportAll(normal.db, { dir: d, logDir: logDir() });
    const bulk = setup();
    const r = await runImportAll(bulk.db, { dir: d, deferSearch: true, logDir: logDir() });
    expect(r.runs.map((x) => x.type)).toEqual(["artists", "labels", "masters", "releases"]);
    expect(r.runs.every((x) => x.searchMode === "deferred")).toBe(true);
    expect(r.reindexed!.documents).toBeGreaterThan(0);
    expect(searchIndexState(bulk.db)).toMatchObject({ stale_since: null, documents: r.reindexed!.documents });
    expect(results(bulk)).toEqual(results(normal));
    expect(r.unresolved).toEqual(unresolvedFor(normal));
  });

  it("a deferred update leaves the old document searchable until reindex, then only the new one", async () => {
    const env = setup();
    await imp(env, dump("s1.xml", "releases", release(8700, null, "Quartzline Original")), "releases");
    expect(unifiedSearch(env.db, "Quartzline").map((r) => r.title)).toEqual(["Quartzline Original"]);
    await runImport(env.db, { file: dump("s2.xml", "releases", release(8700, null, "Obsidian Renamed")), type: "releases", deferSearch: true, logDir: logDir() });
    expect(q(env, "SELECT title FROM releases WHERE discogs_release_id = 8700").title).toBe("Obsidian Renamed"); // catalog is authoritative
    expect(unifiedSearch(env.db, "Obsidian")).toEqual([]);                                                          // stale: new title not indexed
    expect(unifiedSearch(env.db, "Quartzline").map((r) => r.title)).toEqual(["Obsidian Renamed"]);                  // stale: old doc still matches
    reindexAll(env.db);
    expect(unifiedSearch(env.db, "Obsidian").map((r) => r.title)).toEqual(["Obsidian Renamed"]);
    expect(unifiedSearch(env.db, "Quartzline")).toEqual([]);
  });

  it("an interrupted deferred run keeps the stale flag; the resume keeps deferred mode", async () => {
    const env = setup();
    const file = path.join(FIX, "releases.xml.gz");
    await expect(runImport(env.db, { file, deferSearch: true, batchSize: 2, failAfterRecords: 2, logDir: logDir() })).rejects.toThrow(/Simulated/);
    const failed = getRun(env.db);
    expect(searchIndexState(env.db).stale_since).not.toBeNull();
    const resumed = await runImport(env.db, { file, resumeRunId: failed.id, logDir: logDir() });
    expect(resumed.searchMode).toBe("deferred");
    expect(searchIndexState(env.db).stale_since).not.toBeNull();
  });

  it("reindex goes through the SearchBackend interface only (no SQLite FTS coupling)", () => {
    const env = setup();
    const received: SearchDocument[] = [];
    let cleared = 0;
    const fake: SearchBackend = { upsert: (d) => { received.push(...d); }, remove: () => {}, search: () => [], clear: () => { cleared++; } };
    const n = reindexAll(env.db, fake);
    expect(cleared).toBe(1);
    expect(received).toHaveLength(n);
    const releases = q(env, "SELECT COUNT(*) AS n FROM releases").n;
    expect(received.filter((d) => d.type === "release")).toHaveLength(releases);
  });
});

function unresolvedFor(env: TestEnv) {
  return Object.fromEntries(Object.entries({
    releases_without_master: "SELECT COUNT(*) AS n FROM releases WHERE master_id IS NULL AND discogs_master_id IS NOT NULL",
    release_artist_credits: "SELECT COUNT(*) AS n FROM release_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL",
    extra_artist_credits: "SELECT COUNT(*) AS n FROM release_extra_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL",
    release_labels: "SELECT COUNT(*) AS n FROM release_labels WHERE label_id IS NULL AND discogs_label_id IS NOT NULL",
    master_artist_credits: "SELECT COUNT(*) AS n FROM master_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL",
    track_artist_credits: "SELECT COUNT(*) AS n FROM release_track_artists WHERE artist_id IS NULL AND discogs_artist_id IS NOT NULL",
    artist_aliases: "SELECT COUNT(*) AS n FROM artist_aliases WHERE alias_artist_id IS NULL AND discogs_alias_id IS NOT NULL",
    artist_members: "SELECT COUNT(*) AS n FROM artist_members WHERE member_artist_id IS NULL AND discogs_member_id IS NOT NULL",
    label_parents: "SELECT COUNT(*) AS n FROM labels WHERE parent_label_id IS NULL AND parent_discogs_label_id IS NOT NULL",
    masters_main_release: "SELECT COUNT(*) AS n FROM masters WHERE main_release_id IS NULL AND main_release_discogs_id IS NOT NULL",
  }).map(([k, sql]) => [k, q(env, sql).n]));
}

describe("XML structure census", () => {
  it("every path in the synthetic fixtures is either imported or knowingly ignored", async () => {
    const { census } = await import("../src/services/importer/discogs/coverage.js");
    for (const [file, rec] of [["artists", "artist"], ["labels", "label"], ["masters", "master"], ["releases", "release"], ["releases_v2", "release"]]) {
      const c = await census(path.join(FIX, `${file}.xml.gz`), rec);
      expect(c.unknown.map((u) => u.path), file).toEqual([]);
      expect(c.records).toBeGreaterThan(0);
    }
  });

  it("reports unfamiliar structures instead of silently dropping them", async () => {
    const { census } = await import("../src/services/importer/discogs/coverage.js");
    const file = dump("census.xml", "releases",
      `<release id="1" status="Accepted"><title>Ünïcode</title><series><series name="Sample Series" catno="SS-1" id="77"/></series><formats><format name="Vinyl" qty="1" text=""><descriptions/></format></formats></release>
       <release id="2" status="Accepted"><title>Plain</title></release>`);
    const c = await census(file, "release");
    expect(c.records).toBe(2);
    expect(c.unknown.map((u) => u.path)).toEqual(["release/series", "release/series/series", "release/series/series@catno", "release/series/series@id", "release/series/series@name"]);
    expect(c.unknown.find((u) => u.path === "release/series/series@name")).toMatchObject({ records: 1, sample: "Sample Series" });
    expect(c.unicodeRecords).toBe(1);
    expect(c.emptyElements).toBeGreaterThan(0);
    const limited = await census(file, "release", 1);
    expect(limited.records).toBe(1);
  });
});
