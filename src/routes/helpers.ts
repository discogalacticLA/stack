import type { Request, Response } from "express";
import { requireUser } from "../lib/auth.js";
import { notFound } from "../lib/errors.js";
import { layout, type PageOpts } from "../views/layout.js";

export function page(req: Request, res: Response, opts: PageOpts, status = 200) {
  res.status(status).type("html").send(layout(req, opts));
}

/** The signed-in user, or a 401 (GET requests redirect to sign-in). */
export const me = (req: Request) => requireUser(req.state.user);

export function idParam(req: Request, name = "id"): number {
  const n = Number(req.params[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound();
  return n;
}

export const db = (req: Request) => req.state.app.db;
export const clock = (req: Request) => req.state.app.clock;
