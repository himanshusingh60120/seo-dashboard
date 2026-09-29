const iso = (d: Date) => d.toISOString().slice(0, 10);

function addDays(d: Date, n: number) {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

function minusYear(d: Date) {
  const c = new Date(d);
  c.setUTCFullYear(c.getUTCFullYear() - 1);
  return c;
}

/** What the current period is compared with. */
export type Compare = "previous" | "yoy";

/** Search Console keeps 16 months, so year-over-year only fits periods up to 3 months. */
export const YOY_MAX_DAYS = 90;
export const yoyAllowed = (days: number) => days <= YOY_MAX_DAYS;

/**
 * Search Console data lags ~2-3 days, so GSC ranges end 3 days ago.
 * GA4 ranges end today.
 * "previous": the same number of days immediately before.
 * "yoy": the same dates one year earlier.
 */
export function ranges(days: number, source: "gsc" | "ga4", compare: Compare = "previous") {
  const end = addDays(new Date(), source === "gsc" ? -3 : 0);
  const start = addDays(end, -(days - 1));
  const prevEnd = compare === "yoy" ? minusYear(end) : addDays(start, -1);
  const prevStart = compare === "yoy" ? minusYear(start) : addDays(prevEnd, -(days - 1));
  return {
    current: { startDate: iso(start), endDate: iso(end) },
    previous: { startDate: iso(prevStart), endDate: iso(prevEnd) },
  };
}

export function parseDays(v: string | null) {
  const n = Number(v);
  return [7, 28, 90, 180].includes(n) ? n : 28;
}

/** Falls back to "previous" when year-over-year would reach past Search Console's 16 months. */
export function parseCompare(v: string | null, days: number): Compare {
  return v === "yoy" && yoyAllowed(days) ? "yoy" : "previous";
}

export const periodName = (days: number) =>
  ({ 7: "last 7 days", 28: "last 28 days", 90: "last 3 months", 180: "last 6 months" } as Record<number, string>)[days] || `last ${days} days`;

export const compareName = (days: number, compare: Compare) =>
  compare === "yoy" ? "the same period last year" : `the previous ${periodName(days).replace(/^last /, "")}`;
