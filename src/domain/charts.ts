/**
 * Top 5 charts: an explicitly ranked selection with scope, period, commentary and visibility.
 * Milestone scope: private drafts only. A chart may have fewer than five entries; positions
 * are never filled automatically and a chart is only called complete at exactly five.
 */
import { z } from "zod";
import type { DB } from "../db/index.js";
import type { Clock } from "../lib/clock.js";
import { iso } from "../lib/clock.js";
import { DomainError, notFound } from "../lib/errors.js";
import { optionalText, parse } from "../lib/validation.js";
import { ownedRefs, type ItemRef } from "./library.js";

export const MAX_CHART_ENTRIES = 5;

export const SCOPES = {
  favorites: { label: "Favorites this month", period: "month" },
  discoveries: { label: "Discoveries this month", period: "month" },
  new_releases: { label: "New releases this month", period: "month" },
  all_time_favorites: { label: "All-time favorites", period: "all_time" },
  most_played: { label: "Most played (all time, from exported play counts)", period: "all_time" },
} as const;
export type Scope = keyof typeof SCOPES;

export const chartSchema = z
  .object({
    title: z.string().trim().max(100).optional().transform((v) => v || null),
    chart_type: z.enum(["track", "release"], { error: "Choose a track chart or a release chart." }),
    scope: z.enum(Object.keys(SCOPES) as [Scope, ...Scope[]], { error: "Choose what this chart is about." }),
    period_month: z.string().trim().optional().transform((v) => v || null),
    commentary: optionalText(2000),
  })
  .superRefine((c, ctx) => {
    if (SCOPES[c.scope].period === "month") {
      if (!c.period_month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(c.period_month)) ctx.addIssue({ code: "custom", path: ["period_month"], message: "Choose the month, e.g. 2026-09." });
    }
    if (c.scope === "most_played" && c.chart_type !== "track") {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "“Most played” needs play counts, which only exist for imported tracks. Use a track chart." });
    }
  });

function defaultTitle(c: { chart_type: string; scope: Scope; period_month: string | null }) {
  const what = c.chart_type === "track" ? "tracks" : "releases";
  const month = c.period_month ? new Date(`${c.period_month}-01T00:00:00Z`).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" }) : "";
  return `${SCOPES[c.scope].label.replace("this month", month).replace(/ \(.*\)$/, "")} — ${what}`.replace(/\s+/g, " ");
}

export function createChart(db: DB, clock: Clock, ownerId: number, raw: unknown): number {
  const c = parse(chartSchema, raw);
  const now = iso(clock.now());
  const period = SCOPES[c.scope].period;
  return Number(
    db.prepare(
      `INSERT INTO charts (owner_id, title, chart_type, scope, period_kind, period_month, commentary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ownerId, c.title ?? defaultTitle(c), c.chart_type, c.scope, period, period === "month" ? c.period_month : null, c.commentary, now, now).lastInsertRowid,
  );
}

export function updateChartDetails(db: DB, clock: Clock, ownerId: number, chartId: number, raw: unknown) {
  const chart = getOwnChart(db, ownerId, chartId);
  const d = parse(z.object({ title: z.string().trim().min(1, "Give the chart a title.").max(100), commentary: optionalText(2000) }), raw);
  db.prepare("UPDATE charts SET title = ?, commentary = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(d.title, d.commentary, iso(clock.now()), chart.id, ownerId);
}

export function deleteChart(db: DB, ownerId: number, chartId: number) {
  getOwnChart(db, ownerId, chartId);
  db.prepare("DELETE FROM charts WHERE id = ? AND owner_id = ?").run(chartId, ownerId);
}

export function getOwnChart(db: DB, ownerId: number, chartId: number) {
  const c = db.prepare("SELECT * FROM charts WHERE id = ? AND owner_id = ?").get(chartId, ownerId) as any;
  if (!c) throw notFound("Chart");
  c.entries = db
    .prepare(
      `SELECT ce.*, li.item_type, li.item_id, li.artist, li.title, li.version, li.format_group, li.format_raw, li.year, li.edition_id,
         d.play_count, d.granularity
       FROM chart_entries ce
       JOIN library_items li ON (li.item_type = 'physical' AND li.item_id = ce.copy_id) OR (li.item_type = 'digital' AND li.item_id = ce.digital_id)
       LEFT JOIN digital_holdings d ON d.id = ce.digital_id
       WHERE ce.chart_id = ? ORDER BY ce.position`,
    )
    .all(chartId);
  c.complete = c.entries.length === MAX_CHART_ENTRIES;
  return c;
}

export function listCharts(db: DB, ownerId: number) {
  return db
    .prepare("SELECT c.*, (SELECT COUNT(*) FROM chart_entries WHERE chart_id = c.id) AS n FROM charts c WHERE c.owner_id = ? ORDER BY c.period_month IS NULL, c.period_month DESC, c.id DESC")
    .all(ownerId) as any[];
}

/** Why an item can't go in this chart, or null if it can. */
export function entryProblem(db: DB, chart: any, ref: ItemRef, trackPosition: string | null): string | null {
  if (ref.type === "digital") {
    const d = db.prepare("SELECT granularity, play_count FROM digital_holdings WHERE id = ?").get(ref.id) as any;
    if (chart.chart_type === "track" && d.granularity !== "track") return "This digital holding is a whole release; a track chart needs a track.";
    if (chart.chart_type === "release" && d.granularity !== "release") return "This is a single track; a release chart needs a release (a physical copy or a digital release).";
    if (chart.scope === "most_played" && d.play_count == null) return "“Most played” needs a play count from your import; this track has none.";
  } else {
    if (chart.chart_type === "track" && !trackPosition) return "For a track chart, name the track on this record (e.g. A1 or “B2 Vauxhall Hum”).";
    if (chart.scope === "most_played") return "Play counts only exist for imported digital tracks, so physical records can't be in a “most played” chart.";
  }
  return null;
}

export function addChartEntry(db: DB, clock: Clock, ownerId: number, chartId: number, ref: ItemRef, input: { track_position?: unknown; commentary?: unknown }) {
  db.transaction(() => {
    const chart = getOwnChart(db, ownerId, chartId);
    if (!ownedRefs(db, ownerId, [ref]).length) throw notFound("Item");
    if (chart.entries.length >= MAX_CHART_ENTRIES) throw new DomainError("A Top 5 has at most five entries. Remove one first.", 422);
    const col = ref.type === "physical" ? "copy_id" : "digital_id";
    const trackPosition = typeof input.track_position === "string" && input.track_position.trim() ? input.track_position.trim().slice(0, 80) : null;
    if (chart.entries.some((e: any) => e[col] === ref.id && (e.track_position ?? null) === trackPosition)) throw new DomainError("That's already in this chart.", 422);
    const problem = entryProblem(db, chart, ref, trackPosition);
    if (problem) throw new DomainError(problem, 422);
    const commentary = parse(optionalText(1000), typeof input.commentary === "string" ? input.commentary : undefined);
    db.prepare(`INSERT INTO chart_entries (chart_id, position, ${col}, track_position, commentary) VALUES (?, ?, ?, ?, ?)`).run(chartId, chart.entries.length + 1, ref.id, trackPosition, commentary);
    db.prepare("UPDATE charts SET updated_at = ? WHERE id = ?").run(iso(clock.now()), chartId);
  })();
}

export function updateEntryCommentary(db: DB, clock: Clock, ownerId: number, chartId: number, entryId: number, commentary: unknown) {
  getOwnChart(db, ownerId, chartId);
  const c = parse(optionalText(1000), typeof commentary === "string" ? commentary : undefined);
  const r = db.prepare("UPDATE chart_entries SET commentary = ? WHERE id = ? AND chart_id = ?").run(c, entryId, chartId);
  if (r.changes !== 1) throw notFound("Chart entry");
  db.prepare("UPDATE charts SET updated_at = ? WHERE id = ?").run(iso(clock.now()), chartId);
}

/**
 * Rewrites positions 1..n in the given order. (chart_id, position) is unique and positions are
 * constrained to 1–5, so rows are re-inserted with their original ids inside the caller's transaction.
 */
function writeOrder(db: DB, chartId: number, ids: number[]) {
  const rows = ids.map((id) => db.prepare("SELECT * FROM chart_entries WHERE id = ?").get(id) as any);
  db.prepare("DELETE FROM chart_entries WHERE chart_id = ?").run(chartId);
  rows.forEach((r, i) =>
    db.prepare("INSERT INTO chart_entries (id, chart_id, position, copy_id, digital_id, track_position, commentary) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, chartId, i + 1, r.copy_id, r.digital_id, r.track_position, r.commentary));
}

export function removeChartEntry(db: DB, clock: Clock, ownerId: number, chartId: number, entryId: number) {
  db.transaction(() => {
    getOwnChart(db, ownerId, chartId);
    if (db.prepare("DELETE FROM chart_entries WHERE id = ? AND chart_id = ?").run(entryId, chartId).changes !== 1) throw notFound("Chart entry");
    writeOrder(db, chartId, (db.prepare("SELECT id FROM chart_entries WHERE chart_id = ? ORDER BY position").all(chartId) as any[]).map((r) => r.id));
    db.prepare("UPDATE charts SET updated_at = ? WHERE id = ?").run(iso(clock.now()), chartId);
  })();
}

export function moveChartEntry(db: DB, clock: Clock, ownerId: number, chartId: number, entryId: number, direction: "up" | "down") {
  db.transaction(() => {
    getOwnChart(db, ownerId, chartId);
    const ids = (db.prepare("SELECT id FROM chart_entries WHERE chart_id = ? ORDER BY position").all(chartId) as any[]).map((r) => r.id as number);
    const i = ids.indexOf(entryId);
    if (i === -1) throw notFound("Chart entry");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    writeOrder(db, chartId, ids);
    db.prepare("UPDATE charts SET updated_at = ? WHERE id = ?").run(iso(clock.now()), chartId);
  })();
}
