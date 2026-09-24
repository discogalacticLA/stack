import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { loadUser } from "../src/lib/auth.js";
import { FakeClock } from "../src/lib/clock.js";
import { seedDatabase, DEMO_PASSWORD } from "../seed/seed.js";

export function setup(env: Record<string, string> = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ra-test-"));
  const config = loadConfig({ NODE_ENV: "development", UPLOAD_DIR: uploadDir, RESERVATION_MINUTES: "30", ...env } as any);
  const db = openDatabase(":memory:");
  const clock = new FakeClock();
  const seed = seedDatabase(db, clock);
  const ctx = { db, clock, config };
  const app = createApp(ctx);
  const user = (username: string) => loadUser(db, seed.users[username])!;
  return { db, clock, config, app, seed, user, ctx };
}

export type TestEnv = ReturnType<typeof setup>;

export function csrfFrom(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("No CSRF token in page");
  return m[1];
}

/** A supertest agent signed in as `username`, with a helper for CSRF-protected POSTs. */
export async function agentFor(env: TestEnv, username?: string) {
  const agent = request.agent(env.app);
  let token = csrfFrom((await agent.get("/login")).text);
  if (username) {
    const r = await agent.post("/login").type("form").send({ _csrf: token, username, password: DEMO_PASSWORD });
    if (r.status !== 303) throw new Error(`login failed for ${username}: ${r.status}`);
    token = csrfFrom((await agent.get("/library")).text);
  }
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body: Record<string, unknown> = {}) => agent.post(url).type("form").send({ _csrf: token, ...body }),
  };
}

/** A fresh private copy + published listing for `owner`, created through domain code. */
export async function makeListing(env: TestEnv, owner: string, editionKey = "nb-orig", price = "30.00") {
  const { createCopy, addCopyPhoto } = await import("../src/domain/library.js");
  const { createDraftListing, publishListing } = await import("../src/domain/listings.js");
  const uid = env.seed.users[owner];
  const copyId = createCopy(env.db, env.clock, uid, env.seed.releases[editionKey], {
    media_condition: "VG+", sleeve_condition: "VG", private_notes: "SECRET-NOTE-XYZ", storage_location: "SECRET-SHELF-42",
    acquisition_cost: "7.77", acquired_from: "SECRET-SOURCE", dj_bpm_notes: "SECRET-BPM", tags: "secret-tag",
  });
  const photo = addCopyPhoto(env.db, env.clock, uid, copyId, { placeholder_seed: "t" });
  const profile = (env.db.prepare("SELECT id FROM shipping_profiles WHERE seller_id = ?").get(uid) as any)?.id;
  const listingId = createDraftListing(env.db, env.clock, uid, copyId, {
    price, media_condition: "VG+", sleeve_condition: "VG", condition_description: "Public description of this copy.", shipping_profile_id: String(profile), photo_ids: [String(photo)],
  });
  publishListing(env.db, env.clock, uid, listingId);
  return { copyId, listingId, photoId: photo };
}

export const address = (key: string, country = "US") => ({
  ship_to_name: "Test Buyer", ship_to_line1: "1 Test St", ship_to_city: "Testville", ship_to_postcode: "12345", ship_to_country: country,
  idempotency_key: `${key}`.padEnd(20, "k"),
});
