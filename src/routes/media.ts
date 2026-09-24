import fs from "node:fs";
import type { Express, Response } from "express";
import type { AppContext } from "../context.js";
import { notFound } from "../lib/errors.js";
import { archiveArtSvg, copyPhotoSvg } from "../lib/placeholderArt.js";
import { resolveUpload } from "../lib/uploads.js";
import { creditForRelease } from "../domain/catalog.js";
import { idParam } from "./helpers.js";

const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

function sendUpload(res: Response, uploadDir: string, rel: string) {
  const abs = resolveUpload(uploadDir, rel);
  if (!fs.existsSync(abs)) throw notFound("Image");
  res.type(MIME[rel.split(".").pop() ?? ""] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(abs);
}

function sendSvg(res: Response, svg: string, cache: "public" | "private") {
  res.type("image/svg+xml");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader("Cache-Control", `${cache}, max-age=86400`);
  res.send(svg);
}

export function registerMediaRoutes(app: Express, ctx: AppContext) {
  // Archive images are public.
  app.get("/media/archive/:id", (req, res) => {
    const img = ctx.db
      .prepare("SELECT ai.*, e.master_id, e.title, e.catalog_number FROM archive_images ai JOIN releases e ON e.id = ai.release_id WHERE ai.id = ?")
      .get(idParam(req)) as any;
    if (!img) throw notFound("Image");
    if (img.storage_path) return sendUpload(res, ctx.config.uploadDir, img.storage_path);
    sendSvg(res, archiveArtSvg(img.placeholder_seed ?? String(img.id), img.title, creditForRelease(ctx.db, { id: img.release_id, master_id: img.master_id })), "public");
  });

  // Copy photos are private unless shown on a public listing or part of the viewer's order.
  app.get("/media/copy-photo/:id", (req, res) => {
    const id = idParam(req);
    const photo = ctx.db.prepare("SELECT p.*, c.owner_id FROM copy_photos p JOIN copies c ON c.id = p.copy_id WHERE p.id = ?").get(id) as any;
    if (!photo) throw notFound("Image");
    const uid = req.state.user?.id ?? -1;
    const isOwner = photo.owner_id === uid && !photo.deleted_at;
    const onPublicListing =
      !photo.deleted_at &&
      !!ctx.db
        .prepare("SELECT 1 FROM listing_photos lp JOIN listings l ON l.id = lp.listing_id WHERE lp.copy_photo_id = ? AND l.status IN ('available','reserved','sold')")
        .get(id);
    const inViewersOrder = !!ctx.db
      .prepare(
        `SELECT 1 FROM order_lines ol JOIN orders o ON o.id = ol.order_id, json_each(ol.photo_ids_snapshot) j
         WHERE j.value = ? AND (o.buyer_id = ? OR o.seller_id = ?)`,
      )
      .get(id, uid, uid);
    if (!isOwner && !onPublicListing && !inViewersOrder) throw notFound("Image");
    if (photo.storage_path) return sendUpload(res, ctx.config.uploadDir, photo.storage_path);
    sendSvg(res, copyPhotoSvg(photo.placeholder_seed ?? String(photo.id), photo.caption ?? "copy"), "private");
  });

  // Supporting images on proposals: the proposer and moderators only.
  app.get("/media/proposal-image/:id", (req, res) => {
    const img = ctx.db.prepare("SELECT pi.*, p.proposed_by FROM proposal_images pi JOIN proposals p ON p.id = pi.proposal_id WHERE pi.id = ?").get(idParam(req)) as any;
    const u = req.state.user;
    if (!img || !u || (img.proposed_by !== u.id && !u.roles.includes("moderator"))) throw notFound("Image");
    sendUpload(res, ctx.config.uploadDir, img.storage_path);
  });
}
