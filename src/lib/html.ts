/**
 * Minimal auto-escaping HTML templating.
 * html`<p>${value}</p>` escapes `value` unless it is SafeHtml (from another html`` call or raw()).
 * Arrays are flattened; null/undefined/false render as nothing.
 */
export class SafeHtml {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Value = unknown;

function render(v: Value): string {
  if (v == null || v === false || v === true) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Only for trusted, already-safe markup (e.g. generated SVG with escaped text). */
export const raw = (s: string) => new SafeHtml(s);

export function attrs(obj: Record<string, string | number | boolean | null | undefined>): SafeHtml {
  return raw(
    Object.entries(obj)
      .filter(([, v]) => v !== false && v != null)
      .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`))
      .join(""),
  );
}
