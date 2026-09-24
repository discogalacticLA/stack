import crypto from "node:crypto";
import type { DB } from "../db/index.js";
import type { Clock } from "./clock.js";
import { iso } from "./clock.js";
import { forbidden, HttpError } from "./errors.js";

export type Role = "contributor" | "moderator";

export interface CurrentUser {
  id: number;
  username: string;
  display_name: string;
  country: string;
  roles: Role[];
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function loadUser(db: DB, id: number): CurrentUser | null {
  const u = db.prepare("SELECT id, username, display_name, country FROM users WHERE id = ?").get(id) as any;
  if (!u) return null;
  const roles = db.prepare("SELECT role FROM user_roles WHERE user_id = ?").all(id).map((r: any) => r.role as Role);
  return { ...u, roles };
}

export function hasRole(user: CurrentUser | null, role: Role): boolean {
  if (!user) return false;
  if (role === "contributor") return user.roles.includes("contributor") || user.roles.includes("moderator");
  return user.roles.includes(role);
}

export function requireUser(user: CurrentUser | null): CurrentUser {
  if (!user) throw new HttpError(401, "Please sign in to continue.");
  return user;
}

export function requireRole(user: CurrentUser | null, role: Role): CurrentUser {
  const u = requireUser(user);
  if (!hasRole(u, role)) throw forbidden(`This action requires the ${role} role.`);
  return u;
}

// ───────── Sessions (server-side, token hashed at rest) ─────────
const SESSION_DAYS = 14;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface SessionRow {
  id: string;
  user_id: number | null;
  csrf_token: string;
  flash: string | null;
}

export function createSession(db: DB, clock: Clock, userId: number | null): { token: string; session: SessionRow } {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = clock.now();
  const session: SessionRow = {
    id: sha256(token),
    user_id: userId,
    csrf_token: crypto.randomBytes(24).toString("base64url"),
    flash: null,
  };
  db.prepare("INSERT INTO sessions (id, user_id, csrf_token, flash, created_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?)").run(
    session.id,
    userId,
    session.csrf_token,
    iso(now),
    iso(new Date(now.getTime() + SESSION_DAYS * 86400_000)),
  );
  return { token, session };
}

export function findSession(db: DB, clock: Clock, token: string | undefined): SessionRow | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT id, user_id, csrf_token, flash FROM sessions WHERE id = ? AND expires_at > ?")
    .get(sha256(token), iso(clock.now())) as SessionRow | undefined;
  return row ?? null;
}

export function destroySession(db: DB, sessionId: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}
