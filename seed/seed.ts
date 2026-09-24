import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DB } from "../src/db/index.js";
import { openDatabase } from "../src/db/index.js";
import { loadConfig } from "../src/config.js";
import { hashPassword, loadUser } from "../src/lib/auth.js";
import { systemClock, iso, type Clock } from "../src/lib/clock.js";
import { normalizeCatno } from "../src/domain/catalog.js";
import { addCopyPhoto, createCopy, createCrate } from "../src/domain/collection.js";
import { createDraftListing, publishListing, saveShippingProfile } from "../src/domain/listings.js";
import { addToCart, checkout, transitionOrder } from "../src/domain/orders.js";
import { acceptProposal, editionAsPayload, submitProposal } from "../src/domain/proposals.js";
import { addWant } from "../src/domain/wants.js";
import { ARTISTS, RELEASES } from "./data.js";

export const DEMO_PASSWORD = "demo-password";

export const DEMO_USERS = [
  { username: "mara", name: "Mara (demo buyer)", country: "US", roles: [], bio: "DJ and collector. Main demo buyer." },
  { username: "sol", name: "Sol Vinyl (demo seller)", country: "GB", roles: [], bio: "Label owner selling duplicates." },
  { username: "dex", name: "Dex Records (demo seller)", country: "DE", roles: [], bio: "Ships within Europe only." },
  { username: "cato", name: "Cato (demo contributor)", country: "US", roles: ["contributor"], bio: "Documents pressings; also sells." },
  { username: "moss", name: "Moss (demo moderator)", country: "NL", roles: ["moderator"], bio: "Reviews archive changes." },
] as const;

type Ids = Record<string, number>;

/** Seeds an empty, migrated database. Uses the real domain functions so data is consistent. */
export function seedDatabase(db: DB, clock: Clock = systemClock) {
  const now = iso(clock.now());
  const users: Ids = {};
  const hash = hashPassword(DEMO_PASSWORD); // one hash reused: fine for shared demo password
  for (const u of DEMO_USERS) {
    const id = Number(
      db.prepare("INSERT INTO users (username, display_name, password_hash, country, bio, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .run(u.username, u.name, hash, u.country, u.bio, now).lastInsertRowid,
    );
    for (const r of u.roles) db.prepare("INSERT INTO user_roles (user_id, role) VALUES (?, ?)").run(id, r);
    users[u.username] = id;
  }

  // ───── Archive ─────
  const artistIds: Ids = {};
  for (const [name, sort] of Object.entries(ARTISTS)) {
    artistIds[name] = Number(db.prepare("INSERT INTO artists (name, sort_name, profile, created_at) VALUES (?, ?, 'Synthetic demo artist.', ?)").run(name, sort, now).lastInsertRowid);
  }
  const labelIds: Ids = {};
  const labelId = (name: string | null) => {
    if (!name) return null;
    if (!labelIds[name]) labelIds[name] = Number(db.prepare("INSERT INTO labels (name, profile, created_at) VALUES (?, 'Synthetic demo label.', ?)").run(name, now).lastInsertRowid);
    return labelIds[name];
  };
  const ed: Ids = {};
  const rel: Ids = {};
  for (const r of RELEASES) {
    const rid = Number(db.prepare("INSERT INTO releases (title, release_type, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(r.title, r.type, r.description ?? null, now, now).lastInsertRowid);
    rel[r.title] = rid;
    r.artists.forEach(([name, join], i) => db.prepare("INSERT INTO release_artists (release_id, artist_id, position, join_text) VALUES (?, ?, ?, ?)").run(rid, artistIds[name], i, join ?? ""));
    for (const g of r.genres) db.prepare("INSERT INTO release_terms (release_id, kind, term) VALUES (?, 'genre', ?)").run(rid, g);
    for (const s of r.styles) db.prepare("INSERT INTO release_terms (release_id, kind, term) VALUES (?, 'style', ?)").run(rid, s);
    for (const e of r.editions) {
      const eid = Number(
        db.prepare(
          `INSERT INTO editions (release_id, label_id, catalog_number, catalog_number_norm, format, format_details, country, release_year, release_month, release_day,
             date_note, edition_notes, verification_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(rid, labelId(e.label), e.catno, normalizeCatno(e.catno), e.format, e.details ?? null, e.country, e.year, e.month ?? null, e.day ?? null,
          e.dateNote ?? null, e.notes ?? null, e.status, now, now).lastInsertRowid,
      );
      ed[e.key] = eid;
      e.tracks.forEach(([pos, title, dur, artist], i) => {
        const secs = dur ? Number(dur.split(":")[0]) * 60 + Number(dur.split(":")[1]) : null;
        db.prepare("INSERT INTO tracks (edition_id, position, title, artist_credit, duration_seconds, sort_order) VALUES (?, ?, ?, ?, ?, ?)").run(eid, pos, title, artist ?? null, secs, i);
      });
      for (const [kind, value, note] of e.identifiers ?? []) db.prepare("INSERT INTO edition_identifiers (edition_id, kind, value, note) VALUES (?, ?, ?, ?)").run(eid, kind, value, note ?? null);
      for (const [kind, citation] of e.sources ?? []) db.prepare("INSERT INTO archival_sources (edition_id, kind, citation, created_at) VALUES (?, ?, ?, ?)").run(eid, kind, citation, now);
      for (const kind of e.images ?? []) {
        db.prepare("INSERT INTO archive_images (edition_id, kind, placeholder_seed, attribution, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(eid, kind, `${e.key}-${kind}`, "Original placeholder artwork generated for this prototype", now);
      }
      db.prepare("INSERT INTO edition_revisions (edition_id, summary, changes, created_at) VALUES (?, 'Imported from synthetic seed data', '[]', ?)").run(eid, now);
    }
  }

  // ───── Shipping profiles ─────
  const ship: Ids = {};
  ship.sol = saveShippingProfile(db, clock, users.sol, { name: "Mailer (UK)", origin_country: "GB", domestic_first: "4.50", domestic_additional: "1.50", region_first: "9.00", region_additional: "2.50", world_first: "16.00", world_additional: "4.00" });
  ship.dex = saveShippingProfile(db, clock, users.dex, { name: "Europe only", origin_country: "DE", domestic_first: "5.00", domestic_additional: "1.00", region_first: "8.00", region_additional: "2.00" });
  ship.cato = saveShippingProfile(db, clock, users.cato, { name: "US media mail", origin_country: "US", domestic_first: "5.00", domestic_additional: "1.00", region_first: "12.00", region_additional: "3.00", world_first: "22.00", world_additional: "5.00" });

  // ───── Copies + listings ─────
  const copy = (owner: string, edition: string, media: string, sleeve: string, extra: Record<string, string> = {}) =>
    createCopy(db, clock, users[owner], ed[edition], { media_condition: media, sleeve_condition: sleeve, ...extra });
  const list = (owner: string, copyId: number, price: string, desc: string, photos = 2, publish = true) => {
    const photoIds = Array.from({ length: photos }, (_, i) => addCopyPhoto(db, clock, users[owner], copyId, { placeholder_seed: `copy-${copyId}-${i}`, caption: i === 0 ? "front" : "label" }));
    const c = db.prepare("SELECT media_condition, sleeve_condition FROM copies WHERE id = ?").get(copyId) as any;
    const lid = createDraftListing(db, clock, users[owner], copyId, {
      price, media_condition: c.media_condition, sleeve_condition: c.sleeve_condition, condition_description: desc, shipping_profile_id: String(ship[owner]), photo_ids: photoIds.map(String),
    });
    if (publish) publishListing(db, clock, users[owner], lid);
    return lid;
  };

  // Three sellers offer different copies of LLR-004.
  list("sol", copy("sol", "nb-orig", "VG+", "VG+", { private_notes: "PRIVATE: bought in a job lot, paid too much", storage_location: "PRIVATE-SHELF-SOL-A1", acquisition_cost: "9.00" }),
    "38.00", "Light marks that don't affect play. Sleeve has minor ring wear. Played through on a Technics.");
  list("dex", copy("dex", "nb-orig", "NM", "VG", { storage_location: "Dex back room" }), "52.00", "Looks unplayed. Sleeve has a small seam split on the top edge.");
  list("dex", copy("dex", "nb-orig", "G+", "GENERIC", {}), "12.00", "DJ copy. Audible crackle in intro of A1; plays through. Generic sleeve.", 1);
  list("cato", copy("cato", "nb-orig", "VG", "VG+", { private_notes: "Cato private note" }), "44.00", "Some hairlines, light surface noise between tracks. Original sleeve.");
  list("sol", copy("sol", "nb-repress", "NM", "NM"), "18.00", "Repress in excellent condition. Sticker intact.");
  list("sol", copy("sol", "tr-us", "VG+", "VG"), "26.00", "Blue labels. Light scuffs on B side, plays clean.");
  list("dex", copy("dex", "sm", "M", "M"), "24.00", "Sealed. Clear vinyl.", 1);
  list("cato", copy("cato", "va", "VG+", "VG+"), "21.00", "Clean copy, inner sleeve included.");
  const saltListing = list("sol", copy("sol", "sg-lp", "VG+", "VG"), "34.00", "Gatefold has shelf wear. Both discs play well.");
  const tramListing = list("sol", copy("sol", "tl", "VG", "GENERIC"), "15.00", "Plays with light noise. Generic sleeve.");
  const hallListing = list("dex", copy("dex", "ah", "NM", "VG+"), "19.00", "Barely played.");
  list("dex", copy("dex", "rr", "VG+", "VG"), "14.00", "Draft listing not yet published.", 1, false);
  copy("sol", "ut", "VG", "VG", { private_notes: "Keeping this one", storage_location: "Home crate" }); // private, not for sale

  // ───── Mara's collection: enough copies to show pagination and bulk actions ─────
  const crates: Ids = {
    warm: createCrate(db, clock, users.mara, "Warm-up"),
    peak: createCrate(db, clock, users.mara, "Peak time"),
    sunday: createCrate(db, clock, users.mara, "Sunday closing"),
  };
  const maraCopies: [string, string, string, string, string, string?, string?][] = [
    ["nb-repress", "VG+", "VG+", "warm", "warm-up, vocal", "3", "A1 122 · B2 124"],
    ["sg-cd", "NM", "NM", "", "listening", "", ""],
    ["ut", "VG", "VG", "peak", "peak-time, tool", "5", "A 130"],
    ["sm", "NM", "NM", "sunday", "closing, instrumental", "1", "beatless-ish"],
    ["wt", "VG+", "VG", "warm", "warm-up, tool", "2", "all ~120"],
    ["dw", "VG", "VG", "sunday", "closing", "2", ""],
    ["dw-cd", "NM", "NM", "", "", "", ""],
    ["tr-de", "VG+", "VG+", "warm", "dub", "3", "A 121"],
    ["va", "NM", "VG+", "sunday", "vocal", "3", ""],
    ["rr", "VG", "VG", "peak", "peak-time", "4", "A 132, B 134"],
    ["ma", "NM", "NM", "sunday", "closing, instrumental", "2", "B 112"],
    ["sg-re", "M", "M", "", "", "", ""],
    ["ah", "VG+", "VG+", "warm", "vocal", "3", "A1 123"],
    ["nb-cd", "VG+", "VG+", "", "", "", ""],
    ["tl", "G+", "GENERIC", "peak", "tool", "4", ""],
    ["ot", "VG", "VG", "", "listening", "", ""],
    ["sm-file", "M", "NONE", "", "", "", ""],
  ];
  let i = 0;
  for (const [edKey, media, sleeve, crate, tags, energy, bpm] of maraCopies) {
    if (!ed[edKey]) continue;
    copy("mara", edKey, media, sleeve, {
      crate_id: crate ? String(crates[crate]) : "", tags, dj_energy: energy ?? "", dj_bpm_notes: bpm ?? "",
      storage_location: `Shelf ${1 + (i % 4)}, slot ${10 + i}`, private_notes: i % 3 === 0 ? "Bought at a record fair (demo)" : "",
      acquired_on: "2024-06-01", acquisition_cost: `${8 + i}.00`,
    });
    i++;
  }
  // A few more duplicates of DJ tools so the collection spans two pages.
  for (let n = 0; n < 8; n++) copy("mara", n % 2 ? "wt" : "ut", "VG", "VG", { tags: n % 2 ? "tool, warm-up" : "tool", crate_id: String(crates.peak), storage_location: `Tool box ${n + 1}` });

  addWant(db, clock, users.mara, rel["Nightbus Dialogues"], ed["nb-orig"]);
  addWant(db, clock, users.mara, rel["Salt Garden"], null);
  addWant(db, clock, users.mara, rel["Olvera Tapes Vol. 1"], null);

  // ───── Simulated orders in various states ─────
  const addr = (name: string, country: string, key: string) => ({ ship_to_name: name, ship_to_line1: "1 Demo Street", ship_to_city: "Demo City", ship_to_postcode: "00000", ship_to_country: country, idempotency_key: key.padEnd(20, "x") });
  // Delivered: Mara bought Tram Lines from Sol → listing sold.
  addToCart(db, clock, users.mara, tramListing);
  const [delivered] = checkout(db, clock, 30, users.mara, addr("Mara Demo", "US", "seed-delivered")).orderIds;
  transitionOrder(db, clock, users.mara, delivered, "pay");
  transitionOrder(db, clock, users.sol, delivered, "ship", { carrier: "Demo Post", tracking: "DEMO-0001" });
  transitionOrder(db, clock, users.mara, delivered, "deliver");
  // Paid, waiting for Dex to ship: Moss bought Assembly Hall.
  addToCart(db, clock, users.moss, hallListing);
  const [paid] = checkout(db, clock, 30, users.moss, addr("Moss Demo", "NL", "seed-paid")).orderIds;
  transitionOrder(db, clock, users.moss, paid, "pay");
  // Reserved: Cato checked out Salt Garden but hasn't "paid" — a 24h demo hold keeps it reserved.
  addToCart(db, clock, users.cato, saltListing);
  checkout(db, clock, 24 * 60, users.cato, addr("Cato Demo", "US", "seed-reserved"));

  // ───── Contributions ─────
  const cato = loadUser(db, users.cato)!;
  const moss = loadUser(db, users.moss)!;
  // Accepted correction (shows revision history on LLR-004R).
  const base = editionAsPayload(db, ed["nb-repress"]);
  const accepted = submitProposal(db, clock, cato, {
    kind: "correction", release_id: rel["Nightbus Dialogues"], target_edition_id: ed["nb-repress"], imagePaths: [],
    body: { ...base, release_month: "", format_details: '12", 33 ⅓ RPM, Repress, Grey labels', source_kind: "physical_copy", source_citation: "Cato's copy (synthetic)", source_notes: "Label colour confirmed from my copy (synthetic demo)." } as any,
  });
  if (accepted.ok) acceptProposal(db, clock, moss, accepted.proposalId, "Matches the photo evidence.");
  // Pending correction for the moderator queue (adds uncertain country info to the test pressing).
  const tp = editionAsPayload(db, ed["nb-tp"]);
  submitProposal(db, clock, cato, {
    kind: "correction", release_id: rel["Nightbus Dialogues"], target_edition_id: ed["nb-tp"], imagePaths: [],
    body: { ...tp, country: "GB", date_note: "Undated; the sleeve stamp suggests early 1997.", source_kind: "other", source_citation: "Conversation with a former label employee (synthetic)", source_notes: "Recollection only; treat country as likely rather than certain." } as any,
  });

  return { users, editions: ed, releases: rel, ship };
}

// CLI: npm run seed  (refuses to touch a non-empty database)  ·  npm run reset  (deletes and reseeds)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  const reset = process.argv.includes("--reset");
  if (reset) {
    for (const f of [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(config.uploadDir), { recursive: true, force: true });
    console.log("Deleted local database and uploads.");
  }
  const db = openDatabase(config.databasePath);
  const existing = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (existing) {
    console.log("Database already has data. Run `npm run reset` to delete it and reseed.");
    process.exit(0);
  }
  seedDatabase(db);
  console.log(`Seeded synthetic demo data into ${config.databasePath}.`);
  console.log(`Demo accounts (password "${DEMO_PASSWORD}"): ${DEMO_USERS.map((u) => u.username).join(", ")}`);
  db.close();
}
