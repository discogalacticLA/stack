/**
 * Generates large SYNTHETIC export files for performance checks (never committed).
 *   npm run fixtures:large            → data/fixtures-large/*.csv|xml
 * Also imported by tests to build files in memory.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARTISTS = ["Aurelia Kaan", "Kovač Unit", "Dembe Salt", "Hanae Sorell", "The Low Hours", "Idris Vale", "Lua Ferreira", "井上 ひかり"];
const WORDS = ["Night", "Tidal", "Salt", "Glass", "Relay", "Weather", "Dawn", "Tram", "Hall", "Garden", "Signal", "Room"];
const FORMATS = ['Vinyl, 12", 33 ⅓ RPM', "2xLP, Album", "CD, Album", "Cass, Album", 'Vinyl, 7", 45 RPM', "File, FLAC"];
const CONDS = ["Mint (M)", "Near Mint (NM or M-)", "Very Good Plus (VG+)", "Very Good (VG)", "Good Plus (G+)"];
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function discogsCollectionCsv(rows: number): string {
  const out = ["Catalog#,Artist,Title,Label,Format,Rating,Released,release_id,CollectionFolder,Date Added,Collection Media Condition,Collection Sleeve Condition,Collection Notes"];
  for (let i = 0; i < rows; i++) {
    // Every 50th release is owned twice (identical rows) to keep multiplicity in play.
    const rel = i % 50 === 49 ? 8_000_000 + i - 1 : 8_000_000 + i;
    const title = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${Math.floor(i / 12)}`;
    out.push([q(`SYN-${rel}`), q(ARTISTS[i % ARTISTS.length]), q(title), q("Synthetic Label"), q(FORMATS[i % FORMATS.length]), String(i % 6), String(1980 + (i % 45)),
      String(rel), q(["DJ Crates", "Listening", "Uncategorized"][i % 3]), "2024-01-01 10:00:00", q(CONDS[i % CONDS.length]), q(CONDS[(i + 1) % CONDS.length]), q(i % 10 === 0 ? "note, with comma" : "")].join(","));
  }
  return out.join("\n") + "\n";
}

export function rekordboxXml(tracks: number, playlists = 50): string {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">', '<PRODUCT Name="rekordbox" Version="6.8.5" Company="AlphaTheta"/>', `<COLLECTION Entries="${tracks}">`];
  for (let i = 1; i <= tracks; i++) {
    const a = ARTISTS[i % ARTISTS.length];
    const t = `${WORDS[i % WORDS.length]} ${WORDS[(i * 3) % WORDS.length]} ${i}`;
    parts.push(`<TRACK TrackID="${i}" Name="${xmlEsc(t)}" Artist="${xmlEsc(a)}" Album="Synthetic" Genre="House" Kind="MP3 File" Size="${9_000_000 + i}" TotalTime="${240 + (i % 200)}" Year="${1990 + (i % 35)}" AverageBpm="${(118 + (i % 12)).toFixed(2)}" DateAdded="2025-01-01" BitRate="320" SampleRate="44100" Comments="" PlayCount="${i % 40}" Rating="${(i % 6) * 51}" Location="file://localhost/Users/sample/Music/syn/${i}.mp3" Tonality="8A" Label="Synthetic" Mix=""><POSITION_MARK Name="" Type="0" Start="1.0" Num="0"/></TRACK>`);
  }
  parts.push("</COLLECTION>", "<PLAYLISTS>", '<NODE Type="0" Name="ROOT">', '<NODE Type="0" Name="Generated">');
  for (let p = 0; p < playlists; p++) {
    parts.push(`<NODE Name="List ${p}" Type="1" KeyType="0" Entries="100">`);
    for (let k = 0; k < 100; k++) parts.push(`<TRACK Key="${((p * 97 + k * 13) % tracks) + 1}"/>`);
    parts.push("</NODE>");
  }
  parts.push("</NODE>", "</NODE>", "</PLAYLISTS>", "</DJ_PLAYLISTS>");
  return parts.join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = "data/fixtures-large";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "synthetic-discogs-collection-10000.csv"), discogsCollectionCsv(10_000));
  fs.writeFileSync(path.join(dir, "synthetic-rekordbox-20000.xml"), rekordboxXml(20_000));
  console.log(`Wrote synthetic large fixtures to ${dir}/`);
}
