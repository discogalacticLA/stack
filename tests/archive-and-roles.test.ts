import { describe, expect, it } from "vitest";
import { agentFor, makeListing, setup } from "./helpers.js";
import { acceptProposal, editionAsPayload, rejectProposal, submitProposal } from "../src/domain/proposals.js";
import { findDuplicateCandidates } from "../src/domain/catalog.js";
import { parseMediaLinkLines, parseYouTubeId } from "../src/lib/mediaLinks.js";

const source = { source_kind: "physical_copy", source_citation: "Examined my own copy", source_notes: "Checked the runout and labels carefully." };

function correction(env: ReturnType<typeof setup>, username: string, overrides: Record<string, string>) {
  const editionId = env.seed.editions["nb-orig"];
  return submitProposal(env.db, env.clock, env.user(username), {
    kind: "correction", release_id: env.seed.releases["Nightbus Dialogues"], target_edition_id: editionId, imagePaths: [],
    body: { ...(editionAsPayload(env.db, editionId) as any), ...source, ...overrides },
  });
}

describe("contributor vs moderator permissions", () => {
  it("members without the contributor role can't propose (domain + HTTP)", async () => {
    const env = setup();
    expect(() => correction(env, "mara", { edition_notes: "x" })).toThrow(/contributor role/);
    const buyer = await agentFor(env, "mara");
    expect((await buyer.get("/contribute")).status).toBe(403);
    expect((await buyer.post(`/contribute/correction?edition_id=${env.seed.editions["nb-orig"]}`, { format: "Vinyl", ...source })).status).toBe(403);
  });

  it("contributors can propose but not accept or reject", async () => {
    const env = setup();
    const r = correction(env, "cato", { edition_notes: "Updated notes from contributor." });
    expect(r.ok).toBe(true);
    const id = (r as any).proposalId;
    expect(() => acceptProposal(env.db, env.clock, env.user("cato"), id, null)).toThrow(/moderator role/);
    const cato = await agentFor(env, "cato");
    expect((await cato.post(`/proposals/${id}/accept`)).status).toBe(403);
    expect((await cato.post(`/proposals/${id}/reject`, { review_note: "nope nope" })).status).toBe(403);
    expect((await cato.get("/moderate")).status).toBe(403);
    // Still pending, edition unchanged.
    expect((env.db.prepare("SELECT status FROM proposals WHERE id = ?").get(id) as any).status).toBe("pending");
    expect((env.db.prepare("SELECT edition_notes FROM editions WHERE id = ?").get(env.seed.editions["nb-orig"]) as any).edition_notes).not.toContain("contributor");
  });

  it("moderators accept; the change is applied and the revision records who and what", async () => {
    const env = setup();
    const r = correction(env, "cato", { catalog_number: "LLR-004A", date_note: "Month uncertain." });
    const id = (r as any).proposalId;
    const mod = await agentFor(env, "moss");
    expect((await mod.post(`/proposals/${id}/accept`, { review_note: "ok" })).status).toBe(303);
    const e = env.db.prepare("SELECT catalog_number, catalog_number_norm, date_note, verification_status FROM editions WHERE id = ?").get(env.seed.editions["nb-orig"]) as any;
    expect(e).toMatchObject({ catalog_number: "LLR-004A", catalog_number_norm: "LLR004A", date_note: "Month uncertain.", verification_status: "reviewed" });
    const rev = env.db.prepare("SELECT * FROM edition_revisions WHERE proposal_id = ?").get(id) as any;
    expect(rev.proposed_by).toBe(env.seed.users.cato);
    expect(rev.accepted_by).toBe(env.seed.users.moss);
    expect(JSON.parse(rev.changes).map((c: any) => c.field).sort()).toEqual(["catalog_number", "date_note"]);
    expect(JSON.parse(rev.changes).find((c: any) => c.field === "catalog_number")).toEqual({ field: "catalog_number", before: "LLR-004", after: "LLR-004A" });
    // Can't be accepted twice.
    expect((await mod.post(`/proposals/${id}/accept`)).status).toBe(303); // redirected with an error flash
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM edition_revisions WHERE proposal_id = ?").get(id) as any).n).toBe(1);
  });

  it("moderators can't accept their own proposals", () => {
    const env = setup();
    const r = correction(env, "moss", { edition_notes: "Moderator's own proposed change." });
    expect(() => acceptProposal(env.db, env.clock, env.user("moss"), (r as any).proposalId, null)).toThrow(/own proposals/);
  });

  it("rejection requires a reason and leaves the edition unchanged", () => {
    const env = setup();
    const r = correction(env, "cato", { catalog_number: "WRONG-1" });
    expect(() => rejectProposal(env.db, env.clock, env.user("moss"), (r as any).proposalId, "")).toThrow();
    rejectProposal(env.db, env.clock, env.user("moss"), (r as any).proposalId, "No evidence for this change.");
    expect((env.db.prepare("SELECT catalog_number FROM editions WHERE id = ?").get(env.seed.editions["nb-orig"]) as any).catalog_number).toBe("LLR-004");
  });

  it("proposals need source notes, and a correction must change something", () => {
    const env = setup();
    expect(() => correction(env, "cato", { source_notes: "" })).toThrow();
    expect(() => correction(env, "cato", {})).toThrow(/doesn't change anything/);
  });

  it("archive edits never overwrite private notes or listing condition", async () => {
    const env = setup();
    const { copyId, listingId } = await makeListing(env, "sol");
    const r = correction(env, "cato", { edition_notes: "Brand new archival notes.", format_details: "12\", 45 RPM" });
    acceptProposal(env.db, env.clock, env.user("moss"), (r as any).proposalId, null);
    const c = env.db.prepare("SELECT private_notes, storage_location, media_condition FROM copies WHERE id = ?").get(copyId) as any;
    const l = env.db.prepare("SELECT condition_description, media_condition, sleeve_condition FROM listings WHERE id = ?").get(listingId) as any;
    expect(c).toEqual({ private_notes: "SECRET-NOTE-XYZ", storage_location: "SECRET-SHELF-42", media_condition: "VG+" });
    expect(l).toEqual({ condition_description: "Public description of this copy.", media_condition: "VG+", sleeve_condition: "VG" });
  });
});

describe("new editions and duplicate candidates", () => {
  it("shows likely duplicates before creating an edition, then accepts after acknowledgement", () => {
    const env = setup();
    const base = { label_name: "Lowlight Recordings", catalog_number: "llr 004", format: "Vinyl", country: "GB", release_year: "1997", ...source };
    const input = { kind: "new_edition" as const, release_id: env.seed.releases["Nightbus Dialogues"], target_edition_id: null, imagePaths: [] };
    const first = submitProposal(env.db, env.clock, env.user("cato"), { ...input, body: base });
    expect(first.ok).toBe(false);
    const dups = (first as any).duplicates;
    expect(dups[0].edition.catalog_number).toBe("LLR-004");
    expect(dups[0].reasons.join(" ")).toMatch(/Same catalog number/);
    expect(dups.map((d: any) => d.edition.catalog_number)).toContain("LLR-004R"); // similar, not identical
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE kind = 'new_edition'").get() as any).n).toBe(0);
    const second = submitProposal(env.db, env.clock, env.user("cato"), { ...input, body: { ...base, confirm_not_duplicate: "yes" } });
    expect(second.ok).toBe(true);
    const newId = acceptProposal(env.db, env.clock, env.user("moss"), (second as any).proposalId, null);
    expect((env.db.prepare("SELECT created_by, release_id FROM editions WHERE id = ?").get(newId) as any)).toEqual({ created_by: env.seed.users.cato, release_id: env.seed.releases["Nightbus Dialogues"] });
  });

  it("similar catalog numbers on different labels are flagged, not merged", () => {
    const env = setup();
    const c = findDuplicateCandidates(env.db, { release_id: env.seed.releases["Tidal Rooms"], label_id: null, catalog_number: "LLR-04", format: "Vinyl", country: "US", release_year: 1998 });
    expect(c.map((x) => x.edition.catalog_number)).toContain("LLR-04");
  });
});

describe("YouTube listening links", () => {
  it("accepts only YouTube URLs and stores the video id", () => {
    expect(parseYouTubeId("https://www.youtube.com/watch?v=abcdefghijk")).toBe("abcdefghijk");
    expect(parseYouTubeId("https://youtu.be/abcdefghijk?t=10")).toBe("abcdefghijk");
    expect(parseYouTubeId("https://music.youtube.com/watch?v=abcdefghijk")).toBe("abcdefghijk");
    expect(parseYouTubeId("https://www.youtube.com/embed/abcdefghijk")).toBe("abcdefghijk");
    expect(parseYouTubeId("https://evil.example/watch?v=abcdefghijk")).toBeNull();
    expect(parseYouTubeId("https://youtube.com.evil.example/watch?v=abcdefghijk")).toBeNull();
    expect(parseYouTubeId("javascript:alert(1)")).toBeNull();
    expect(parseYouTubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseMediaLinkLines("A1 | https://youtu.be/abcdefghijk\nhttps://youtu.be/bbbbbbbbbbb")).toEqual([
      { track_position: "A1", external_id: "abcdefghijk" }, { track_position: null, external_id: "bbbbbbbbbbb" },
    ]);
    expect(() => parseMediaLinkLines("https://soundcloud.com/x")).toThrow();
  });

  it("links go through moderation and render as click-to-load previews", async () => {
    const env = setup();
    const r = correction(env, "cato", { listening_links: "A1 | https://www.youtube.com/watch?v=abcdefghijk" });
    const editionId = env.seed.editions["nb-orig"];
    const anon = await agentFor(env);
    expect((await anon.get(`/editions/${editionId}`)).text).not.toContain("abcdefghijk"); // pending: not shown
    acceptProposal(env.db, env.clock, env.user("moss"), (r as any).proposalId, null);
    const page = (await anon.get(`/editions/${editionId}`)).text;
    expect(page).toContain('data-embed-src="https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0"');
    expect(page).not.toMatch(/<iframe/); // nothing loads until the viewer clicks
    expect(page).toContain("https://www.youtube.com/watch?v=abcdefghijk");
  });
});
