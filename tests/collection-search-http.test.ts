import { describe, expect, it } from "vitest";
import request from "supertest";
import { agentFor, setup } from "./helpers.js";
import { applyBulkAction, listLibrary, matchingRefs, parseLibraryFilters, refKey, resolveBulkScope, type ItemRef } from "../src/domain/library.js";
import { searchReleases, type SearchParams } from "../src/domain/catalog.js";

const tagCount = (env: ReturnType<typeof setup>, owner: string, tag: string) =>
  (env.db.prepare(
    `SELECT (SELECT COUNT(*) FROM copy_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.owner_id = ? AND t.name = ?)
          + (SELECT COUNT(*) FROM digital_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.owner_id = ? AND t.name = ?) AS n`,
  ).get(env.seed.users[owner], tag, env.seed.users[owner], tag) as any).n;

const noFilters = () => parseLibraryFilters({});
const pageRefs = (env: ReturnType<typeof setup>, owner: string, f = noFilters(), pageSize = 20) =>
  listLibrary(env.db, env.seed.users[owner], f, "artist", "asc", 1, pageSize).rows.map((r: any) => ({ type: r.item_type, id: r.item_id } as ItemRef));

describe("bulk selection respects the selected scope", () => {
  it("selected, page and all-matching scopes resolve to exactly the right items", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const total = matchingRefs(env.db, mara, noFilters()).length;
    const page1 = pageRefs(env, "mara");
    expect(total).toBeGreaterThan(page1.length); // library spans more than one page
    expect(resolveBulkScope(env.db, mara, { scope: "selected", selected: page1.slice(0, 2), page: page1, filters: noFilters() })).toEqual(page1.slice(0, 2));
    expect(resolveBulkScope(env.db, mara, { scope: "page", selected: [], page: page1, filters: noFilters() })).toHaveLength(page1.length);
    expect(resolveBulkScope(env.db, mara, { scope: "all_matching", selected: [], page: page1, filters: noFilters() })).toHaveLength(total);
    // All-matching honours filters, not the whole library.
    const peak = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = 'Peak time'").get(mara) as any).id;
    const inPeak = resolveBulkScope(env.db, mara, { scope: "all_matching", selected: [], page: [], filters: parseLibraryFilters({ crate: String(peak) }) });
    const expectedPeak = (env.db.prepare("SELECT COUNT(*) AS n FROM crate_items WHERE crate_id = ?").get(peak) as any).n;
    expect(inPeak).toHaveLength(expectedPeak);
    expect(expectedPeak).toBeLessThan(total);
  });

  it("IDs belonging to other users are dropped from every scope", () => {
    const env = setup();
    const solCopy = (env.db.prepare("SELECT id FROM copies WHERE owner_id = ?").get(env.seed.users.sol) as any).id;
    const maraCopy = (env.db.prepare("SELECT id FROM copies WHERE owner_id = ?").get(env.seed.users.mara) as any).id;
    const refs: ItemRef[] = [{ type: "physical", id: solCopy }, { type: "physical", id: maraCopy }];
    expect(resolveBulkScope(env.db, env.seed.users.mara, { scope: "selected", selected: refs, page: [], filters: noFilters() })).toEqual([{ type: "physical", id: maraCopy }]);
    expect(resolveBulkScope(env.db, env.seed.users.mara, { scope: "page", selected: [], page: refs, filters: noFilters() })).toEqual([{ type: "physical", id: maraCopy }]);
    expect(applyBulkAction(env.db, env.clock, env.seed.users.mara, [{ type: "physical", id: solCopy }], { kind: "add_tag", tag: "stolen" })).toBe(0);
    expect(tagCount(env, "sol", "stolen") + tagCount(env, "mara", "stolen")).toBe(0);
  });

  it("HTTP flow: preview shows scope and count; apply changes exactly those items", async () => {
    const env = setup();
    const mara = await agentFor(env, "mara");
    const page1 = pageRefs(env, "mara", noFilters(), 48); // the grid shows 48 per page
    const total = matchingRefs(env.db, env.seed.users.mara, noFilters()).length;
    const page1Keys = page1.map(refKey);
    const preview = await mara.post("/library/bulk/preview", { scope: "page", page_refs: page1Keys, refs: [page1Keys[0]], action: "add_tag", tag: "Bulk Test" });
    expect(preview.status).toBe(200);
    expect(preview.text).toContain(`the ${page1.length} items on the page`);
    expect(preview.text).toContain(`Apply to ${page1.length} items`);
    const refs = [...preview.text.matchAll(/name="refs" value="([pd]:\d+)"/g)].map((m) => m[1]);
    expect([...refs].sort()).toEqual([...page1Keys].sort());
    const applied = await mara.post("/library/bulk/apply", { refs, expected_count: refs.length, action: "add_tag", tag: "bulk-test" });
    expect(applied.status).toBe(303);
    expect(tagCount(env, "mara", "bulk-test")).toBe(page1.length);
    expect(tagCount(env, "mara", "bulk-test")).toBeLessThanOrEqual(total);

    // Selected scope with nothing ticked is refused rather than silently widening.
    const none = await mara.post("/library/bulk/preview", { scope: "selected", page_refs: page1Keys, action: "add_tag", tag: "x" });
    expect(none.status).toBe(303);
    expect(tagCount(env, "mara", "x")).toBe(0);
    // A stale count (library changed since preview) applies nothing.
    const stale = await mara.post("/library/bulk/apply", { refs, expected_count: refs.length + 1, action: "add_tag", tag: "stale-tag" });
    expect(stale.status).toBe(303);
    expect(tagCount(env, "mara", "stale-tag")).toBe(0);
  });

  it("adding to and removing from a crate only touches the chosen scope; items stay in the library", () => {
    const env = setup();
    const mara = env.seed.users.mara;
    const sunday = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = 'Sunday closing'").get(mara) as any).id;
    const warm = (env.db.prepare("SELECT id FROM crates WHERE owner_id = ? AND name = 'Warm-up'").get(mara) as any).id;
    const inWarm = matchingRefs(env.db, mara, parseLibraryFilters({ crate: String(warm) }));
    const sundayBefore = matchingRefs(env.db, mara, parseLibraryFilters({ crate: String(sunday) })).length;
    const added = applyBulkAction(env.db, env.clock, mara, inWarm, { kind: "add_to_crate", crateId: sunday });
    expect(added).toBe(inWarm.length);
    expect(matchingRefs(env.db, mara, parseLibraryFilters({ crate: String(sunday) }))).toHaveLength(sundayBefore + inWarm.length);
    // Multi-membership: the items are still in Warm-up too.
    expect(matchingRefs(env.db, mara, parseLibraryFilters({ crate: String(warm) }))).toHaveLength(inWarm.length);
    const before = matchingRefs(env.db, mara, noFilters()).length;
    applyBulkAction(env.db, env.clock, mara, inWarm, { kind: "remove_from_crate", crateId: warm });
    expect(matchingRefs(env.db, mara, parseLibraryFilters({ crate: String(warm) }))).toHaveLength(0);
    expect(matchingRefs(env.db, mara, noFilters())).toHaveLength(before);
    // Another user's crate is not a valid destination.
    const other = env.db.prepare("INSERT INTO crates (owner_id, name, created_at) VALUES (?, 'x', 'now')").run(env.seed.users.sol).lastInsertRowid;
    expect(() => applyBulkAction(env.db, env.clock, mara, inWarm, { kind: "add_to_crate", crateId: Number(other) })).toThrow();
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
    for (const url of ["/discover", "/discover?view=list&q=LLR", "/discover?term=Techno&term=Ambient&mode=all", `/releases/${env.seed.releases["Nightbus Dialogues"]}`,
      `/editions/${env.seed.editions["nb-orig"]}`, `/compare?ids=${env.seed.editions["nb-orig"]}&ids=${env.seed.editions["nb-repress"]}`,
      `/editions/${env.seed.editions["nb-orig"]}/offers?dest=US`, "/login", `/media/archive/1`]) {
      expect((await anon.get(url)).status, url).toBe(200);
    }
    const mara = await agentFor(env, "mara");
    for (const url of ["/library", "/library?page=2", "/library?view=table&group=format", "/library?group=folder", "/crates", "/charts", "/imports", "/copies/new", "/digital/new", "/wants", "/cart", "/orders", "/orders?role=seller", "/selling", `/collection/add?edition_id=${env.seed.editions.va}`]) {
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
    const token = /name="_csrf" value="([^"]+)"/.exec((await a.get("/login")).text)![1];
    const sw = await a.agent.post("/dev/switch-user").type("form").send({ _csrf: token, user_id: String(dev.seed.users.moss) });
    expect(sw.status).toBe(303);
    expect((await a.get("/moderate")).status).toBe(200);

    const prod = setup({ NODE_ENV: "production", DEMO_SWITCHER: "true" });
    expect(prod.config.demoSwitcher).toBe(false);
    const p = await agentFor(prod);
    const page = (await p.get("/discover")).text;
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
