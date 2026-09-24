import type { Request } from "express";
import { attrs, html, raw, type SafeHtml } from "../lib/html.js";
import { formatMoney } from "../lib/money.js";
import { conditionLabel, VERIFICATION } from "../lib/reference.js";
import type { FieldErrors } from "../lib/validation.js";

export const money = (cents: number | null | undefined, currency = "USD") => (cents == null ? "—" : formatMoney(cents, currency));

export function csrf(req: Request) {
  return html`<input type="hidden" name="_csrf" value="${req.state.session.csrf_token}">`;
}

/** Artwork: an archive image, or an explicit "no image" tile (missing info is shown honestly). */
export function cover(imageId: number | null | undefined, alt: string, opts: { size?: "sm" | "md" | "lg"; lazy?: boolean } = {}) {
  const cls = `cover cover-${opts.size ?? "md"}`;
  if (!imageId) return html`<div class="${cls} cover-missing" role="img" aria-label="No archive image for ${alt}"><span>No archive image</span></div>`;
  return html`<img class="${cls}" src="/media/archive/${imageId}" alt="Archive image: ${alt}"${attrs({ loading: opts.lazy === false ? null : "lazy" })} width="300" height="300">`;
}

export function copyPhoto(photoId: number, alt: string, size: "sm" | "md" | "lg" = "md") {
  return html`<figure class="copy-photo copy-photo-${size}"><img src="/media/copy-photo/${photoId}" alt="Photo of this actual copy: ${alt}" loading="lazy" width="300" height="300"><figcaption>Actual copy photo</figcaption></figure>`;
}

export function verificationBadge(status: string, withExplain = false) {
  const v = VERIFICATION[status] ?? VERIFICATION.unverified;
  return html`<span class="badge verify verify-${status}" title="${v.explain}">${v.label}</span>${withExplain ? html` <span class="muted small">${v.explain}</span>` : ""}`;
}

export function statusBadge(status: string, label?: string) {
  return html`<span class="badge status status-${status}">${label ?? status.replace(/_/g, " ")}</span>`;
}

export function grade(code: string) {
  return html`<abbr class="grade" title="${conditionLabel(code)}">${code === "GENERIC" ? "Generic" : code === "NONE" ? "None" : code}</abbr>`;
}

export function flashes(req: Request) {
  if (!req.state.flash.length) return "";
  return html`<div class="flashes">${req.state.flash.map(
    (f) => html`<div class="flash flash-${f.kind}" role="${f.kind === "error" ? "alert" : "status"}">${f.message}</div>`,
  )}</div>`;
}

export function errorSummary(errors?: FieldErrors, message = "Please correct the highlighted fields.") {
  if (!errors || !Object.keys(errors).length) return "";
  return html`<div class="flash flash-error" role="alert" tabindex="-1" id="error-summary">
    <strong>${message}</strong>
    <ul>${Object.entries(errors).map(([k, v]) => html`<li>${k === "_form" ? "" : html`<a href="#f-${k}">${fieldName(k)}</a>: `}${v}</li>`)}</ul>
  </div>`;
}

const fieldName = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// ───────── Form controls (every control has a real <label>) ─────────
interface FieldOpts {
  label: string;
  name: string;
  errors?: FieldErrors;
  hint?: string | SafeHtml;
  required?: boolean;
}

function wrap(o: FieldOpts, control: SafeHtml) {
  const err = o.errors?.[o.name];
  return html`<div class="field${err ? " has-error" : ""}">
    <label for="f-${o.name}">${o.label}${o.required ? html` <span class="req" aria-hidden="true">*</span>` : ""}</label>
    ${o.hint ? html`<p class="hint" id="h-${o.name}">${o.hint}</p>` : ""}
    ${control}
    ${err ? html`<p class="error-text" id="e-${o.name}">${err}</p>` : ""}
  </div>`;
}

function described(o: FieldOpts) {
  const ids = [o.hint ? `h-${o.name}` : "", o.errors?.[o.name] ? `e-${o.name}` : ""].filter(Boolean).join(" ");
  return attrs({ "aria-describedby": ids || null, "aria-invalid": o.errors?.[o.name] ? "true" : null, required: o.required ?? null });
}

export function textField(o: FieldOpts & { value?: unknown; type?: string; placeholder?: string; inputmode?: string; autocomplete?: string }) {
  return wrap(
    o,
    html`<input id="f-${o.name}" name="${o.name}" type="${o.type ?? "text"}" value="${o.value ?? ""}"${attrs({ placeholder: o.placeholder, inputmode: o.inputmode, autocomplete: o.autocomplete })}${described(o)}>`,
  );
}

export function textArea(o: FieldOpts & { value?: unknown; rows?: number; mono?: boolean }) {
  return wrap(o, html`<textarea id="f-${o.name}" name="${o.name}" rows="${o.rows ?? 4}"${attrs({ class: o.mono ? "mono" : null })}${described(o)}>${o.value ?? ""}</textarea>`);
}

export function selectField(o: FieldOpts & { value?: unknown; options: { value: string; label: string }[]; blank?: string }) {
  const v = o.value == null ? "" : String(o.value);
  return wrap(
    o,
    html`<select id="f-${o.name}" name="${o.name}"${described(o)}>
      ${o.blank != null ? html`<option value="">${o.blank}</option>` : ""}
      ${o.options.map((opt) => html`<option value="${opt.value}"${opt.value === v ? raw(" selected") : ""}>${opt.label}</option>`)}
    </select>`,
  );
}

export function pagination(basePath: string, params: URLSearchParams, page: number, total: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return "";
  const link = (p: number) => {
    const q = new URLSearchParams(params);
    q.set("page", String(p));
    return `${basePath}?${q}`;
  };
  return html`<nav class="pagination" aria-label="Pagination">
    ${page > 1 ? html`<a class="btn btn-quiet" href="${link(page - 1)}" rel="prev">← Previous</a>` : html`<span></span>`}
    <span>Page ${page} of ${pages}</span>
    ${page < pages ? html`<a class="btn btn-quiet" href="${link(page + 1)}" rel="next">Next →</a>` : html`<span></span>`}
  </nav>`;
}

export function simulatedNotice(text = "Simulated transaction — no real money moves and no messages are sent.") {
  return html`<p class="sim-notice" role="note"><strong>Simulated</strong> ${text}</p>`;
}

/** Safe "return to results" link: only same-site relative paths are accepted. */
export function safeBack(value: unknown, fallback = "/"): string {
  const s = typeof value === "string" ? value : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.includes("\\") ? s : fallback;
}
