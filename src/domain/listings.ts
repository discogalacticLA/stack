import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, notFound } from "../lib/errors.js";
import { DEMO_CURRENCY } from "../lib/money.js";
import { COUNTRY_CODES, MEDIA_CODES, SLEEVE_CODES, conditionRank } from "../lib/reference.js";
import { quoteShipping, type ShippingProfile, type ShippingQuote } from "../lib/shipping.js";
import { asIdArray, moneyField, parse, requiredText } from "../lib/validation.js";
import { artistCredit } from "./catalog.js";
import { getOwnCopy } from "./library.js";

export const ACTIVE_LISTING_STATUSES = ["draft", "available", "reserved", "sold"] as const;

export const listingSchema = z.object({
  price: moneyField("Price", { required: true }).refine((v) => v != null && v >= 100 && v <= 10_000_000, "Price must be between $1.00 and $100,000.00."),
  media_condition: z.string().refine((v) => MEDIA_CODES.includes(v), "Choose a media condition."),
  sleeve_condition: z.string().refine((v) => SLEEVE_CODES.includes(v), "Choose a sleeve condition."),
  condition_description: requiredText("Public condition description", 2000).refine(
    (v) => v.length >= 10,
    "Describe the condition in at least a short sentence (10+ characters).",
  ),
  shipping_profile_id: z.string({ error: "Choose a shipping profile." }).min(1, "Choose a shipping profile.").transform(Number),
  photo_ids: z.unknown().optional().transform((v) => asIdArray(v)),
});

function validateOwnedRefs(db: DB, sellerId: number, copyId: number, profileId: number, photoIds: number[]) {
  const profile = db.prepare("SELECT 1 FROM shipping_profiles WHERE id = ? AND seller_id = ?").get(profileId, sellerId);
  if (!profile) throw new DomainError("Choose one of your shipping profiles.", 422);
  for (const pid of photoIds) {
    const ok = db.prepare("SELECT 1 FROM copy_photos WHERE id = ? AND copy_id = ? AND deleted_at IS NULL").get(pid, copyId);
    if (!ok) throw new DomainError("A selected photo does not belong to this copy.", 422);
  }
}

function setListingPhotos(db: DB, listingId: number, photoIds: number[]) {
  db.prepare("DELETE FROM listing_photos WHERE listing_id = ?").run(listingId);
  photoIds.forEach((pid, i) => db.prepare("INSERT INTO listing_photos (listing_id, copy_photo_id, position) VALUES (?, ?, ?)").run(listingId, pid, i));
}

/** Creates a draft listing for a copy the seller owns. Enforces one active listing per copy. */
export function createDraftListing(db: DB, clock: Clock, sellerId: number, copyId: number, raw: unknown): number {
  const input = parse(listingSchema, raw);
  return db.transaction(() => {
    const copy = getOwnCopy(db, sellerId, copyId);
    // Listings must describe a real physical copy of a known archive edition (never a digital file).
    if (copy.edition_id == null) throw new DomainError("Link this copy to an archive edition before listing it, so buyers know exactly which pressing it is.", 422);
    validateOwnedRefs(db, sellerId, copyId, input.shipping_profile_id, input.photo_ids);
    const existing = db
      .prepare(`SELECT id, status FROM listings WHERE copy_id = ? AND status IN (${ACTIVE_LISTING_STATUSES.map(() => "?").join(",")})`)
      .get(copyId, ...ACTIVE_LISTING_STATUSES) as { id: number; status: string } | undefined;
    if (existing) throw new DomainError(`This copy already has a ${existing.status} listing (#${existing.id}). One listing per copy.`);
    const now = iso(clock.now());
    let id: number;
    try {
      id = Number(
        db
          .prepare(
            `INSERT INTO listings (copy_id, seller_id, edition_id, price_cents, currency, media_condition, sleeve_condition, condition_description,
               shipping_profile_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
          )
          .run(copyId, sellerId, copy.edition_id, input.price, DEMO_CURRENCY, input.media_condition, input.sleeve_condition,
            input.condition_description, input.shipping_profile_id, now, now).lastInsertRowid,
      );
    } catch (e: any) {
      // The partial unique index is the final guard against concurrent duplicate listings.
      if (String(e?.code).startsWith("SQLITE_CONSTRAINT")) throw new DomainError("This copy already has an active listing.");
      throw e;
    }
    setListingPhotos(db, id, input.photo_ids);
    return id;
  })();
}

export function getOwnListing(db: DB, sellerId: number, listingId: number) {
  const l = db.prepare("SELECT * FROM listings WHERE id = ? AND seller_id = ?").get(listingId, sellerId) as any;
  if (!l) throw notFound("Listing");
  l.photo_ids = db.prepare("SELECT copy_photo_id FROM listing_photos WHERE listing_id = ? ORDER BY position").all(listingId).map((r: any) => r.copy_photo_id);
  return l;
}

/** Only draft or available listings can be edited. Each edit bumps the version (orders snapshot it). */
export function updateListing(db: DB, clock: Clock, sellerId: number, listingId: number, raw: unknown) {
  const input = parse(listingSchema, raw);
  db.transaction(() => {
    const l = getOwnListing(db, sellerId, listingId);
    validateOwnedRefs(db, sellerId, l.copy_id, input.shipping_profile_id, input.photo_ids);
    const r = db
      .prepare(
        `UPDATE listings SET price_cents = ?, media_condition = ?, sleeve_condition = ?, condition_description = ?, shipping_profile_id = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND seller_id = ? AND status IN ('draft', 'available')`,
      )
      .run(input.price, input.media_condition, input.sleeve_condition, input.condition_description, input.shipping_profile_id,
        iso(clock.now()), listingId, sellerId);
    if (r.changes !== 1) throw new DomainError(`A ${l.status} listing can't be edited.`);
    setListingPhotos(db, listingId, input.photo_ids);
  })();
}

export function publishListing(db: DB, clock: Clock, sellerId: number, listingId: number) {
  getOwnListing(db, sellerId, listingId);
  const now = iso(clock.now());
  const r = db
    .prepare("UPDATE listings SET status = 'available', published_at = ?, updated_at = ? WHERE id = ? AND seller_id = ? AND status = 'draft'")
    .run(now, now, listingId, sellerId);
  if (r.changes !== 1) throw new DomainError("Only a draft listing can be published.");
}

export function withdrawListing(db: DB, clock: Clock, sellerId: number, listingId: number) {
  const l = getOwnListing(db, sellerId, listingId);
  const r = db
    .prepare("UPDATE listings SET status = 'withdrawn', updated_at = ? WHERE id = ? AND seller_id = ? AND status IN ('draft', 'available')")
    .run(iso(clock.now()), listingId, sellerId);
  if (r.changes !== 1) {
    throw new DomainError(
      l.status === "reserved"
        ? "This copy is reserved in a simulated checkout. Cancel the order to release it first."
        : `A ${l.status} listing can't be withdrawn.`,
    );
  }
  db.prepare("DELETE FROM cart_items WHERE listing_id = ?").run(listingId);
}

// ───────────────────────── Shipping profiles ─────────────────────────
const optionalRate = (label: string) => moneyField(label, { required: false });

export const shippingProfileSchema = z
  .object({
    name: requiredText("Profile name", 60),
    origin_country: z.string().refine((v) => COUNTRY_CODES.includes(v), "Choose the country you ship from."),
    domestic_first: optionalRate("Domestic first item"),
    domestic_additional: optionalRate("Domestic additional item"),
    region_first: optionalRate("Same-region first item"),
    region_additional: optionalRate("Same-region additional item"),
    world_first: optionalRate("International first item"),
    world_additional: optionalRate("International additional item"),
  })
  .refine((p) => p.domestic_first != null || p.region_first != null || p.world_first != null, {
    message: "Enter a first-item rate for at least one zone.",
    path: ["domestic_first"],
  });

export function saveShippingProfile(db: DB, clock: Clock, sellerId: number, raw: unknown, profileId?: number): number {
  const p = parse(shippingProfileSchema, raw);
  const vals = [p.name, p.origin_country, p.domestic_first, p.domestic_additional, p.region_first, p.region_additional, p.world_first, p.world_additional];
  if (profileId) {
    const r = db
      .prepare(
        `UPDATE shipping_profiles SET name = ?, origin_country = ?, domestic_first = ?, domestic_additional = ?, region_first = ?,
          region_additional = ?, world_first = ?, world_additional = ? WHERE id = ? AND seller_id = ?`,
      )
      .run(...vals, profileId, sellerId);
    if (r.changes !== 1) throw notFound("Shipping profile");
    return profileId;
  }
  return Number(
    db
      .prepare(
        `INSERT INTO shipping_profiles (seller_id, name, origin_country, domestic_first, domestic_additional, region_first, region_additional,
          world_first, world_additional, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sellerId, ...vals, DEMO_CURRENCY, iso(clock.now())).lastInsertRowid,
  );
}

export function listShippingProfiles(db: DB, sellerId: number): ShippingProfile[] {
  return db.prepare("SELECT * FROM shipping_profiles WHERE seller_id = ? ORDER BY id").all(sellerId) as ShippingProfile[];
}

// ───────────────────────── Public views ─────────────────────────
/**
 * The ONLY shape in which listing data leaves the seller's own screens.
 * Built from an explicit column list: private copy fields (notes, storage location,
 * acquisition cost/source/date, DJ notes, tags, crate) are never selected.
 */
export interface PublicListing {
  id: number;
  status: string;
  edition_id: number;
  release_id: number;
  artist: string;
  title: string;
  label: string | null;
  catalog_number: string | null;
  format: string;
  country: string | null;
  release_year: number | null;
  price_cents: number;
  currency: string;
  media_condition: string;
  sleeve_condition: string;
  condition_description: string;
  photo_ids: number[];
  seller: { id: number; display_name: string; country: string; member_since: string; completed_orders: number };
  shipping_profile: ShippingProfile;
  version: number;
  published_at: string | null;
}

export function getPublicListing(db: DB, listingId: number): PublicListing | null {
  const l = db
    .prepare(
      `SELECT li.id, li.status, li.edition_id, li.price_cents, li.currency, li.media_condition, li.sleeve_condition,
         li.condition_description, li.shipping_profile_id, li.seller_id, li.version, li.published_at,
         e.release_id, e.catalog_number, e.format, e.format_details, e.country, e.release_year, lb.name AS label, r.title,
         u.display_name AS seller_name, u.country AS seller_country, u.created_at AS seller_since
       FROM listings li JOIN editions e ON e.id = li.edition_id JOIN releases r ON r.id = e.release_id
       LEFT JOIN labels lb ON lb.id = e.label_id JOIN users u ON u.id = li.seller_id
       WHERE li.id = ? AND li.status IN ('available', 'reserved', 'sold')`,
    )
    .get(listingId) as any;
  if (!l) return null;
  const photo_ids = db
    .prepare(
      "SELECT lp.copy_photo_id FROM listing_photos lp JOIN copy_photos p ON p.id = lp.copy_photo_id WHERE lp.listing_id = ? ORDER BY lp.position",
    )
    .all(listingId)
    .map((r: any) => r.copy_photo_id as number);
  const completed = (
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE seller_id = ? AND status = 'delivered'").get(l.seller_id) as { n: number }
  ).n;
  return {
    id: l.id,
    status: l.status,
    edition_id: l.edition_id,
    release_id: l.release_id,
    artist: artistCredit(db, l.release_id),
    title: l.title,
    label: l.label,
    catalog_number: l.catalog_number,
    format: [l.format, l.format_details].filter(Boolean).join(", "),
    country: l.country,
    release_year: l.release_year,
    price_cents: l.price_cents,
    currency: l.currency,
    media_condition: l.media_condition,
    sleeve_condition: l.sleeve_condition,
    condition_description: l.condition_description,
    photo_ids,
    seller: { id: l.seller_id, display_name: l.seller_name, country: l.seller_country, member_since: l.seller_since.slice(0, 10), completed_orders: completed },
    shipping_profile: db.prepare("SELECT * FROM shipping_profiles WHERE id = ?").get(l.shipping_profile_id) as ShippingProfile,
    version: l.version,
    published_at: l.published_at,
  };
}

export interface ListingOffer extends PublicListing {
  shipping: ShippingQuote;
  total_cents: number | null;
}

export type OfferSort = "total" | "price" | "condition";

/** Available copies of an edition, with a delivered total when shipping can be calculated. */
export function offersForEdition(db: DB, editionId: number, destination: string | null, sort: OfferSort = "total"): ListingOffer[] {
  const ids = db
    .prepare("SELECT id FROM listings WHERE edition_id = ? AND status = 'available'")
    .all(editionId)
    .map((r: any) => r.id as number);
  const offers = ids.map((id) => {
    const l = getPublicListing(db, id)!;
    const shipping = quoteShipping([l.shipping_profile], destination);
    return { ...l, shipping, total_cents: shipping.ok ? l.price_cents + shipping.cents : null };
  });
  const cmp: Record<OfferSort, (a: ListingOffer, b: ListingOffer) => number> = {
    total: (a, b) => (a.total_cents ?? Number.MAX_SAFE_INTEGER) - (b.total_cents ?? Number.MAX_SAFE_INTEGER) || a.price_cents - b.price_cents,
    price: (a, b) => a.price_cents - b.price_cents,
    condition: (a, b) => conditionRank(a.media_condition) - conditionRank(b.media_condition) || conditionRank(a.sleeve_condition) - conditionRank(b.sleeve_condition),
  };
  return offers.sort(cmp[sort] ?? cmp.total);
}

export function listSellerListings(db: DB, sellerId: number) {
  return db
    .prepare(
      `SELECT li.id, li.status, li.price_cents, li.currency, li.copy_id, li.edition_id, li.updated_at, r.title, e.catalog_number
       FROM listings li JOIN editions e ON e.id = li.edition_id JOIN releases r ON r.id = e.release_id
       WHERE li.seller_id = ? ORDER BY CASE li.status WHEN 'available' THEN 0 WHEN 'reserved' THEN 1 WHEN 'draft' THEN 2 WHEN 'sold' THEN 3 ELSE 4 END, li.id DESC`,
    )
    .all(sellerId) as any[];
}
