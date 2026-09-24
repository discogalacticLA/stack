import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { DomainError } from "./errors.js";

/** Accepts only JPEG/PNG/WebP (checked by magic bytes, not just the declared type). SVG is refused. */
const SIGNATURES: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
];

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 6;

export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES },
});

export function detectImageExt(buf: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(buf))?.ext ?? null;
}

/** Saves validated image files under uploadDir/<subdir>/ and returns relative paths. */
export function saveImages(uploadDir: string, subdir: "copies" | "proposals", files: Express.Multer.File[] | undefined): string[] {
  const out: string[] = [];
  for (const f of files ?? []) {
    if (!f.size) continue;
    const ext = detectImageExt(f.buffer);
    if (!ext) throw new DomainError(`“${f.originalname}” is not a JPEG, PNG or WebP image.`, 422);
    const rel = path.join(subdir, `${crypto.randomBytes(12).toString("hex")}.${ext}`);
    const abs = path.join(uploadDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.buffer);
    out.push(rel);
  }
  return out;
}

export function resolveUpload(uploadDir: string, rel: string): string {
  const abs = path.resolve(uploadDir, rel);
  if (!abs.startsWith(path.resolve(uploadDir) + path.sep)) throw new DomainError("Invalid path", 400);
  return abs;
}
