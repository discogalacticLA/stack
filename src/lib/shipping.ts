import { COUNTRIES } from "./reference.js";
import { formatMoney } from "./money.js";

/**
 * Demo shipping rules (documented in docs/PRODUCT.md):
 * - A seller profile has an origin country and up to three zones: domestic (same country),
 *   region (same demo zone, e.g. Europe) and world (everywhere else).
 * - Each zone has a first-item charge and an additional-item charge, in integer cents.
 * - A NULL first-item charge means the seller does not ship to that zone: no total can be shown.
 * - Charges for one seller's order: highest first-item charge among the items' profiles + the
 *   additional charge of each other item. (With one profile per seller this is simply
 *   first + additional × (n − 1).)
 */
export interface ShippingProfile {
  id: number;
  name: string;
  origin_country: string;
  domestic_first: number | null;
  domestic_additional: number | null;
  region_first: number | null;
  region_additional: number | null;
  world_first: number | null;
  world_additional: number | null;
  currency: string;
}

export type Zone = "domestic" | "region" | "world";

export function zoneFor(origin: string, destination: string): Zone {
  if (origin === destination) return "domestic";
  const a = COUNTRIES[origin]?.zone;
  const b = COUNTRIES[destination]?.zone;
  if (a && b && a === b) return "region";
  return "world";
}

export function zoneRates(p: ShippingProfile, zone: Zone): { first: number; additional: number } | null {
  const first = p[`${zone}_first` as const];
  const additional = p[`${zone}_additional` as const];
  if (first == null) return null;
  return { first, additional: additional ?? first };
}

export type ShippingQuote =
  | { ok: true; cents: number; zone: Zone; description: string }
  | { ok: false; reason: string };

export function quoteShipping(profiles: ShippingProfile[], destination: string | null): ShippingQuote {
  if (!destination) return { ok: false, reason: "Choose a destination to calculate shipping." };
  if (!COUNTRIES[destination]) return { ok: false, reason: "Unsupported destination." };
  if (profiles.length === 0) return { ok: false, reason: "No items." };
  const rates: { first: number; additional: number }[] = [];
  let zone: Zone = "domestic";
  for (const p of profiles) {
    zone = zoneFor(p.origin_country, destination);
    const r = zoneRates(p, zone);
    if (!r) return { ok: false, reason: `Seller does not ship from ${p.origin_country} to ${COUNTRIES[destination].name}.` };
    rates.push(r);
  }
  // Integer arithmetic only.
  const firstIndex = rates.reduce((best, r, i) => (r.first > rates[best].first ? i : best), 0);
  let cents = rates[firstIndex].first;
  rates.forEach((r, i) => {
    if (i !== firstIndex) cents += r.additional;
  });
  const p0 = profiles[0];
  const r0 = zoneRates(p0, zone)!;
  const description =
    `${zoneLabel(zone)} rate from ${p0.origin_country} to ${destination}: ` +
    `${formatMoney(r0.first, p0.currency)} first item, ${formatMoney(r0.additional, p0.currency)} each additional` +
    ` (${profiles.length} item${profiles.length === 1 ? "" : "s"})`;
  return { ok: true, cents, zone, description };
}

export function zoneLabel(zone: Zone) {
  return zone === "domestic" ? "Domestic" : zone === "region" ? "Same-region" : "International";
}
