// lib/dates.ts
export type Compare = "previous" | "yoy";
export type Range = { startDate: string; endDate: string };

export const WINDOWS = [7, 15, 30] as const;
export const DEFAULT_DAYS = 30;
export const YOY_MAX_DAYS = 90;
/** 52 weeks back, so weekdays line up. */
export const YOY_SHIFT_DAYS = 364;
/** Search Console dates are Pacific Time. */
export const GSC_TZ = "America/Los_Angeles";

export const yoyAllowed = (days: number) => days <= YOY_MAX_DAYS;

export function parseDays(v: string | null | undefined) {
  const n = Number(v);
  return (WINDOWS as readonly number[]).includes(n) ? n : DEFAULT_DAYS;
}

export function parseCompare(v: string | null | undefined, days: number): Compare {
  return v === "yoy" && yoyAllowed(days) ? "yoy" : "previous";
}

/** Today's calendar date (YYYY-MM-DD) in a time zone. */
export function todayIn(tz: string, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `days` full days ending on `end`, plus a comparison window of the same length. */
export function windowEnding(end: string, days: number, compare: Compare = "previous"): { current: Range; previous: Range } {
  const start = addDays(end, -(days - 1));
  const previous =
    compare === "yoy"
      ? { startDate: addDays(start, -YOY_SHIFT_DAYS), endDate: addDays(end, -YOY_SHIFT_DAYS) }
      : { startDate: addDays(start, -days), endDate: addDays(start, -1) };
  return { current: { startDate: start, endDate: end }, previous };
}

/** Only used when the latest final day can't be looked up. */
export const gscFallbackEnd = () => addDays(todayIn(GSC_TZ), -3);

export const periodName = (days: number) => `last ${days} days`;
export const compareName = (days: number, compare: Compare) =>
  compare === "yoy" ? "the same days a year earlier (52 weeks back)" : `the previous ${days} days`;

/** @deprecated Kept for older imports. Use gscWindow / ga4Window from lib/google.ts. */
export function ranges(days: number, source: "gsc" | "ga4", compare: Compare = "previous") {
  const end = source === "gsc" ? gscFallbackEnd() : addDays(todayIn("UTC"), -1);
  return windowEnding(end, days, compare);
}
