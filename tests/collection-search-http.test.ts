import { describe, expect, it } from "vitest";
import request from "supertest";
import { agentFor, setup } from "./helpers.js";
import { applyBulkAction, listCopies, matchingCopyIds, parseCollectionFilters, resolveBulkScope } from "../src/domain/collection.js";
import { searchReleases, type SearchParams } from "../src/domain/catalog.js";

const tagCount = (env: ReturnType<typeof setup>, owner: string, tag: string) =>
  (env.db.prepare("SELECT COUNT(*) AS n FROM copy_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.owner_id = ? AND t.name = ?").get(env.seed.users[owner], tag) as any).n;

describe("bulk selection respects the selected scope", () => {
  it("selected, page and all-matching scopes resolve to exactly the right copies", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const all = parseCollectionFilters({});
    const total = matchingCopyIds(env.db, mara, all).length;
    const page1 = listCopies(env.db, mara, all, 1).rows.map((r) => r.id);
    expect(total).toBeGreaterThan(page1.length); // collection spans more than one page
    expect(resolveBulkScope(env.db, mara, { scope: "selected", selectedIds: page1.slice(0, 2), pageIds: page1, filters: all })).toEqual(page1.slice(0, 2).sort((a, b) => a - b));
    expect(resolveBulkScope(env.db, mara, { scope: "page", selectedIds: [], pageIds: page1, filters: all })).toHaveLength(page1.length);
    expect(resolveBulkScope(env.db, mara, { scope: "all_matching", selectedIds: [], pageIds: page1, filters: all })).toHaveLength(total);
    // All-matching honours filters, not the whole collection.
    const peak = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = 'Peak time'").get(mara) as any).id;
    const inPeak = resolveBulkScope(env.db, mara, { scope: "all_matching", selectedIds: [], pageIds: [], filters: parseCollectionFilters({ crate: String(peak) }) });
    const expectedPeak = (env.db.prepare("SELECT COUNT(*) AS n FROM copies WHERE owner_id = ? AND crate_id = ?").get(mara, peak) as any).n;
    expect(inPeak).toHaveLength(expectedPeak);
    expect(expectedPeak).toBeLessThan(total);
  });

  it("IDs belonging to other users are dropped from every scope", () => {
    const env = setup();
    const solCopy = (env.db.prepare("SELECT id FROM copies WHERE owner_id = ?").get(env.seed.users.sol) as any).id;
    const maraCopy = (env.db.prepare("SELECT id FROM copies WHERE owner_id = ?").get(env.seed.users.mara) as any).id;
    const ids = resolveBulkScope(env.db, env.seed.users.mara, { scope: "selected", selectedIds: [solCopy, maraCopy], pageIds: [], filters: parseCollectionFilters({}) });
    expect(ids).toEqual([maraCopy]);
    expect(applyBulkAction(env.db, env.clock, env.seed.users.mara, [solCopy], { kind: "add_tag", tag: "stolen" })).toBe(0);
    expect(tagCount(env, "sol", "stolen") + tagCount(env, "mara", "stolen")).toBe(0);
  });

  it("HTTP flow: preview shows scope and count; apply changes exactly those copies", async () => {
    const env = setup();
    const mara = await agentFor(env, "mara");
    const page1 = listCopies(env.db, env.seed.users.mara, parseCollectionFilters({}), 1).rows.map((r) => r.id);
    const total = matchingCopyIds(env.db, env.seed.users.mara, parseCollectionFilters({})).length;

    const preview = await mara.post("/collection/bulk/preview", { scope: "page", page_ids: page1, ids: [page1[0]], action: "add_tag", tag: "Bulk Test" });
    expect(preview.status).toBe(200);
    expect(preview.text).toContain(`the ${page1.length} copies on the page`);
    expect(preview.text).toContain(`Apply to ${page1.length} copies`);
    const ids = [...preview.text.matchAll(/name="ids" value="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids.sort((a, b) => a - b)).toEqual([...page1].sort((a, b) => a - b));
    const applied = await mara.post("/collection/bulk/apply", { ids, expected_count: ids.length, action: "add_tag", tag: "bulk-test" });
    expect(applied.status).toBe(303);
    expect(tagCount(env, "mara", "bulk-test")).toBe(page1.length);
    expect(tagCount(env, "mara", "bulk-test")).toBeLessThan(total);

    // Selected scope with nothing ticked is refused rather than silently widening.
    const none = await mara.post("/collection/bulk/preview", { scope: "selected", page_ids: page1, action: "add_tag", tag: "x" });
    expect(none.status).toBe(303);
    // A stale count (collection changed since preview) applies nothing.
    const stale = await mara.post("/collection/bulk/apply", { ids, expected_count: ids.length + 1, action: "add_tag", tag: "stale-tag" });
    expect(stale.status).toBe(303);
    expect(tagCount(env, "mara", "stale-tag")).toBe(0);
  });

  it("moving copies between crates only moves the chosen scope", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const sunday = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = 'Sunday closing'").get(mara) as any).id;
    const warm = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = 'Warm-up'").get(mara) as any).id;
    const inWarm = matchingCopyIds(env.db, mara, parseCollectionFilters({ crate: String(warm) }));
    const moved = applyBulkAction(env.db, env.clock, mara, inWarm, { kind: "move_crate", crateId: sunday });
    expect(moved).toBe(inWarm.length);
    expect(matchingCopyIds(env.db, mara, parseCollectionFilters({ crate: String(warm) }))).toHaveLength(0);
    // Another user's crate is not a valid destination.
    const other = (env.db.prepare("INSERT INTO crates (owner_id, name, created_at) VALUES (?, 'x', 'now')").run(env.seed.users.sol)).lastInsertRowid;
    expect(() => applyBulkAction(env.db, env.clock, mara, inWarm, { kind: "move_crate", crateId: Number(other) })).toThrow();
  });
});

describe("search", () => {
  const base: SearchParams = { q: "", terms: [], termMode: "any", formats: [], countries: [], yearFrom: null, yearTo: null, forSale: false, sort: "relevance", page: 1, pageSize: 50 };
  const titles = (env: ReturnType<typeof setup>, p: Partial<SearchParams>) => searchReleases(env.db, { ...base, ...p }).results.map((r) => r.title).sort();

  it("matches artist, title, label and catalog number (ignoring punctuation)", () => {
    const env = setup();
    expect(titles(env, { q: "kaan" })).toEqual(["Deep Weather", "Nightbus Dialogues"]);
    expect(titles(env, { q: "salt garden" })).toEqual(["Salt Garden"]);
    expect(titles(env, { q: "Basement Signal" })).toEqual(["Relay / Return", "Unit Theory"]);
    expect(titles(env, { q: "llr004" })).toEqual(["Nightbus Dialogues"]);
    expect(titles(env, { q: "LLR 04" })).toContain("Tidal Rooms");
  });

  it("'any' and 'all' genre/style matching behave differently", () => {
    const env = setup();
    const any = titles(env, { terms: ["Ambient", "Deep House"], termMode: "any" });
    const all = titles(env, { terms: ["Ambient", "Deep House"], termMode: "all" });
    expect(all).toEqual(["Deep Weather"]);
    expect(any.length).toBeGreaterThan(all.length);
    expect(any).toContain("Soft Machines at Dawn");
  });

  it("format, country, year and for-sale filters combine with AND", () => {
    const env = setup();
    expect(titles(env, { formats: ["Cassette"] })).toEqual(["Olvera Tapes Vol. 1"]);
    expect(titles(env, { countries: ["NL"], yearFrom: 1999 })).toEqual(["Assembly Hall"]);
    const forSale = searchReleases(env.db, { ...base, forSale: true }).results;
    expect(forSale.every((r) => r.for_sale_count > 0)).toBe(true);
    expect(forSale.map((r) => r.title)).not.toContain("Olvera Tapes Vol. 1");
    expect(titles(env, { q: "nothing-matches-this" })).toEqual([]);
  });
});

describe("HTTP pages and dev-only switcher", () => {
  it("key pages render for anonymous visitors and signed-in users", async () => {
    const env = setup();
    const anon = await agentFor(env);
    for (const url of ["/", "/?view=list&q=LLR", "/?term=Techno&term=Ambient&mode=all", `/releases/${env.seed.releases["Nightbus Dialogues"]}`,
      `/editions/${env.seed.editions["nb-orig"]}`, `/compare?ids=${env.seed.editions["nb-orig"]}&ids=${env.seed.editions["nb-repress"]}`,
      `/editions/${env.seed.editions["nb-orig"]}/offers?dest=US`, "/login", `/media/archive/1`]) {
      expect((await anon.get(url)).status, url).toBe(200);
    }
    const mara = await agentFor(env, "mara");
    for (const url of ["/collection", "/collection?page=2", "/wants", "/cart", "/orders", "/orders?role=seller", "/selling", `/collection/add?edition_id=${env.seed.editions.va}`]) {
      expect((await mara.get(url)).status, url).toBe(200);
    }
    const moss = await agentFor(env, "moss");
    expect((await moss.get("/moderate")).status).toBe(200);
  });

  it("compare highlights differing fields", async () => {
    const env = setup();
    const r = await (await agentFor(env)).get(`/compare?ids=${env.seed.editions["nb-orig"]}&ids=${env.seed.editions["nb-repress"]}`);
    expect(r.text).toMatch(/<td class="differs">LLR-004<\/td>/);
    expect(r.text).toContain("Vauxhall Hum (Edit)");
    expect((await (await agentFor(env)).get(`/compare?ids=${env.seed.editions["nb-orig"]}`)).status).toBe(422);
  });

  it("validation errors re-render the form with messages and status 422", async () => {
    const env = setup();
    const mara = await agentFor(env, "mara");
    const r = await mara.post("/collection/add", { edition_id: env.seed.editions.va, media_condition: "", sleeve_condition: "BAD", acquisition_cost: "12.345", acquired_on: "yesterday" });
    expect(r.status).toBe(422);
    expect(r.text).toContain("Choose a media condition.");
    expect(r.text).toContain("Acquisition cost must be an amount");
    expect(r.text).toContain("Use a date like");
  });

  it("the demo switcher works in development and does not exist in production", async () => {
    const dev = setup();
    const a = await agentFor(dev);
    const token = /name="_csrf" value="([^"]+)"/.exec((await a.get("/")).text)![1];
    const sw = await a.agent.post("/dev/switch-user").type("form").send({ _csrf: token, user_id: String(dev.seed.users.moss) });
    expect(sw.status).toBe(303);
    expect((await a.get("/moderate")).status).toBe(200);

    const prod = setup({ NODE_ENV: "production", DEMO_SWITCHER: "true" });
    expect(prod.config.demoSwitcher).toBe(false);
    const p = await agentFor(prod);
    const page = (await p.get("/")).text;
    expect(page).not.toContain("switch demo account");
    const ptoken = /name="_csrf" value="([^"]+)"/.exec((await p.get("/login")).text)![1];
    const psw = await p.agent.post("/dev/switch-user").type("form").send({ _csrf: ptoken, user_id: String(prod.seed.users.moss) });
    expect(psw.status).toBe(404);
    expect((await p.get("/moderate")).status).toBe(302); // still anonymous
    // Login page doesn't advertise demo accounts in production.
    expect((await request(prod.app).get("/login")).text).not.toContain("demo-password");
  });

  it("uploads reject non-images (e.g. SVG or HTML disguised as PNG)", async () => {
    const env = setup();
    const mara = await agentFor(env, "mara");
    const copy = (env.db.prepare("SELECT id FROM copies WHERE owner_id = ?").get(env.seed.users.mara) as any).id;
    const token = /name="_csrf" value="([^"]+)"/.exec((await mara.get(`/copies/${copy}`)).text)![1];
    const bad = await mara.agent.post(`/copies/${copy}/photos`).field("_csrf", token).attach("images", Buffer.from("<svg onload=alert(1)>"), { filename: "x.png", contentType: "image/png" });
    expect(bad.status).toBe(303);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM copy_photos WHERE copy_id = ?").get(copy) as any).n).toBe(0);
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const ok = await mara.agent.post(`/copies/${copy}/photos`).field("_csrf", token).attach("images", png, { filename: "ok.png", contentType: "image/png" });
    expect(ok.status).toBe(303);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM copy_photos WHERE copy_id = ?").get(copy) as any).n).toBe(1);
  });
});
