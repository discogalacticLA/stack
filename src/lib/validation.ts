import { z } from "zod";
import { parseMoneyToCents } from "./money.js";

export type FieldErrors = Record<string, string>;

export class ValidationError extends Error {
  constructor(public fields: FieldErrors, message = "Please correct the highlighted fields.") {
    super(message);
  }
}

/** Parses with zod and throws ValidationError with one message per field. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(normalizeFormInput(input));
  if (result.success) return result.data;
  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_form";
    if (!fields[key]) fields[key] = issue.message;
  }
  throw new ValidationError(fields);
}

/**
 * HTML forms send strings. Programmatic callers (seed, tests, stored payloads) may pass
 * numbers or nulls; normalise them shallowly to the same shape a browser would send.
 */
function normalizeFormInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === null) out[k] = undefined;
    else if (typeof v === "number") out[k] = String(v);
    else out[k] = v;
  }
  return out;
}

// ───────── Reusable field helpers for HTML form input (strings) ─────────
export const trimmed = (max = 500) => z.string().trim().max(max, `Keep this under ${max} characters.`);

export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : null));

export const requiredText = (label: string, max = 500) =>
  z.string({ error: `${label} is required.` }).trim().min(1, `${label} is required.`).max(max, `Keep this under ${max} characters.`);

export const optionalInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      if (!/^-?\d+$/.test(v)) {
        ctx.addIssue({ code: "custom", message: `${label} must be a whole number.` });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `${label} must be between ${min} and ${max}.` });
        return z.NEVER;
      }
      return n;
    });

export const moneyField = (label: string, { required }: { required: boolean }) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) {
        if (required) {
          ctx.addIssue({ code: "custom", message: `${label} is required.` });
          return z.NEVER;
        }
        return null;
      }
      const cents = parseMoneyToCents(v);
      if (cents == null) {
        ctx.addIssue({ code: "custom", message: `${label} must be an amount like 18 or 18.50.` });
        return z.NEVER;
      }
      return cents;
    });

export const isoDateOptional = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: "custom", message: "Use a date like 2024-05-31." });
      return z.NEVER;
    }
    return v;
  });

/** Normalises form values that may be a single string or an array into string[]. */
export function asArray(v: unknown): string[] {
  if (v == null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter((s) => s.length > 0);
}

export function asIdArray(v: unknown): number[] {
  return asArray(v)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}
