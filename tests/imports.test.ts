import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentFor, setup, type TestEnv } from "./helpers.js";
import { parseCsv } from "../src/imports/csv.js";
import { discogsCollectionAdapter, discogsWantlistAdapter, formatGroup, mapCondition } from "../src/imports/adapters/discogs.js";
import { rekordboxAdapter } from "../src/imports/adapters/rekordbox.js";
import {
  beginCommit, commitImport, commitNextChunk, decideAllUndecided, decideRow, getBatch, previewImport, undoImport,
} from "../src/imports/service.js";
import { ImportFileError } from "../src/imports/text.js";
import { addToCrate, createCrate, getOwnCopy, getOwnDigital, updateCopy, updateDigital } from "../src/domain/library.js";
import { discogsCollectionCsv, rekordboxXml } from "../scripts/large-fixtures.js";

const FIX = path.join(__dirname, "..", "fixtures");
const file = (p: string) => fs.readFileSync(path.join(FIX, p));

function run(env: TestEnv, kind: "discogs_collection" | "discogs_wantlist" | "rekordbox", buf: Buffer | string, user = "mara", sourceName = "") {
  env.clock.advanceMinutes(1);
  const id = previewImport(env.db, env.clock, env.seed.users[user], { kind, sourceName, filename: "test", buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf) });
  return getBatch(env.db, env.seed.users[user], id);
}
function commit(env: TestEnv, batchId: number, user = "mara") {
  env.clock.advanceMinutes(1);
  return commitImport(env.db, env.clock, env.seed.users[user], batchId);
}
const count = (env: TestEnv, sql: string, ...args: unknown[]) => (env.db.prepare(sql).get(...args) as { n: number }).n;
const importedCopies = (env: TestEnv) => count(env, "SELECT COUNT(*) AS n FROM copies WHERE owner_id = ? AND source_entry_id IS NOT NULL", env.seed.users.mara);
const importedDigital = (env: TestEnv) => count(env, "SELECT COUNT(*) AS n FROM digital_holdings WHERE owner_id = ? AND source_entry_id IS NOT NULL", env.seed.users.mara);

describe("CSV parsing", () => {
  it("handles BOM-stripped text, quoted commas, escaped quotes, embedded newlines, CRLF and blank lines", () => {
    const r = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n\r\n1,,3\n');
    expect(r.headers).toEqual(["a", "b", "c"]);
    expect(r.rows.map((x) => x.cells)).toEqual([["x, y", 'he said "hi"', "line1\nline2"], ["1", "", "3"]]);
    expect(r.rows.every((x) => !x.error)).toBe(true);
    expect(r.rows[1].line).toBe(5); // physical line numbers account for the embedded newline and the blank line
  });

  it("reports malformed rows individually instead of failing the whole file", () => {
    const r = parseCsv('a,b\n1,2\n1,2,3\n"ok",x\n');
    expect(r.rows[0].error).toBeUndefined();
    expect(r.rows[1].error).toMatch(/3 values but the header has 2/);
    expect(r.rows[2].error).toBeUndefined();
    const unterminated = parseCsv('a,b\n1,2\n"never closed,3\n4,5\n');
    expect(unterminated.rows[1].error).toMatch(/never closed/);
    expect(parseCsv("").fatal).toMatch(/empty/);
  });

  it("rejects non-UTF-8 files with an actionable message (saved as a failed import)", () => {
    const env = setup();
    const b = run(env, "discogs_collection", Buffer.from([0x41, 0x72, 0x74, 0xff, 0xfe, 0x0a]));
    expect(b.status).toBe("failed");
    expect(b.error).toMatch(/isn't valid UTF-8/);
    expect(() => beginCommit(env.db, env.clock, env.seed.users.mara, b.id)).toThrow(/couldn't be read/);
  });
});

describe("Discogs adapters", () => {
  it("maps by header name, keeps raw formats and unknown columns, and never invents genres", () => {
    const text = file("discogs/synthetic-collection-v1.csv").toString("utf8").replace(/^﻿/, "");
    const p = discogsCollectionAdapter.parse(text);
    expect(p.columns!.preserved).toEqual(["Storage Box"]);
    const first = p.rows[0];
    expect(first.fields).toMatchObject({ artist_text: "Aurelia Kaan", title_text: "Nightbus Dialogues", catno_text: "LLR-004", format_raw: 'Vinyl, 12", 33 ⅓ RPM, EP', format_group: "Vinyl", release_year: 1997, media_condition: "VG+", sleeve_condition: "VG", source_folder: "DJ Crates" });
    expect(first.fields).not.toHaveProperty("genre_text");
    expect((first.source as any).custom).toEqual({ "Storage Box": "Box A" });
    expect((first.source as any).discogs_url).toBe("https://www.discogs.com/release/9000101");
    const unit = p.rows.find((r) => r.fields.title_text === "Unit Theory")!;
    expect((unit.source as any).notes).toBe("Test pressing?\nCheck runout before gigging");
    expect(p.rows.find((r) => r.fields.title_text === "Salt Garden, Part 1")!.fields.format_group).toBe("Vinyl");
    expect(p.rows.find((r) => r.fields.title_text === "Soft Machines at Dawn")!.target).toBe("digital");
    expect(p.rows.find((r) => r.fields.title_text === "Olvera Tapes Vol. 1")!.fields).toMatchObject({ artist_text: "Paz Olvera", format_group: "Cassette", catno_text: null, sleeve_condition: "NONE" });
    expect(p.rows.find((r) => r.fields.title_text === "夜明けのレコード")!.fields.artist_text).toBe("井上 ひかり");
    expect(p.rows.filter((r) => r.errors.length)).toHaveLength(1);
  });

  it("works with reordered columns and missing optional columns", () => {
    const p = discogsCollectionAdapter.parse('Title,Artist,release_id\n"B, side",Someone,123\n');
    expect(p.rows[0].fields).toMatchObject({ artist_text: "Someone", title_text: "B, side", media_condition: "NG", format_group: "Other" });
    expect(p.notices.join(" ")).toMatch(/No media condition column/);
    const noId = discogsCollectionAdapter.parse("Artist,Title\nA,B\n");
    expect(noId.notices.join(" ")).toMatch(/No release_id column/);
    expect(() => discogsCollectionAdapter.parse("Foo,Bar\n1,2\n")).toThrow(ImportFileError);
  });

  it("normalises conditions and format groups conservatively", () => {
    const w: string[] = [];
    expect(mapCondition("Near Mint (NM or M-)", w, "m")).toBe("NM");
    expect(mapCondition("Very Good Plus (VG+)", w, "m")).toBe("VG+");
    expect(mapCondition("Good (G)", w, "m")).toBe("G");
    expect(mapCondition("Fair (F)", w, "m")).toBe("F");
    expect(mapCondition("", w, "m")).toBe("NG");
    expect(w).toHaveLength(0);
    expect(mapCondition("Shiny", w, "m")).toBe("NG");
    expect(w[0]).toMatch(/Unrecognised/);
    expect(formatGroup("2xCD, Comp")).toBe("CD");
    expect(formatGroup("Box Set, Vinyl")).toBe("Other");
  });

  it("wantlist imports create wants only — never owned holdings", () => {
    const env = setup();
    const copiesBefore = count(env, "SELECT COUNT(*) AS n FROM copies WHERE owner_id = ?", env.seed.users.mara);
    const wantsBefore = count(env, "SELECT COUNT(*) AS n FROM wants WHERE user_id = ?", env.seed.users.mara);
    const b = run(env, "discogs_wantlist", file("discogs/synthetic-wantlist.csv"));
    expect(b.counts).toMatchObject({ total: 4, new: 4, invalid: 0 });
    commit(env, b.id);
    expect(count(env, "SELECT COUNT(*) AS n FROM copies WHERE owner_id = ?", env.seed.users.mara)).toBe(copiesBefore);
    expect(count(env, "SELECT COUNT(*) AS n FROM digital_holdings WHERE owner_id = ?", env.seed.users.mara)).toBe(0);
    expect(count(env, "SELECT COUNT(*) AS n FROM wants WHERE user_id = ?", env.seed.users.mara)).toBe(wantsBefore + 4);
    // A collection import and a wantlist import are separate source libraries.
    expect(count(env, "SELECT COUNT(*) AS n FROM source_libraries WHERE owner_id = ? AND kind = 'discogs_wantlist'", env.seed.users.mara)).toBe(1);
    expect(discogsWantlistAdapter.parse("Artist,Title,Notes\nA,B,n\n").rows[0].target).toBe("want");
  });
});

describe("Discogs collection reconciliation", () => {
  it("exact re-import creates nothing and is recognised as identical", () => {
    const env = setup();
    const b1 = run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv"));
    expect(b1.counts).toMatchObject({ total: 8, new: 7, invalid: 1, ambiguous: 0 });
    commit(env, b1.id);
    const after1 = importedCopies(env) + importedDigital(env);
    expect(after1).toBe(7);
    const b2 = run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv"));
    expect(b2.identical_to_batch_id).toBe(b1.id);
    expect(b2.counts).toMatchObject({ new: 0, existing: 7, ambiguous: 0 });
    commit(env, b2.id);
    expect(importedCopies(env) + importedDigital(env)).toBe(after1);
  });

  it("keeps multiple physical copies of the same release", () => {
    const env = setup();
    commit(env, run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    expect(count(env, "SELECT COUNT(*) AS n FROM copies c JOIN source_entries se ON se.id = c.source_entry_id WHERE se.external_id = '9000101' AND c.owner_id = ?", env.seed.users.mara)).toBe(2);
  });

  it("reordered rows (different file, same content) match as existing", () => {
    const env = setup();
    commit(env, run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    const b = run(env, "discogs_collection", file("discogs/synthetic-collection-v1-reordered.csv"));
    expect(b.identical_to_batch_id).toBeNull();
    expect(b.counts).toMatchObject({ new: 0, existing: 7, invalid: 1, ambiguous: 0 });
  });

  it("changed exports: ambiguous rows block commit until decided; missing entries are kept", () => {
    const env = setup();
    commit(env, run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    const before = importedCopies(env);
    const b = run(env, "discogs_collection", file("discogs/synthetic-collection-v2-changed.csv"));
    expect(b.counts).toMatchObject({ new: 3, existing: 5, ambiguous: 1, missing_from_export: 1 });
    expect(() => commitImport(env.db, env.clock, env.seed.users.mara, b.id)).toThrow(/needs a decision/);
    const amb = env.db.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND classification = 'ambiguous'").get(b.id) as any;
    const candidate = JSON.parse(amb.candidate_entry_ids)[0];
    expect(() => decideRow(env.db, env.seed.users.mara, b.id, amb.id, { decision: "link", entryId: 999999 })).toThrow(/suggested matches/);
    decideRow(env.db, env.seed.users.mara, b.id, amb.id, { decision: "link", entryId: candidate });
    const done = commit(env, b.id);
    expect(done.report).toMatchObject({ created: 3, updated: 1, unchanged: 5, missing_from_export: 1 });
    expect(importedCopies(env)).toBe(before + 3);
    // Olvera (absent from v2) still exists.
    expect(count(env, "SELECT COUNT(*) AS n FROM copies WHERE owner_id = ? AND title_text = 'Olvera Tapes Vol. 1'", env.seed.users.mara)).toBe(1);
    // The linked copy got the new imported grade.
    expect((env.db.prepare("SELECT media_condition FROM copies WHERE source_entry_id = ?").get(candidate) as any).media_condition).toBe("VG+");
  });

  it("an ambiguous row resolved as 'create' adds a separate copy; 'skip' adds nothing", () => {
    const env = setup();
    commit(env, run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    const before = importedCopies(env);
    const b = run(env, "discogs_collection", file("discogs/synthetic-collection-v2-changed.csv"));
    expect(decideAllUndecided(env.db, env.seed.users.mara, b.id, "create")).toBe(1);
    commit(env, b.id);
    expect(importedCopies(env)).toBe(before + 4);
    const env2 = setup();
    commit(env2, run(env2, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    const b2 = run(env2, "discogs_collection", file("discogs/synthetic-collection-v2-changed.csv"));
    decideAllUndecided(env2.db, env2.seed.users.mara, b2.id, "skip");
    commit(env2, b2.id);
    expect(importedCopies(env2)).toBe(before + 3);
  });

  it("updates never overwrite private edits, tags or crate membership", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    commit(env, run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    const unit = env.db.prepare("SELECT id FROM copies WHERE owner_id = ? AND title_text = 'Unit Theory'").get(mara) as any;
    const c = getOwnCopy(env.db, mara, unit.id);
    updateCopy(env.db, env.clock, mara, unit.id, { ...c, media_condition: "G", tags: "peak-time, my-tag", private_notes: "MY PRIVATE NOTE", crate_id: "" });
    const crate = createCrate(env.db, env.clock, mara, "Keep");
    addToCrate(env.db, env.clock, mara, crate, [{ type: "physical", id: unit.id }]);
    const b = run(env, "discogs_collection", file("discogs/synthetic-collection-v2-changed.csv"));
    decideAllUndecided(env.db, mara, b.id, "link");
    const done = commit(env, b.id);
    expect(done.report.kept_user_edits).toBe(1);
    const after = getOwnCopy(env.db, mara, unit.id);
    expect(after.media_condition).toBe("G"); // user's grade kept, not the imported VG+
    expect(after.private_notes).toBe("MY PRIVATE NOTE");
    expect(after.tags).toEqual(["my-tag", "peak-time"]);
    expect(after.crates.map((x: any) => x.name)).toEqual(["Keep"]);
    // The new imported value is kept as source metadata, separately.
    expect(after.source.data.source.media).toBe("Very Good Plus (VG+)");
  });

  it("a stale preview is refused after another import of the same source", () => {
    const env = setup();
    const a = run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv"));
    const b = run(env, "discogs_collection", file("discogs/synthetic-collection-v1-reordered.csv"));
    commit(env, a.id);
    expect(() => commit(env, b.id)).toThrow(/fresh preview/);
    expect(importedCopies(env) + importedDigital(env)).toBe(7);
  });
});

describe("Rekordbox import", () => {
  it("refuses DOCTYPE/entity declarations (XXE) without resolving them, and reports malformed XML", () => {
    const env = setup();
    const x = run(env, "rekordbox", file("rekordbox/xxe.xml"));
    expect(x.status).toBe("failed");
    expect(x.error).toMatch(/DOCTYPE or ENTITY/);
    expect(count(env, "SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ?", x.id)).toBe(0);
    const bomb = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><DJ_PLAYLISTS><COLLECTION><TRACK TrackID="1" Name="&b;"/></COLLECTION></DJ_PLAYLISTS>';
    expect(() => rekordboxAdapter.parse(bomb)).toThrow(ImportFileError);
    const m = run(env, "rekordbox", file("rekordbox/malformed.xml"));
    expect(m.status).toBe("failed");
    expect(m.error).toMatch(/malformed near line 5/);
    expect(() => rekordboxAdapter.parse("<html></html>")).toThrow(/DJ_PLAYLISTS/);
  });

  it("imports tracks with BPM, key, rating, private paths and cues; keeps radio edit and extended mix distinct", () => {
    const p = rekordboxAdapter.parse(file("rekordbox/synthetic-library-v1.xml").toString("utf8"));
    expect(p.rows).toHaveLength(6);
    const t = p.rows[0].fields;
    expect(t).toMatchObject({ title_text: "Nightbus Dialogues", version_text: "Original Mix", bpm_x100: 12200, musical_key: "8A", rating: 5, file_format: "AIFF", sample_rate_hz: 44100, play_count: 14 });
    expect(t.file_location).toBe("/Users/sample/Music/Rips/Aurelia Kaan - Nightbus Dialogues.aiff");
    expect((p.rows[0].source as any).cues).toHaveLength(3);
    const mar = p.rows.filter((r) => r.fields.title_text === "Mar Aberto").map((r) => r.fields.version_text);
    expect(mar).toEqual(["Extended Mix", "Radio Edit"]);
    expect(p.rows[4].fields.genre_text).toBe("Balearic & Disco");
    expect(p.rows[3].fields.file_location).toBe("/Users/sample/Music/Store/夜明け.flac");
  });

  it("keeps nested playlists, including the same name under different parents, in order", () => {
    const env = setup();
    const b = run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml"));
    const done = commit(env, b.id);
    expect(done.report).toMatchObject({ playlists: 3, folders: 3, unresolved_track_refs: 1 });
    const paths = (env.db.prepare("SELECT path FROM current_source_playlists WHERE node_type = 'playlist' ORDER BY path").all() as any[]).map((r) => r.path);
    expect(paths).toEqual(["Gigs / 2025 / Warm-up", "Gigs / 2026 / Warm-up", "Peak time"]);
    const order = (env.db.prepare(
      `SELECT d.title_text, d.version_text FROM current_source_playlists sp JOIN source_playlist_items spi ON spi.playlist_id = sp.id
       JOIN digital_holdings d ON d.source_entry_id = spi.source_entry_id WHERE sp.path = 'Gigs / 2025 / Warm-up' ORDER BY spi.position`,
    ).all() as any[]).map((r) => `${r.title_text} (${r.version_text})`);
    expect(order).toEqual(["Mar Aberto (Extended Mix)", "Nightbus Dialogues (Original Mix)"]);
  });

  it("re-import: exact file is idempotent; changed export updates, flags a possible ID change, never deletes", () => {
    const env = setup();
    commit(env, run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml")).id);
    const again = run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml"));
    expect(again.counts).toMatchObject({ new: 0, existing: 6 });
    commit(env, again.id);
    expect(importedDigital(env)).toBe(6);
    const v2 = run(env, "rekordbox", file("rekordbox/synthetic-library-v2.xml"));
    expect(v2.counts).toMatchObject({ new: 1, existing: 3, changed: 1, ambiguous: 1, missing_from_export: 1 });
    const amb = env.db.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND classification = 'ambiguous'").get(v2.id) as any;
    expect(amb.external_id).toBe("204");
    decideAllUndecided(env.db, env.seed.users.mara, v2.id, "link");
    commit(env, v2.id);
    expect(importedDigital(env)).toBe(7); // 6 + one new; the renumbered track was linked, the missing one kept
    const theory = env.db.prepare("SELECT rating, bpm_x100, play_count FROM digital_holdings WHERE title_text = 'Theory One'").get() as any;
    expect(theory).toEqual({ rating: 5, bpm_x100: 13000, play_count: 41 });
    expect(count(env, "SELECT COUNT(*) AS n FROM digital_holdings WHERE title_text = 'Mar Aberto' AND version_text = 'Radio Edit'")).toBe(1);
  });

  it("TrackIDs are scoped to their source library", () => {
    const env = setup();
    commit(env, run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml"), "mara", "Laptop").id);
    const other = run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml"), "mara", "Studio");
    expect(other.counts).toMatchObject({ new: 6, existing: 0 });
  });

  it("imported edits to a user-edited digital track keep the user's values", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    commit(env, run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml")).id);
    const t = env.db.prepare("SELECT id FROM digital_holdings WHERE title_text = 'Theory One'").get() as any;
    const d = getOwnDigital(env.db, mara, t.id);
    updateDigital(env.db, env.clock, mara, t.id, { ...d, bpm: "131", tags: "", private_notes: "mine" });
    const v2 = run(env, "rekordbox", file("rekordbox/synthetic-library-v2.xml"));
    decideAllUndecided(env.db, mara, v2.id, "link");
    commit(env, v2.id);
    expect((env.db.prepare("SELECT bpm_x100, private_notes FROM digital_holdings WHERE id = ?").get(t.id) as any)).toEqual({ bpm_x100: 13100, private_notes: "mine" });
  });
});

describe("commit retry and undo", () => {
  it("a failure mid-commit rolls back the chunk; retry finishes without duplicates", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const b = run(env, "discogs_collection", discogsCollectionCsv(700));
    beginCommit(env.db, env.clock, mara, b.id);
    expect(commitNextChunk(env.db, env.clock, b.id, { chunkSize: 250 })).toBe(false); // rows 1–250 saved
    expect(() => commitNextChunk(env.db, env.clock, b.id, { chunkSize: 250, failAtRow: 400 })).toThrow(/retry safely/);
    const failed = getBatch(env.db, mara, b.id);
    expect(failed.status).toBe("failed");
    expect(failed.rows_applied).toBe(250);
    expect(importedCopies(env) + importedDigital(env)).toBe(250);
    const done = commitImport(env.db, env.clock, mara, b.id, { chunkSize: 250 });
    expect(done.status).toBe("committed");
    expect(importedCopies(env) + importedDigital(env)).toBe(700);
    expect(done.report.created).toBe(700);
  });

  it("undo removes created records but keeps ones the user edited or put in a crate, and restores updates", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const b1 = run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv"));
    commit(env, b1.id);
    const b2 = run(env, "discogs_collection", file("discogs/synthetic-collection-v2-changed.csv"));
    decideAllUndecided(env.db, mara, b2.id, "link");
    commit(env, b2.id);
    // The user organises one of the records created by b2.
    const warm = env.db.prepare("SELECT id FROM copies WHERE owner_id = ? AND title_text = 'Warm Up Tools Vol. 2'").get(mara) as any;
    const crate = createCrate(env.db, env.clock, mara, "Gig");
    addToCrate(env.db, env.clock, mara, crate, [{ type: "physical", id: warm.id }]);
    expect(() => undoImport(env.db, env.clock, mara, b1.id)).toThrow(/Undo that one first/);
    env.clock.advanceMinutes(1);
    const s = undoImport(env.db, env.clock, mara, b2.id);
    expect(s).toMatchObject({ removed: 2, kept_edited_or_used: 1, restored: 1 });
    expect(count(env, "SELECT COUNT(*) AS n FROM copies WHERE id = ?", warm.id)).toBe(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM crate_items WHERE crate_id = ?", crate)).toBe(1);
    // The update to Unit Theory's grade is reverted to the v1 value.
    expect((env.db.prepare("SELECT media_condition FROM copies WHERE owner_id = ? AND title_text = 'Unit Theory'").get(mara) as any).media_condition).toBe("NM");
    expect(getBatch(env.db, mara, b2.id).status).toBe("undone");
    // After undo, the earlier import can be undone too.
    env.clock.advanceMinutes(1);
    expect(undoImport(env.db, env.clock, mara, b1.id).removed).toBe(7);
  });
});

describe("authorization and privacy for imported data", () => {
  it("other users get 404 for every user-owned record and action", async () => {
    const env = setup();
    const b = run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml"));
    commit(env, b.id);
    const digital = (env.db.prepare("SELECT id FROM digital_holdings WHERE owner_id = ?").get(env.seed.users.mara) as any).id;
    const copy = (env.db.prepare("SELECT id FROM copies WHERE owner_id = ?").get(env.seed.users.mara) as any).id;
    const crate = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ?").get(env.seed.users.mara) as any).id;
    const pending = run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv"));
    const sol = await agentFor(env, "sol");
    for (const url of [`/imports/${b.id}`, `/imports/${pending.id}`, `/digital/${digital}`, `/digital/${digital}/edit`, `/copies/${copy}`, `/crates/${crate}`]) {
      expect((await sol.get(url)).status, url).toBe(404);
    }
    for (const [url, body] of [[`/imports/${pending.id}/commit`, {}], [`/imports/${pending.id}/discard`, {}], [`/imports/${b.id}/undo`, {}], [`/digital/${digital}/notes`, { private_notes: "x" }],
      [`/crates/${crate}/delete`, {}], [`/crates/${crate}/move`, { crate_item_id: "1", to: "up" }]] as [string, Record<string, string>][]) {
      expect((await sol.post(url, body)).status, url).toBe(404);
    }
    expect(getBatch(env.db, env.seed.users.mara, pending.id).status).toBe("previewed");
    expect(count(env, "SELECT COUNT(*) AS n FROM crates WHERE id = ?", crate)).toBe(1);
    // Sol can't add Mara's items to Sol's own crate either.
    const solCrate = createCrate(env.db, env.clock, env.seed.users.sol, "Sol crate");
    expect(addToCrate(env.db, env.clock, env.seed.users.sol, solCrate, [{ type: "digital", id: digital }])).toBe(0);
  });

  it("file paths, comments and imported notes never appear in public pages or APIs", async () => {
    const env = setup();
    commit(env, run(env, "rekordbox", file("rekordbox/synthetic-library-v1.xml")).id);
    commit(env, run(env, "discogs_collection", file("discogs/synthetic-collection-v1.csv")).id);
    const anon = await agentFor(env);
    const sol = await agentFor(env, "sol");
    for (const a of [anon, sol]) {
      for (const url of ["/discover", "/discover?q=Nightbus", "/api/search?q=Nightbus", `/releases/${env.seed.releases["Nightbus Dialogues"]}`, `/editions/${env.seed.editions["nb-orig"]}`, `/api/editions/${env.seed.editions["nb-orig"]}/offers`]) {
        const t = (await a.get(url)).text;
        for (const secret of ["/Users/sample", "Needle-dropped", "Bought at a record fair", "Box A", "Sunday brunch opener"]) expect(t, `${url} leaked ${secret}`).not.toContain(secret);
      }
    }
    // The owner does see them.
    const mara = await agentFor(env, "mara");
    const d = (env.db.prepare("SELECT id FROM digital_holdings WHERE title_text = 'Nightbus Dialogues' AND version_text = 'Original Mix'").get() as any).id;
    expect((await mara.get(`/digital/${d}`)).text).toContain("/Users/sample/Music/Rips");
  });

  it("imports through HTTP: upload → preview → commit → library shows the items", async () => {
    const env = setup();
    const mara = await agentFor(env, "mara");
    const token = /name="_csrf" value="([^"]+)"/.exec((await mara.get("/imports")).text)![1];
    const up = await mara.agent.post("/imports").field("_csrf", token).field("kind", "rekordbox").field("source_name", "")
      .attach("file", file("rekordbox/synthetic-library-v1.xml"), { filename: "rb.xml", contentType: "text/xml" });
    expect(up.status).toBe(303);
    const previewUrl = up.headers.location;
    const preview = await mara.get(previewUrl);
    expect(preview.text).toContain("need review");
    expect(importedDigital(env)).toBe(0); // nothing saved before confirming
    const id = previewUrl.split("/").pop();
    expect((await mara.post(`/imports/${id}/commit`)).status).toBe(303);
    expect(importedDigital(env)).toBe(6);
    const lib = await mara.get(`/library?batch=${id}&view=table`);
    expect(lib.text).toContain("Theory One");
    expect(lib.text).toContain("Extended Mix");
  });
});

describe("large synthetic import", () => {
  it("10,000 Discogs rows and 20,000 Rekordbox tracks import within bounds, and re-import is idempotent", () => {
    const env = setup();
    const t0 = Date.now();
    const csv = run(env, "discogs_collection", discogsCollectionCsv(10_000));
    expect(csv.counts).toMatchObject({ total: 10_000, new: 10_000, invalid: 0 });
    commit(env, csv.id);
    const t1 = Date.now();
    const xml = run(env, "rekordbox", rekordboxXml(20_000));
    expect(xml.counts).toMatchObject({ total: 20_000, new: 20_000, playlists: 50 });
    commit(env, xml.id);
    const t2 = Date.now();
    expect(importedCopies(env) + importedDigital(env)).toBe(30_000);
    const again = run(env, "discogs_collection", discogsCollectionCsv(10_000));
    expect(again.counts).toMatchObject({ new: 0, existing: 10_000 });
    console.log(`[perf] Discogs 10k preview+commit ${t1 - t0} ms; Rekordbox 20k preview+commit ${t2 - t1} ms`);
    expect(t1 - t0).toBeLessThan(30_000);
    expect(t2 - t1).toBeLessThan(60_000);
  }, 180_000);
});
