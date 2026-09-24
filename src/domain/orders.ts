import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, notFound } from "../lib/errors.js";
import { sumCents } from "../lib/money.js";
import { COUNTRY_CODES } from "../lib/reference.js";
import { quoteShipping, type ShippingQuote } from "../lib/shipping.js";
import { parse, requiredText } from "../lib/validation.js";
import { getPublicListing, type PublicListing } from "./listings.js";

// ───────────────────────── Order state machine ─────────────────────────
export type OrderStatus = "awaiting_payment" | "paid" | "shipped" | "delivered" | "cancelled" | "expired";
export type OrderAction = "pay" | "cancel" | "ship" | "deliver" | "expire";
type Actor = "buyer" | "seller" | "system";

/**
 * Every allowed transition. Anything not listed here is rejected server-side.
 * Inventory effects: pay → listing sold; cancel/expire → listing available again.
 */
export const TRANSITIONS: { action: OrderAction; from: OrderStatus; to: OrderStatus; actors: Actor[] }[] = [
  { action: "pay", from: "awaiting_payment", to: "paid", actors: ["buyer"] },
  { action: "cancel", from: "awaiting_payment", to: "cancelled", actors: ["buyer", "seller"] },
  { action: "expire", from: "awaiting_payment", to: "expired", actors: ["system"] },
  { action: "cancel", from: "paid", to: "cancelled", actors: ["seller"] },
  { action: "ship", from: "paid", to: "shipped", actors: ["seller"] },
  { action: "deliver", from: "shipped", to: "delivered", actors: ["buyer", "seller"] },
];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  awaiting_payment: "Awaiting simulated payment",
  paid: "Paid (simulated) — to ship",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  expired: "Reservation expired",
};

export const ACTION_LABEL: Record<OrderAction, string> = {
  pay: "Complete simulated payment",
  cancel: "Cancel order",
  ship: "Mark as shipped",
  deliver: "Mark as delivered",
  expire: "Expire",
};

export function allowedActions(status: OrderStatus, actor: Actor): OrderAction[] {
  return TRANSITIONS.filter((t) => t.from === status && t.actors.includes(actor)).map((t) => t.action);
}

// ───────────────────────── Cart ─────────────────────────
export function addToCart(db: DB, clock: Clock, buyerId: number, listingId: number) {
  const l = db.prepare("SELECT seller_id, status FROM listings WHERE id = ?").get(listingId) as { seller_id: number; status: string } | undefined;
  if (!l || !["available", "reserved", "sold"].includes(l.status)) throw notFound("Listing");
  if (l.seller_id === buyerId) throw new DomainError("You can't buy your own listing.", 422);
  if (l.status !== "available") throw new DomainError("This copy is no longer available.");
  db.prepare("INSERT OR IGNORE INTO cart_items (user_id, listing_id, added_at) VALUES (?, ?, ?)").run(buyerId, listingId, iso(clock.now()));
}

export function removeFromCart(db: DB, buyerId: number, listingId: number) {
  db.prepare("DELETE FROM cart_items WHERE user_id = ? AND listing_id = ?").run(buyerId, listingId);
}

export interface CartGroup {
  seller: PublicListing["seller"];
  items: PublicListing[];
  unavailable: PublicListing[];
  subtotal_cents: number;
  shipping: ShippingQuote;
  total_cents: number | null;
  currency: string;
}

/** Cart grouped by seller. Each group becomes one simulated order. */
export function getCart(db: DB, buyerId: number, destination: string | null): CartGroup[] {
  const ids = db
    .prepare("SELECT listing_id FROM cart_items WHERE user_id = ? ORDER BY added_at, listing_id")
    .all(buyerId)
    .map((r: any) => r.listing_id as number);
  const groups = new Map<number, CartGroup>();
  for (const id of ids) {
    const l = getPublicListing(db, id);
    if (!l) {
      removeFromCart(db, buyerId, id); // withdrawn listings silently leave the cart
      continue;
    }
    let g = groups.get(l.seller.id);
    if (!g) {
      g = { seller: l.seller, items: [], unavailable: [], subtotal_cents: 0, shipping: { ok: false, reason: "" }, total_cents: null, currency: l.currency };
      groups.set(l.seller.id, g);
    }
    (l.status === "available" ? g.items : g.unavailable).push(l);
  }
  for (const g of groups.values()) {
    g.subtotal_cents = sumCents(g.items.map((i) => i.price_cents));
    g.shipping = g.items.length ? quoteShipping(g.items.map((i) => i.shipping_profile), destination) : { ok: false, reason: "No available items." };
    g.total_cents = g.shipping.ok ? g.subtotal_cents + g.shipping.cents : null;
  }
  return [...groups.values()];
}

export function cartCount(db: DB, buyerId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?").get(buyerId) as { n: number }).n;
}

// ───────────────────────── Checkout ─────────────────────────
export const addressSchema = z.object({
  ship_to_name: requiredText("Recipient name", 120),
  ship_to_line1: requiredText("Address line", 200),
  ship_to_city: requiredText("City", 120),
  ship_to_postcode: requiredText("Postal code", 20),
  ship_to_country: z.string().refine((v) => COUNTRY_CODES.includes(v), "Choose a destination country."),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Checkout form expired. Please reload the page."),
});

export interface CheckoutResult {
  orderIds: number[];
  replayed: boolean;
}

/**
 * Converts the cart into one simulated order per seller, atomically.
 * - Every listing is reserved with a conditional UPDATE (… WHERE status = 'available'),
 *   so two buyers can never both reserve the same copy; the loser's whole checkout rolls back.
 * - The idempotency key makes repeated submissions return the original orders.
 */
export function checkout(db: DB, clock: Clock, reservationMinutes: number, buyerId: number, raw: unknown): CheckoutResult {
  const input = parse(addressSchema, raw);
  expireReservations(db, clock);
  return db.transaction((): CheckoutResult => {
    const prior = db.prepare("SELECT buyer_id, order_ids FROM checkout_attempts WHERE idempotency_key = ?").get(input.idempotency_key) as
      | { buyer_id: number; order_ids: string }
      | undefined;
    if (prior) {
      if (prior.buyer_id !== buyerId) throw new DomainError("Invalid checkout session. Please reload.", 422);
      return { orderIds: JSON.parse(prior.order_ids), replayed: true };
    }
    const groups = getCart(db, buyerId, input.ship_to_country);
    const unavailable = groups.flatMap((g) => g.unavailable);
    if (unavailable.length) {
      for (const u of unavailable) removeFromCart(db, buyerId, u.id);
      throw new DomainError(
        `Some items are no longer available and were removed from your cart: ${unavailable.map((u) => `${u.title} (#${u.id})`).join(", ")}. Nothing was ordered.`,
      );
    }
    const payable = groups.filter((g) => g.items.length);
    if (!payable.length) throw new DomainError("Your cart is empty.", 422);
    for (const g of payable) {
      if (!g.shipping.ok) throw new DomainError(`${g.seller.display_name}: ${g.shipping.reason}`, 422);
    }
    const buyer = db.prepare("SELECT display_name FROM users WHERE id = ?").get(buyerId) as { display_name: string };
    const now = clock.now();
    const nowIso = iso(now);
    const reservedUntil = iso(new Date(now.getTime() + reservationMinutes * 60_000));
    const orderIds: number[] = [];

    for (const g of payable) {
      if (g.seller.id === buyerId) throw new DomainError("You can't buy your own listing.", 422);
      const shipping = g.shipping as Extract<ShippingQuote, { ok: true }>;
      const orderId = Number(
        db
          .prepare(
            `INSERT INTO orders (buyer_id, seller_id, status, currency, items_subtotal_cents, shipping_cents, total_cents,
               seller_name_snapshot, buyer_name_snapshot, ship_to_name, ship_to_line1, ship_to_city, ship_to_postcode, ship_to_country,
               shipping_rule_snapshot, reserved_until, checkout_key, created_at, updated_at)
             VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(buyerId, g.seller.id, g.currency, g.subtotal_cents, shipping.cents, g.subtotal_cents + shipping.cents,
            g.seller.display_name, buyer.display_name, input.ship_to_name, input.ship_to_line1, input.ship_to_city,
            input.ship_to_postcode, input.ship_to_country, shipping.description, reservedUntil, input.idempotency_key, nowIso, nowIso)
          .lastInsertRowid,
      );
      for (const item of g.items) {
        const reserved = db
          .prepare(
            `UPDATE listings SET status = 'reserved', reserved_order_id = ?, reserved_until = ?, updated_at = ?
             WHERE id = ? AND status = 'available' AND seller_id != ? AND version = ?`,
          )
          .run(orderId, reservedUntil, nowIso, item.id, buyerId, item.version);
        if (reserved.changes !== 1) {
          // Throwing rolls back every order and reservation in this checkout.
          throw new DomainError(`“${item.title}” (#${item.id}) was just reserved by someone else or changed by the seller. Nothing was ordered.`);
        }
        const copy = db.prepare("SELECT copy_id FROM listings WHERE id = ?").get(item.id) as { copy_id: number };
        db.prepare(
          `INSERT INTO order_lines (order_id, listing_id, listing_version, copy_id, edition_id, artist_snapshot, title_snapshot, label_snapshot,
             catalog_number_snapshot, format_snapshot, country_snapshot, year_snapshot, media_condition_snapshot, sleeve_condition_snapshot,
             condition_description_snapshot, photo_ids_snapshot, price_cents, currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(orderId, item.id, item.version, copy.copy_id, item.edition_id, item.artist, item.title, item.label, item.catalog_number,
          item.format, item.country, item.release_year, item.media_condition, item.sleeve_condition, item.condition_description,
          JSON.stringify(item.photo_ids), item.price_cents, item.currency);
        removeFromCart(db, buyerId, item.id);
      }
      recordEvent(db, orderId, null, "awaiting_payment", buyerId, `Simulated order placed; copies reserved until ${reservedUntil}.`, nowIso);
      orderIds.push(orderId);
    }
    db.prepare("INSERT INTO checkout_attempts (idempotency_key, buyer_id, order_ids, created_at) VALUES (?, ?, ?, ?)").run(
      input.idempotency_key, buyerId, JSON.stringify(orderIds), nowIso);
    return { orderIds, replayed: false };
  })();
}

function recordEvent(db: DB, orderId: number, from: string | null, to: string, actorId: number | null, note: string | null, at: string) {
  db.prepare("INSERT INTO order_events (order_id, from_status, to_status, actor_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    orderId, from, to, actorId, note, at);
}

export const shipSchema = z.object({
  carrier: requiredText("Carrier", 60),
  tracking: z.string().trim().max(80).optional().transform((v) => v || null),
});

/**
 * Applies one transition with a conditional UPDATE on the current status, so a stale page or
 * double click can't apply a transition twice or skip a state.
 */
export function transitionOrder(
  db: DB,
  clock: Clock,
  actorId: number | null,
  orderId: number,
  action: OrderAction,
  extra: Record<string, unknown> = {},
): OrderStatus {
  return db.transaction(() => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as any;
    if (!order) throw notFound("Order");
    let actor: Actor;
    if (actorId == null) actor = "system";
    else if (actorId === order.buyer_id) actor = "buyer";
    else if (actorId === order.seller_id) actor = "seller";
    else throw notFound("Order");

    const now = clock.now();
    const t = TRANSITIONS.find((x) => x.action === action && x.from === order.status && x.actors.includes(actor));
    if (!t) throw new DomainError(`Can't ${ACTION_LABEL[action].toLowerCase()} an order that is “${STATUS_LABEL[order.status as OrderStatus]}”.`);
    if (action === "pay" && order.reserved_until && order.reserved_until <= iso(now)) {
      throw new DomainError("This reservation has expired. The copies were released.");
    }
    let note: string | null = null;
    let carrier = order.fulfillment_carrier;
    let tracking = order.fulfillment_tracking;
    if (action === "ship") {
      const s = parse(shipSchema, extra);
      carrier = s.carrier;
      tracking = s.tracking;
      note = `Carrier: ${s.carrier}${s.tracking ? `, tracking: ${s.tracking}` : ""} (recorded only; no carrier contacted)`;
    } else if (typeof extra.note === "string" && extra.note.trim()) {
      note = extra.note.trim().slice(0, 500);
    }
    const r = db
      .prepare(
        `UPDATE orders SET status = ?, fulfillment_carrier = ?, fulfillment_tracking = ?, updated_at = ?,
           reserved_until = CASE WHEN ? IN ('paid','cancelled','expired') THEN NULL ELSE reserved_until END
         WHERE id = ? AND status = ?`,
      )
      .run(t.to, carrier, tracking, iso(now), t.to, orderId, t.from);
    if (r.changes !== 1) throw new DomainError("This order changed in the meantime. Refresh and try again.");

    if (t.to === "paid") {
      const sold = db
        .prepare("UPDATE listings SET status = 'sold', reserved_until = NULL, updated_at = ? WHERE reserved_order_id = ? AND status = 'reserved'")
        .run(iso(now), orderId);
      const lines = (db.prepare("SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?").get(orderId) as { n: number }).n;
      if (sold.changes !== lines) throw new DomainError("Inventory for this order is inconsistent; payment not recorded.");
    }
    if (t.to === "cancelled" || t.to === "expired") releaseInventory(db, orderId, iso(now));
    recordEvent(db, orderId, t.from, t.to, actorId, note, iso(now));
    return t.to;
  })();
}

/** Returns an order's copies to "available" — only rows still held by this order are touched. */
function releaseInventory(db: DB, orderId: number, at: string) {
  db.prepare(
    `UPDATE listings SET status = 'available', reserved_order_id = NULL, reserved_until = NULL, updated_at = ?
     WHERE reserved_order_id = ? AND status IN ('reserved', 'sold')`,
  ).run(at, orderId);
}

/** Expires unpaid reservations whose hold time has passed. Safe to call often. */
export function expireReservations(db: DB, clock: Clock): number {
  const due = db
    .prepare("SELECT id FROM orders WHERE status = 'awaiting_payment' AND reserved_until <= ?")
    .all(iso(clock.now())) as { id: number }[];
  let n = 0;
  for (const o of due) {
    try {
      transitionOrder(db, clock, null, o.id, "expire", { note: "Reservation time elapsed; copies released." });
      n++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e; // already moved on concurrently
    }
  }
  return n;
}

// ───────────────────────── Reading orders ─────────────────────────
export function getOrderForParticipant(db: DB, userId: number, orderId: number) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND (buyer_id = ? OR seller_id = ?)").get(orderId, userId, userId) as any;
  if (!order) throw notFound("Order");
  order.lines = db.prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY id").all(orderId);
  for (const l of order.lines) l.photo_ids = JSON.parse(l.photo_ids_snapshot);
  order.events = db
    .prepare("SELECT ev.*, u.display_name AS actor_name FROM order_events ev LEFT JOIN users u ON u.id = ev.actor_id WHERE order_id = ? ORDER BY ev.id")
    .all(orderId);
  order.role = order.buyer_id === userId ? "buyer" : "seller";
  order.actions = allowedActions(order.status, order.role);
  return order;
}

export function listOrders(db: DB, userId: number, role: "buyer" | "seller", status?: string) {
  const col = role === "buyer" ? "buyer_id" : "seller_id";
  const args: unknown[] = [userId];
  let extra = "";
  if (status) {
    extra = " AND o.status = ?";
    args.push(status);
  }
  return db
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM order_lines WHERE order_id = o.id) AS line_count,
         (SELECT title_snapshot FROM order_lines WHERE order_id = o.id ORDER BY id LIMIT 1) AS first_title
       FROM orders o WHERE o.${col} = ?${extra} ORDER BY o.id DESC`,
    )
    .all(...args) as any[];
}

/** After delivery the buyer can add the purchased copy to their own (private) collection. */
export function addPurchaseToCollection(db: DB, clock: Clock, buyerId: number, lineId: number): number {
  return db.transaction(() => {
    const line = db
      .prepare("SELECT ol.*, o.buyer_id, o.status, o.id AS oid, o.seller_name_snapshot FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.id = ?")
      .get(lineId) as any;
    if (!line || line.buyer_id !== buyerId) throw notFound("Order line");
    if (line.status !== "delivered") throw new DomainError("You can add this to your collection once the order is delivered.");
    if (line.buyer_copy_id) throw new DomainError("Already added to your collection.");
    const now = iso(clock.now());
    const copyId = Number(
      db
        .prepare(
          `INSERT INTO copies (owner_id, edition_id, media_condition, sleeve_condition, acquired_on, acquired_from, acquisition_cost_cents,
             acquisition_currency, date_added, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(buyerId, line.edition_id, line.media_condition_snapshot, line.sleeve_condition_snapshot, now.slice(0, 10),
          `Simulated order #${line.oid} from ${line.seller_name_snapshot}`, line.price_cents, line.currency, now, now, now).lastInsertRowid,
    );
    db.prepare("UPDATE order_lines SET buyer_copy_id = ? WHERE id = ?").run(copyId, lineId);
    return copyId;
  })();
}
