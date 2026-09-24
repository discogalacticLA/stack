import { describe, expect, it } from "vitest";
import { address, agentFor, makeListing, setup } from "./helpers.js";
import { addToCart, checkout, expireReservations, getCart, TRANSITIONS, transitionOrder } from "../src/domain/orders.js";
import { createDraftListing, updateListing, withdrawListing } from "../src/domain/listings.js";
import { acceptProposal, editionAsPayload, submitProposal } from "../src/domain/proposals.js";
import { DomainError } from "../src/lib/errors.js";
import { formatMoney, parseMoneyToCents, sumCents } from "../src/lib/money.js";
import { quoteShipping } from "../src/lib/shipping.js";

const listingStatus = (env: ReturnType<typeof setup>, id: number) => (env.db.prepare("SELECT status FROM listings WHERE id = ?").get(id) as any).status;
const orderCount = (env: ReturnType<typeof setup>) => (env.db.prepare("SELECT COUNT(*) AS n FROM orders").get() as any).n;

describe("one active listing per copy", () => {
  it("rejects a second listing for the same copy, in the domain and in the database", async () => {
    const env = setup();
    const { copyId } = await makeListing(env, "sol");
    const input = { price: "20", media_condition: "VG", sleeve_condition: "VG", condition_description: "Second attempt listing.", shipping_profile_id: String(env.seed.ship.sol) };
    expect(() => createDraftListing(env.db, env.clock, env.seed.users.sol, copyId, input)).toThrow(/already has/);
    // Even bypassing the domain check, the partial unique index refuses it.
    expect(() =>
      env.db.prepare(`INSERT INTO listings (copy_id, seller_id, release_id, price_cents, currency, media_condition, sleeve_condition, condition_description, shipping_profile_id, status, created_at, updated_at)
        SELECT copy_id, seller_id, release_id, 100, 'USD', 'VG', 'VG', 'x', shipping_profile_id, 'available', 'now', 'now' FROM listings WHERE copy_id = ?`).run(copyId),
    ).toThrow(/UNIQUE/);
  });

  it("allows relisting after withdrawal, but never after a sale", async () => {
    const env = setup();
    const { copyId, listingId } = await makeListing(env, "sol");
    withdrawListing(env.db, env.clock, env.seed.users.sol, listingId);
    const input = { price: "20", media_condition: "VG", sleeve_condition: "VG", condition_description: "Relisted after withdrawal.", shipping_profile_id: String(env.seed.ship.sol) };
    const relisted = createDraftListing(env.db, env.clock, env.seed.users.sol, copyId, input);
    expect(relisted).toBeGreaterThan(listingId);
    const soldCopy = (env.db.prepare("SELECT copy_id FROM listings WHERE status = 'sold' AND seller_id = ?").get(env.seed.users.sol) as any).copy_id;
    expect(() => createDraftListing(env.db, env.clock, env.seed.users.sol, soldCopy, input)).toThrow(/sold listing/);
  });

  it("reserved listings can't be edited or withdrawn", async () => {
    const env = setup();
    const reserved = env.db.prepare("SELECT id, seller_id FROM listings WHERE status = 'reserved'").get() as any;
    expect(() => withdrawListing(env.db, env.clock, reserved.seller_id, reserved.id)).toThrow(/reserved/);
    expect(() => updateListing(env.db, env.clock, reserved.seller_id, reserved.id, { price: "1", media_condition: "VG", sleeve_condition: "VG", condition_description: "edit while reserved", shipping_profile_id: String(env.seed.ship.sol) })).toThrow(/can't be edited/);
  });
});

describe("reservation and purchase are atomic", () => {
  it("two buyers checking out the same copy: exactly one succeeds, the other gets nothing", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    const second = await makeListing(env, "sol", "va", "15.00");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    addToCart(env.db, env.clock, env.seed.users.cato, listingId);
    addToCart(env.db, env.clock, env.seed.users.cato, second.listingId); // cato's cart has an extra item
    const before = orderCount(env);
    const first = checkout(env.db, env.clock, 30, env.seed.users.mara, address("buyer-one"));
    expect(first.orderIds).toHaveLength(1);
    expect(() => checkout(env.db, env.clock, 30, env.seed.users.cato, address("buyer-two"))).toThrow(DomainError);
    expect(orderCount(env)).toBe(before + 1);
    // Cato's other item was NOT reserved: the failed checkout rolled back entirely.
    expect(listingStatus(env, second.listingId)).toBe("available");
    expect(listingStatus(env, listingId)).toBe("reserved");
  });

  it("the conditional reservation UPDATE fails if the listing changed since it was read", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    // Simulate a concurrent reservation landing between reading the cart and reserving.
    env.db.prepare("UPDATE listings SET status = 'reserved' WHERE id = ?").run(listingId);
    expect(() => checkout(env.db, env.clock, 30, env.seed.users.mara, address("race"))).toThrow(/no longer available|reserved by someone/);
  });

  it("repeated checkout submissions with the same key create no duplicate orders", async () => {
    const env = setup();
    const a = await makeListing(env, "sol");
    const b = await makeListing(env, "cato", "va");
    addToCart(env.db, env.clock, env.seed.users.mara, a.listingId);
    addToCart(env.db, env.clock, env.seed.users.mara, b.listingId);
    const before = orderCount(env);
    const r1 = checkout(env.db, env.clock, 30, env.seed.users.mara, address("same-key"));
    const r2 = checkout(env.db, env.clock, 30, env.seed.users.mara, address("same-key"));
    expect(r1.orderIds).toHaveLength(2); // one simulated order per seller
    expect(r2).toEqual({ orderIds: r1.orderIds, replayed: true });
    expect(orderCount(env)).toBe(before + 2);
  });

  it("repeated HTTP submissions are idempotent too", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    const buyer = await agentFor(env, "mara");
    await buyer.post("/cart/add", { listing_id: listingId });
    const before = orderCount(env);
    const r1 = await buyer.post("/checkout", address("http-key"));
    const r2 = await buyer.post("/checkout", address("http-key"));
    expect(r1.status).toBe(303);
    expect(r2.status).toBe(303);
    expect(r2.headers.location).toBe(r1.headers.location);
    expect(orderCount(env)).toBe(before + 1);
  });

  it("a seller cannot buy their own listing", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    expect(() => addToCart(env.db, env.clock, env.seed.users.sol, listingId)).toThrow(/own listing/);
  });

  it("sold copies can't be purchased again", async () => {
    const env = setup();
    const sold = (env.db.prepare("SELECT id FROM listings WHERE status = 'sold'").get() as any).id;
    expect(() => addToCart(env.db, env.clock, env.seed.users.cato, sold)).toThrow(/no longer available/);
  });
});

describe("reservation expiry and cancellation release inventory", () => {
  it("unpaid reservations expire and the copy becomes available again", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    const [orderId] = checkout(env.db, env.clock, 30, env.seed.users.mara, address("expiry")).orderIds;
    env.clock.advanceMinutes(29);
    expect(expireReservations(env.db, env.clock)).toBe(0);
    expect(listingStatus(env, listingId)).toBe("reserved");
    env.clock.advanceMinutes(2);
    expect(expireReservations(env.db, env.clock)).toBeGreaterThanOrEqual(1);
    expect(listingStatus(env, listingId)).toBe("available");
    expect((env.db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as any).status).toBe("expired");
    // Paying after expiry is refused, and another buyer can now buy it.
    expect(() => transitionOrder(env.db, env.clock, env.seed.users.mara, orderId, "pay")).toThrow();
    addToCart(env.db, env.clock, env.seed.users.cato, listingId);
    expect(checkout(env.db, env.clock, 30, env.seed.users.cato, address("after-expiry")).orderIds).toHaveLength(1);
  });

  it("expiry also happens lazily on any request", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    checkout(env.db, env.clock, 30, env.seed.users.mara, address("lazy"));
    env.clock.advanceMinutes(31);
    const r = await (await agentFor(env)).get(`/api/listings/${listingId}`);
    expect(r.body.status).toBe("available");
  });

  it("cancelling before or after payment releases only that order's copies", async () => {
    const env = setup();
    const a = await makeListing(env, "sol");
    const b = await makeListing(env, "sol", "va");
    addToCart(env.db, env.clock, env.seed.users.mara, a.listingId);
    const [o1] = checkout(env.db, env.clock, 30, env.seed.users.mara, address("c1")).orderIds;
    addToCart(env.db, env.clock, env.seed.users.cato, b.listingId);
    const [o2] = checkout(env.db, env.clock, 30, env.seed.users.cato, address("c2")).orderIds;
    transitionOrder(env.db, env.clock, env.seed.users.cato, o2, "pay");
    expect(listingStatus(env, b.listingId)).toBe("sold");
    transitionOrder(env.db, env.clock, env.seed.users.mara, o1, "cancel");
    expect(listingStatus(env, a.listingId)).toBe("available");
    expect(listingStatus(env, b.listingId)).toBe("sold"); // untouched
    transitionOrder(env.db, env.clock, env.seed.users.sol, o2, "cancel"); // seller cancels a paid order
    expect(listingStatus(env, b.listingId)).toBe("available");
  });
});

describe("order state transitions", () => {
  it("allows only the documented transitions for the right actor", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    const [id] = checkout(env.db, env.clock, 30, env.seed.users.mara, address("sm")).orderIds;
    const buyer = env.seed.users.mara;
    const seller = env.seed.users.sol;
    expect(() => transitionOrder(env.db, env.clock, seller, id, "ship", { carrier: "X" })).toThrow(); // can't ship unpaid
    expect(() => transitionOrder(env.db, env.clock, seller, id, "pay")).toThrow(); // seller can't pay
    expect(() => transitionOrder(env.db, env.clock, env.seed.users.cato, id, "cancel")).toThrow(/not found/i); // stranger
    expect(transitionOrder(env.db, env.clock, buyer, id, "pay")).toBe("paid");
    expect(() => transitionOrder(env.db, env.clock, buyer, id, "pay")).toThrow(); // double pay
    expect(() => transitionOrder(env.db, env.clock, buyer, id, "cancel")).toThrow(); // buyer can't cancel once paid
    expect(() => transitionOrder(env.db, env.clock, seller, id, "ship", {})).toThrow(); // carrier required
    expect(transitionOrder(env.db, env.clock, seller, id, "ship", { carrier: "Demo Post", tracking: "T1" })).toBe("shipped");
    expect(() => transitionOrder(env.db, env.clock, seller, id, "cancel")).toThrow(); // can't cancel shipped
    expect(transitionOrder(env.db, env.clock, buyer, id, "deliver")).toBe("delivered");
    for (const a of ["pay", "cancel", "ship", "deliver"] as const) expect(() => transitionOrder(env.db, env.clock, seller, id, a, { carrier: "x" })).toThrow();
    const events = env.db.prepare("SELECT from_status, to_status FROM order_events WHERE order_id = ? ORDER BY id").all(id);
    expect(events).toEqual([
      { from_status: null, to_status: "awaiting_payment" },
      { from_status: "awaiting_payment", to_status: "paid" },
      { from_status: "paid", to_status: "shipped" },
      { from_status: "shipped", to_status: "delivered" },
    ]);
    expect(listingStatus(env, listingId)).toBe("sold");
  });

  it("every transition in the table is reachable from a real state", () => {
    const states = new Set(["awaiting_payment", "paid", "shipped", "delivered", "cancelled", "expired"]);
    for (const t of TRANSITIONS) {
      expect(states.has(t.from)).toBe(true);
      expect(states.has(t.to)).toBe(true);
    }
    expect(TRANSITIONS.some((t) => t.from === "delivered" || t.from === "cancelled" || t.from === "expired")).toBe(false);
  });
});

describe("snapshots and totals", () => {
  it("order snapshots don't change after listing edits or accepted archive corrections", async () => {
    const env = setup();
    const { listingId, copyId } = await makeListing(env, "sol", "nb-orig", "30.00");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    const [orderId] = checkout(env.db, env.clock, 30, env.seed.users.mara, address("snap")).orderIds;
    const snapshot = () => env.db.prepare("SELECT * FROM order_lines WHERE order_id = ?").get(orderId);
    const orderRow = () => env.db.prepare("SELECT items_subtotal_cents, shipping_cents, total_cents, shipping_rule_snapshot FROM orders WHERE id = ?").get(orderId);
    const before = snapshot();
    const orderBefore = orderRow();

    // Cancel so the listing becomes editable, then edit price and description.
    transitionOrder(env.db, env.clock, env.seed.users.mara, orderId, "cancel");
    updateListing(env.db, env.clock, env.seed.users.sol, listingId, { price: "99.00", media_condition: "P", sleeve_condition: "P", condition_description: "Edited after the order.", shipping_profile_id: String(env.seed.ship.sol) });
    // Shipping profile change.
    env.db.prepare("UPDATE shipping_profiles SET world_first = 9999 WHERE id = ?").run(env.seed.ship.sol);
    // Archive correction changes the catalog number and label of the edition.
    const payload = editionAsPayload(env.db, env.seed.releases["nb-orig"]);
    const p = submitProposal(env.db, env.clock, env.user("cato"), { kind: "correction", master_id: env.seed.masters["Nightbus Dialogues"], target_release_id: env.seed.releases["nb-orig"], imagePaths: [],
      body: { ...payload, catalog_number: "LLR-004-CHANGED", label_name: "Renamed Label", source_kind: "other", source_citation: "test", source_notes: "a test correction note" } as any });
    if (!p.ok) throw new Error("expected proposal");
    acceptProposal(env.db, env.clock, env.user("moss"), p.proposalId, null);

    expect(snapshot()).toEqual(before);
    expect(orderRow()).toEqual(orderBefore);
    expect((before as any).catalog_number_snapshot).toBe("LLR-004");
    expect((before as any).price_cents).toBe(3000);
    // And private copy data was never touched by the archive edit.
    expect((env.db.prepare("SELECT private_notes FROM copies WHERE id = ?").get(copyId) as any).private_notes).toBe("SECRET-NOTE-XYZ");
    expect((env.db.prepare("SELECT condition_description FROM listings WHERE id = ?").get(listingId) as any).condition_description).toBe("Edited after the order.");
  });

  it("a listing edited after being added to a cart must be re-checked (version guard)", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "sol");
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    updateListing(env.db, env.clock, env.seed.users.sol, listingId, { price: "31.00", media_condition: "VG", sleeve_condition: "VG", condition_description: "Price changed.", shipping_profile_id: String(env.seed.ship.sol) });
    // getCart reads the current version, so checkout snapshots the *new* price, never a stale one.
    const [id] = checkout(env.db, env.clock, 30, env.seed.users.mara, address("ver")).orderIds;
    expect((env.db.prepare("SELECT price_cents, listing_version FROM order_lines WHERE order_id = ?").get(id) as any)).toEqual({ price_cents: 3100, listing_version: 2 });
  });

  it("totals are exact integer cents, grouped per seller", async () => {
    const env = setup();
    const a = await makeListing(env, "sol", "nb-orig", "10.10");
    const b = await makeListing(env, "sol", "va", "20.20");
    const c = await makeListing(env, "cato", "ut", "0.30".replace("0.30", "1.30"));
    for (const l of [a, b, c]) addToCart(env.db, env.clock, env.seed.users.mara, l.listingId);
    const groups = getCart(env.db, env.seed.users.mara, "US");
    const sol = groups.find((g) => g.seller.id === env.seed.users.sol)!;
    const cato = groups.find((g) => g.seller.id === env.seed.users.cato)!;
    expect(sol.subtotal_cents).toBe(3030);
    expect(sol.shipping).toMatchObject({ ok: true, cents: 1600 + 400, zone: "world" }); // GB→US: 16.00 + 4.00
    expect(sol.total_cents).toBe(5030);
    expect(cato.shipping).toMatchObject({ ok: true, cents: 500, zone: "domestic" });
    expect(cato.total_cents).toBe(630);
    const ids = checkout(env.db, env.clock, 30, env.seed.users.mara, address("totals")).orderIds;
    const totals = ids.map((id) => (env.db.prepare("SELECT total_cents FROM orders WHERE id = ?").get(id) as any).total_cents).sort((x, y) => x - y);
    expect(totals).toEqual([630, 5030]);
  });

  it("no delivered total when the seller doesn't ship to the destination; checkout refused", async () => {
    const env = setup();
    const { listingId } = await makeListing(env, "dex"); // Europe only
    addToCart(env.db, env.clock, env.seed.users.mara, listingId);
    const [g] = getCart(env.db, env.seed.users.mara, "US");
    expect(g.shipping.ok).toBe(false);
    expect(g.total_cents).toBeNull();
    expect(() => checkout(env.db, env.clock, 30, env.seed.users.mara, address("noship", "US"))).toThrow(/does not ship/);
    expect(getCart(env.db, env.seed.users.mara, "FR")[0].total_cents).toBe(3000 + 800);
  });

  it("money helpers never use floats for amounts", () => {
    expect(parseMoneyToCents("0.1")).toBe(10);
    expect(parseMoneyToCents("0.10")).toBe(10);
    expect(parseMoneyToCents("1,234.56")).toBe(123456);
    expect(parseMoneyToCents("12.345")).toBeNull();
    expect(parseMoneyToCents("-1")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(sumCents([10, 20])).toBe(30); // where 0.1 + 0.2 !== 0.3 in floats
    expect(() => sumCents([0.1])).toThrow();
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(quoteShipping([], "US").ok).toBe(false);
    expect(quoteShipping([{ id: 1, name: "", origin_country: "GB", domestic_first: 450, domestic_additional: 150, region_first: null, region_additional: null, world_first: null, world_additional: null, currency: "USD" }], "GB")).toMatchObject({ ok: true, cents: 450 });
  });
});
