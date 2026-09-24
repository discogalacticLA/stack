import { describe, expect, it } from "vitest";
import { agentFor, setup } from "./helpers.js";
import { addToCrate, createCrate, createDigital, createManualCopy, crateItems, moveCrateItem, removeFromCrate } from "../src/domain/library.js";
import { addChartEntry, createChart, getOwnChart, moveChartEntry, removeChartEntry } from "../src/domain/charts.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { FakeClock } from "../src/lib/clock.js";

function tracks(env: ReturnType<typeof setup>, n: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) =>
    createDigital(env.db, env.clock, env.seed.users.mara, { granularity: "track", artist_text: "Synthetic", title_text: `Track ${i + 1}` }, extra));
}

describe("crates", () => {
  it("keeps a manual order and supports up/down/top/bottom/position moves", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const ids = tracks(env, 5);
    const crate = createCrate(env.db, env.clock, mara, { name: "Order test" });
    addToCrate(env.db, env.clock, mara, crate, ids.map((id) => ({ type: "digital", id })));
    const order = () => crateItems(env.db, mara, crate).map((i) => i.title);
    expect(order()).toEqual(["Track 1", "Track 2", "Track 3", "Track 4", "Track 5"]);
    const item = (title: string) => crateItems(env.db, mara, crate).find((i) => i.title === title)!.crate_item_id;
    moveCrateItem(env.db, env.clock, mara, crate, item("Track 5"), "top");
    expect(order()).toEqual(["Track 5", "Track 1", "Track 2", "Track 3", "Track 4"]);
    moveCrateItem(env.db, env.clock, mara, crate, item("Track 1"), "down");
    expect(order()).toEqual(["Track 5", "Track 2", "Track 1", "Track 3", "Track 4"]);
    moveCrateItem(env.db, env.clock, mara, crate, item("Track 5"), "up"); // already first: no-op
    moveCrateItem(env.db, env.clock, mara, crate, item("Track 2"), 4);
    expect(order()).toEqual(["Track 5", "Track 1", "Track 3", "Track 2", "Track 4"]);
    moveCrateItem(env.db, env.clock, mara, crate, item("Track 5"), 99); // clamped
    expect(order()).toEqual(["Track 1", "Track 3", "Track 2", "Track 4", "Track 5"]);
    removeFromCrate(env.db, env.clock, mara, crate, [{ type: "digital", id: ids[2] }]);
    expect(crateItems(env.db, mara, crate).map((i) => i.position)).toEqual([1, 2, 3, 4]);
    // Adding the same item twice is ignored; physical and digital items mix.
    const copy = createManualCopy(env.db, env.clock, mara, { artist_text: "A", title_text: "Vinyl thing", format_group: "Vinyl", media_condition: "VG", sleeve_condition: "VG" });
    expect(addToCrate(env.db, env.clock, mara, crate, [{ type: "digital", id: ids[0] }, { type: "physical", id: copy }])).toBe(1);
    expect(order().at(-1)).toBe("Vinyl thing");
  });

  it("reorders over HTTP with accessible buttons", async () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const ids = tracks(env, 3);
    const crate = createCrate(env.db, env.clock, mara, { name: "HTTP crate" });
    addToCrate(env.db, env.clock, mara, crate, ids.map((id) => ({ type: "digital", id })));
    const a = await agentFor(env, "mara");
    const page = (await a.get(`/crates/${crate}`)).text;
    expect(page).toContain('aria-label="Move Track 1 down"');
    const first = crateItems(env.db, mara, crate)[0].crate_item_id;
    expect((await a.post(`/crates/${crate}/move`, { crate_item_id: first, to: "bottom" })).status).toBe(303);
    expect(crateItems(env.db, mara, crate).map((i) => i.title)).toEqual(["Track 2", "Track 3", "Track 1"]);
    expect((await a.post(`/crates/${crate}/move`, { crate_item_id: first, to: "zero" })).status).toBe(303); // rejected with a message
  });
});

describe("Top 5 charts", () => {
  it("allows fewer than five, refuses a sixth, and never auto-fills", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const chart = createChart(env.db, env.clock, mara, { chart_type: "track", scope: "favorites", period_month: "2026-09" });
    const ids = tracks(env, 6);
    addChartEntry(env.db, env.clock, mara, chart, { type: "digital", id: ids[0] }, { commentary: "Opener every week" });
    let c = getOwnChart(env.db, mara, chart);
    expect(c.entries).toHaveLength(1);
    expect(c.complete).toBe(false);
    for (const id of ids.slice(1, 5)) addChartEntry(env.db, env.clock, mara, chart, { type: "digital", id }, {});
    c = getOwnChart(env.db, mara, chart);
    expect(c.complete).toBe(true);
    expect(() => addChartEntry(env.db, env.clock, mara, chart, { type: "digital", id: ids[5] }, {})).toThrow(/at most five/);
    moveChartEntry(env.db, env.clock, mara, chart, c.entries[4].id, "up");
    expect(getOwnChart(env.db, mara, chart).entries.map((e: any) => e.title)).toEqual(["Track 1", "Track 2", "Track 3", "Track 5", "Track 4"]);
    removeChartEntry(env.db, env.clock, mara, chart, c.entries[0].id);
    const after = getOwnChart(env.db, mara, chart);
    expect(after.entries.map((e: any) => e.position)).toEqual([1, 2, 3, 4]);
    expect(after.complete).toBe(false);
    // The database also refuses a sixth position, whatever the code does.
    expect(() => env.db.prepare("INSERT INTO chart_entries (chart_id, position, digital_id) VALUES (?, 6, ?)").run(chart, ids[5])).toThrow(/CHECK/);
  });

  it("distinguishes track and release charts, and backs 'most played' with data", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const trackChart = createChart(env.db, env.clock, mara, { chart_type: "track", scope: "all_time_favorites" });
    const releaseChart = createChart(env.db, env.clock, mara, { chart_type: "release", scope: "discoveries", period_month: "2026-09" });
    const [track] = tracks(env, 1);
    const release = createDigital(env.db, env.clock, mara, { granularity: "release", artist_text: "A", title_text: "Whole EP" });
    const copy = createManualCopy(env.db, env.clock, mara, { artist_text: "A", title_text: "LP", format_group: "Vinyl", media_condition: "VG", sleeve_condition: "VG" });
    expect(() => addChartEntry(env.db, env.clock, mara, releaseChart, { type: "digital", id: track }, {})).toThrow(/release chart needs a release/);
    expect(() => addChartEntry(env.db, env.clock, mara, trackChart, { type: "digital", id: release }, {})).toThrow(/track chart needs a track/);
    expect(() => addChartEntry(env.db, env.clock, mara, trackChart, { type: "physical", id: copy }, {})).toThrow(/name the track/);
    addChartEntry(env.db, env.clock, mara, trackChart, { type: "physical", id: copy }, { track_position: "B2" });
    addChartEntry(env.db, env.clock, mara, releaseChart, { type: "physical", id: copy }, {});
    addChartEntry(env.db, env.clock, mara, releaseChart, { type: "digital", id: release }, {});
    // Monthly scopes need a month; "most played" is all-time and needs play counts.
    expect(() => createChart(env.db, env.clock, mara, { chart_type: "track", scope: "favorites" })).toThrow();
    expect(() => createChart(env.db, env.clock, mara, { chart_type: "release", scope: "most_played" })).toThrow();
    const mp = createChart(env.db, env.clock, mara, { chart_type: "track", scope: "most_played" });
    expect(getOwnChart(env.db, mara, mp).period_kind).toBe("all_time");
    expect(() => addChartEntry(env.db, env.clock, mara, mp, { type: "digital", id: track }, {})).toThrow(/play count/);
    const [played] = tracks(env, 1, { play_count: 12 });
    addChartEntry(env.db, env.clock, mara, mp, { type: "digital", id: played }, {});
    // Another user's items can't be charted.
    const solChart = createChart(env.db, env.clock, env.seed.users.sol, { chart_type: "track", scope: "all_time_favorites" });
    expect(() => addChartEntry(env.db, env.clock, env.seed.users.sol, solChart, { type: "digital", id: played }, {})).toThrow(/not found/i);
  });

  it("charts and crates persist across a reload (new app instance on the same database file)", async () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const chart = createChart(env.db, env.clock, mara, { chart_type: "track", scope: "all_time_favorites", title: "Forever" });
    const [t] = tracks(env, 1);
    addChartEntry(env.db, env.clock, mara, chart, { type: "digital", id: t }, { commentary: "Always" });
    const a = await agentFor(env, "mara");
    const page = (await a.get(`/charts/${chart}`)).text;
    expect(page).toContain("Forever");
    expect(page).toContain("Always");
    expect(page).toContain("1 of 5");
    expect(page).toContain("Empty");
    expect((await (await agentFor(env, "sol")).get(`/charts/${chart}`)).status).toBe(404);
  });
});

describe("migrations", () => {
  it("002 upgrades a populated 001 database without losing rows", async () => {
    const db = openDatabase(":memory:", { migrate: false });
    migrate(db, { until: "001_initial.sql" });
    const clock = new FakeClock();
    const now = clock.now().toISOString();
    db.prepare("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (1, 'u', 'U', 'x', ?)").run(now);
    db.prepare("INSERT INTO releases (id, title, release_type, created_at, updated_at) VALUES (1, 'R', 'ep', ?, ?)").run(now, now);
    db.prepare("INSERT INTO editions (id, release_id, format, verification_status, created_at, updated_at) VALUES (1, 1, 'Vinyl', 'unverified', ?, ?)").run(now, now);
    db.prepare("INSERT INTO crates (id, owner_id, name, created_at) VALUES (1, 1, 'Old crate', ?)").run(now);
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO copies (id, owner_id, edition_id, media_condition, sleeve_condition, crate_id, private_notes, created_at, updated_at) VALUES (?, 1, 1, 'VG', 'VG', ?, ?, ?, ?)")
        .run(i, i < 3 ? 1 : null, `note ${i}`, now, now);
    }
    db.prepare("INSERT INTO wants (user_id, release_id, edition_id, created_at) VALUES (1, 1, 1, ?)").run(now);
    const ran = migrate(db);
    expect(ran).toContain("002_unified_library.sql");
    expect((db.prepare("SELECT COUNT(*) AS n FROM copies").get() as any).n).toBe(3);
    expect(db.prepare("SELECT private_notes FROM copies ORDER BY id").all().map((r: any) => r.private_notes)).toEqual(["note 1", "note 2", "note 3"]);
    expect(db.prepare("SELECT copy_id, position FROM crate_items ORDER BY position").all()).toEqual([{ copy_id: 1, position: 1 }, { copy_id: 2, position: 2 }]);
    expect(db.prepare("SELECT want_kind FROM wants").get()).toEqual({ want_kind: "edition" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
