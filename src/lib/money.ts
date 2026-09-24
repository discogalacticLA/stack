/**
 * Money is always an integer number of minor units (cents) plus a currency code.
 * No floating-point arithmetic is used for totals.
 */
export const DEMO_CURRENCY = "USD";
export const DEMO_CURRENCY_LABEL = "USD (demo currency — no real money)";

export function formatMoney(cents: number, currency = DEMO_CURRENCY): string {
  if (!Number.isInteger(cents)) throw new Error("Money must be integer minor units");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100).toString().padStart(2, "0");
  const symbol = currency === "USD" ? "$" : "";
  return `${sign}${symbol}${whole}.${frac}${symbol ? "" : " " + currency}`;
}

/** Parses user input like "12", "12.5", "12.50", "1,200.00" into cents. Returns null if invalid. */
export function parseMoneyToCents(input: string): number | null {
  const s = input.trim().replace(/,/g, "").replace(/^\$/, "");
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

export function sumCents(values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new Error("Invalid money amount");
    total += v;
  }
  return total;
}

export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return `${Math.floor(cents / 100)}.${(cents % 100).toString().padStart(2, "0")}`;
}
