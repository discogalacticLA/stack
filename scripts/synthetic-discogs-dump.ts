/**
 * Generates a SYNTHETIC releases dump in the Discogs dump layout, for performance checks only.
 * All names, ids and values are invented; record shape (tracks, credits, companies, identifiers,
 * formats, videos) is roughly modelled on typical releases so write costs are representative.
 * It is NOT a substitute for validating against a real dump.
 *
 *   npx tsx scripts/synthetic-discogs-dump.ts 50000 data/bench/synthetic_releases.xml.gz [--real-ids]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const count = Number(process.argv[2] ?? 50_000);
// ID ranges for referenced entities. "real" roughly matches the spread of real Discogs ids (millions),
// which matters for index locality; "small" (default, the original generator) keeps them compact.
const REAL = process.argv.includes("--real-ids");
const ids = REAL ? { artist: 9_000_000, master: 3_000_000, company: 2_500_000, label: 2_500_000 } : { artist: 400_000, master: 200_000, company: 100_000, label: 150_000 };
const out = process.argv[3] ?? "data/bench/synthetic_releases.xml.gz";
fs.mkdirSync(path.dirname(out), { recursive: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: T[]) => xs[int(0, xs.length - 1)];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const words = ["Night", "Tidal", "Low", "Hours", "Echo", "Rooms", "Signal", "Drift", "Glass", "Motion", "Blue", "Static", "Café", "Øresund", "Fjärran", "夜明け", "Straße", "Señal"];
const title = () => Array.from({ length: int(1, 4) }, () => pick(words)).join(" ");
const roles = ["Producer", "Mastered By", "Written-By", "Mixed By", "Design", "Photography By", "Lacquer Cut By", "Remix"];
const companyRoles: [number, string][] = [[17, "Pressed By"], [23, "Distributed By"], [13, "Phonographic Copyright (p)"], [14, "Copyright (c)"], [29, "Mastered At"], [19, "Lacquer Cut At"]];
const formats = [["Vinyl", ['12"', "33 ⅓ RPM", "EP"]], ["Vinyl", ["LP", "Album"]], ["CD", ["Album"]], ["File", ["MP3", "Album"]], ["Cassette", ["Album"]]] as const;

const artist = (tag = "artist", role = false) =>
  `<${tag}><id>${int(1, ids.artist)}</id><name>${esc(title())}</name><anv></anv><join>${rnd() < 0.2 ? "&amp;" : ""}</join><role>${role ? pick(roles) : ""}</role><tracks></tracks></${tag}>`;

const gz = zlib.createGzip();
gz.pipe(fs.createWriteStream(out));
gz.write('<?xml version="1.0" encoding="UTF-8"?>\n<releases>\n');
for (let i = 1; i <= count; i++) {
  const nTracks = int(2, 18);
  const tracks = Array.from({ length: nTracks }, (_, t) => {
    const sub = rnd() < 0.03 ? `<sub_tracks>${[1, 2].map((s) => `<track><position>${t + 1}.${s}</position><title>${esc(title())}</title><duration>${int(1, 9)}:${String(int(0, 59)).padStart(2, "0")}</duration></track>`).join("")}</sub_tracks>` : "";
    const ta = rnd() < 0.25 ? `<artists>${artist()}</artists>` : "";
    const te = rnd() < 0.3 ? `<extraartists>${artist("artist", true)}</extraartists>` : "";
    return `<track><position>${String.fromCharCode(65 + Math.floor(t / 4))}${(t % 4) + 1}</position><title>${esc(title())}</title><duration>${int(2, 12)}:${String(int(0, 59)).padStart(2, "0")}</duration>${ta}${te}${sub}</track>`;
  }).join("");
  const [fname, descs] = pick(formats as any) as [string, string[]];
  const master = rnd() < 0.7 ? `<master_id is_main_release="${rnd() < 0.3}">${int(1, ids.master)}</master_id>` : "";
  const companies = Array.from({ length: int(0, 5) }, () => {
    const [et, etn] = pick(companyRoles);
    return `<company><id>${int(1, ids.company)}</id><name>${esc(title())} Ltd.</name><catno></catno><entity_type>${et}</entity_type><entity_type_name>${etn}</entity_type_name><resource_url>https://api.example.invalid/labels/${i}</resource_url></company>`;
  }).join("");
  const identifiers = Array.from({ length: int(0, 5) }, (_, k) =>
    k === 0 ? `<identifier type="Barcode" value="5 0${String(i).padStart(10, "0")} ${k}"/>` : `<identifier type="Matrix / Runout" description="Side ${k}" value="SYN-${i}-${k} A"/>`).join("");
  const videos = rnd() < 0.4 ? `<videos><video src="https://www.youtube.com/watch?v=${String(i).padStart(11, "x").slice(0, 11)}" duration="${int(60, 600)}" embed="true"><title>${esc(title())}</title><description>${esc(title())}</description></video></videos>` : "";
  gz.write(
    `<release id="${i}" status="Accepted"><images><image type="primary" uri="" uri150="" width="600" height="600"/></images>` +
    `<artists>${Array.from({ length: int(1, 2) }, () => artist()).join("")}</artists><title>${esc(title())}</title>` +
    `<labels><label name="${esc(title())} Records" catno="SYN ${i}" id="${int(1, ids.label)}"/>${rnd() < 0.2 ? `<label name="Other" catno="OT-${i}" id="${int(1, ids.label)}"/>` : ""}</labels>` +
    `<extraartists>${Array.from({ length: int(0, 8) }, () => artist("artist", true)).join("")}</extraartists>` +
    `<formats><format name="${fname}" qty="${int(1, 2)}" text=""><descriptions>${descs.map((d) => `<description>${esc(d)}</description>`).join("")}</descriptions></format></formats>` +
    `<genres><genre>Electronic</genre>${rnd() < 0.3 ? "<genre>Jazz</genre>" : ""}</genres><styles><style>${pick(["House", "Techno", "Ambient", "Dub"])}</style></styles>` +
    `<country>${pick(["UK", "US", "Germany", "Japan", "France", "Netherlands"])}</country><released>${int(1960, 2025)}-${String(int(1, 12)).padStart(2, "0")}-00</released>` +
    `<notes>${rnd() < 0.4 ? esc(Array.from({ length: int(5, 60) }, () => pick(words)).join(" ")) : ""}</notes><data_quality>${pick(["Correct", "Needs Vote", "Complete and Correct"])}</data_quality>` +
    `${master}<tracklist>${tracks}</tracklist><identifiers>${identifiers}</identifiers>${videos}<companies>${companies}</companies></release>\n`,
  );
}
gz.end("</releases>\n");
gz.on("end", () => {});
console.error(`Wrote ${count} SYNTHETIC releases to ${out}`);
