import { describe, expect, it } from "vitest";
import { agentFor, makeListing, setup } from "./helpers.js";
import { getPublicListing, offersForEdition } from "../src/domain/listings.js";
import { getOwnCopy, updateCopy } from "../src/domain/collection.js";
import { DomainError } from "../src/lib/errors.js";

const SECRETS = ["SECRET-NOTE-XYZ", "SECRET-SHELF-42", "SECRET-SOURCE", "SECRET-BPM", "secret-tag", "$7.77"];
const expectNoSecrets = (text: string) => {
  for (const s of SECRETS) expect(text, `leaked ${s}`).not.toContain(s);
};

describe("private copy fields stay private", () => {
  it("public listing serializer never includes private fields", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    const json = JSON.stringify(getPublicListing(env.db, listingId));
    expectNoSecrets(json);
    expect(json).not.toMatch(/acquisition|storage_location|private_notes|dj_bpm|crate/);
    expectNoSecrets(JSON.stringify(offersForEdition(env.db, env.seed.editions["nb-orig"], "US")));
  });

  it("public JSON API, offers page, listing page and search results don't leak them", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    const anon = await agentFor(env);
    const buyer = await agentFor(env, "mara");
    for (const a of [anon, buyer]) {
      for (const url of [`/api/listings/${listingId}`, `/api/editions/${env.seed.editions["nb-orig"]}/offers?dest=US`, `/editions/${env.seed.editions["nb-orig"]}/offers?dest=US`,
        `/listings/${listingId}`, `/editions/${env.seed.editions["nb-orig"]}`, "/?q=LLR-004", "/api/search?q=secret"]) {
        const r = await a.get(url);
        expect(r.status, url).toBe(200);
        expectNoSecrets(r.text);
      }
    }
  });

  it("the owner can see their private fields", async () => {
    const env = setup();
    const { copyId } = await makeListing(env, "sol");
    const seller = await agentFor(env, "sol");
    const r = await seller.get(`/copies/${copyId}`);
    expect(r.text).toContain("SECRET-NOTE-XYZ");
    expect(r.text).toContain("SECRET-SHELF-42");
  });

  it("another user gets 404 for someone else's copy page and its private photos", async () => {
    const env = setup();
    const { createCopy, addCopyPhoto } = await import("../src/domain/collection.js");
    const copyId = createCopy(env.db, env.clock, env.seed.users.sol, env.seed.editions.ut, { media_condition: "VG", sleeve_condition: "VG", private_notes: "SECRET-NOTE-XYZ" });
    const photoId = addCopyPhoto(env.db, env.clock, env.seed.users.sol, copyId, { placeholder_seed: "x" });
    const buyer = await agentFor(env, "mara");
    expect((await buyer.get(`/copies/${copyId}`)).status).toBe(404);
    expect((await buyer.get(`/copies/${copyId}/edit`)).status).toBe(404);
    // Photo of an unlisted copy is private…
    expect((await buyer.get(`/media/copy-photo/${photoId}`)).status).toBe(404);
    expect((await (await agentFor(env, "sol")).get(`/media/copy-photo/${photoId}`)).status).toBe(200);
  });

  it("a copy is not for sale until the owner lists it", async () => {
    const env = setup();
    const { createCopy } = await import("../src/domain/collection.js");
    const before = offersForEdition(env.db, env.seed.editions.ut, "DE").length;
    createCopy(env.db, env.clock, env.seed.users.dex, env.seed.editions.ut, { media_condition: "NM", sleeve_condition: "NM" });
    expect(offersForEdition(env.db, env.seed.editions.ut, "DE").length).toBe(before);
  });
});

describe("ownership is enforced server-side", () => {
  it("users cannot edit another user's copy (domain and HTTP)", async () => {
    const env = setup();
    const { copyId } = await makeListing(env, "sol");
    expect(() => updateCopy(env.db, env.clock, env.seed.users.mara, copyId, { media_condition: "P", sleeve_condition: "P" })).toThrow(/not found/i);
    const buyer = await agentFor(env, "mara");
    const r = await buyer.post(`/copies/${copyId}/edit`, { media_condition: "P", sleeve_condition: "P", private_notes: "hacked" });
    expect(r.status).toBe(404);
    const c = getOwnCopy(env.db, env.seed.users.sol, copyId);
    expect(c.media_condition).toBe("VG+");
    expect(c.private_notes).toBe("SECRET-NOTE-XYZ");
  });

  it("users cannot list, edit, publish or withdraw another user's copy or listing", async () => {
    const env = setup();
    const { copyId, listingId } = await makeListing(env, "sol");
    const buyer = await agentFor(env, "mara");
    const profile = (env.db.prepare("SELECT id FROM shipping_profiles WHERE seller_id = ?").get(env.seed.users.cato) as any).id;
    const cato = await agentFor(env, "cato");
    expect((await cato.post(`/copies/${copyId}/sell`, { price: "1.00", media_condition: "VG", sleeve_condition: "VG", condition_description: "not mine at all", shipping_profile_id: profile })).status).toBe(404);
    expect((await buyer.post(`/selling/listings/${listingId}/edit`, { price: "1.00", media_condition: "M", sleeve_condition: "M", condition_description: "changed by attacker", shipping_profile_id: "1" })).status).toBe(404);
    expect((await buyer.post(`/selling/listings/${listingId}/withdraw`)).status).toBe(404);
    expect((await buyer.get(`/selling/listings/${listingId}`)).status).toBe(404);
    const l = env.db.prepare("SELECT status, price_cents FROM listings WHERE id = ?").get(listingId) as any;
    expect(l).toEqual({ status: "available", price_cents: 3000 });
  });

  it("a seller can't reference another seller's shipping profile or another copy's photos", async () => {
    const env = setup();
    const { createCopy } = await import("../src/domain/collection.js");
    const { createDraftListing } = await import("../src/domain/listings.js");
    const other = await makeListing(env, "dex");
    const copyId = createCopy(env.db, env.clock, env.seed.users.sol, env.seed.editions.ut, { media_condition: "VG", sleeve_condition: "VG" });
    const base = { price: "10", media_condition: "VG", sleeve_condition: "VG", condition_description: "A fine copy indeed." };
    expect(() => createDraftListing(env.db, env.clock, env.seed.users.sol, copyId, { ...base, shipping_profile_id: String(env.seed.ship.dex) })).toThrow(DomainError);
    expect(() => createDraftListing(env.db, env.clock, env.seed.users.sol, copyId, { ...base, shipping_profile_id: String(env.seed.ship.sol), photo_ids: [String(other.photoId)] })).toThrow(/photo/);
  });

  it("orders are visible only to their buyer and seller", async () => {
    const env = setup();
    const orderId = (env.db.prepare("SELECT id FROM orders WHERE status = 'paid'").get() as any).id;
    expect((await (await agentFor(env, "mara")).get(`/orders/${orderId}`)).status).toBe(404);
    expect((await (await agentFor(env, "dex")).get(`/orders/${orderId}`)).status).toBe(200);
    expect((await (await agentFor(env, "mara")).post(`/orders/${orderId}/ship`, { carrier: "x" })).status).toBe(404);
  });

  it("state-changing requests without a CSRF token are rejected", async () => {
    const env = setup();
    const a = await agentFor(env, "mara");
    const r = await a.agent.post("/wants").type("form").send({ release_id: String(env.seed.releases["Vale"]) });
    expect(r.status).toBe(403);
  });

  it("anonymous users are sent to sign in", async () => {
    const env = setup();
    const a = await agentFor(env);
    const r = await a.get("/collection");
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/login\?return_to=/);
  });
});
