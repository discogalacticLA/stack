/** Writes .gz copies of the Discogs XML fixtures so tests exercise the real gzip streaming path. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dir = path.join(import.meta.dirname, "..", "tests", "fixtures", "discogs");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".xml"))) {
  fs.writeFileSync(path.join(dir, `${f}.gz`), zlib.gzipSync(fs.readFileSync(path.join(dir, f)), { level: 9 }));
}
console.log(`Wrote gzip fixtures in ${dir}`);
