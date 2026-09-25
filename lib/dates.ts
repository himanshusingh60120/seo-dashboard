const iso = (d: Date) => d.toISOString().slice(0, 10);

function addDays(d: Date, n: number) {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

/**
 * Search Console data lags ~2-3 days, so GSC ranges end 3 days ago.
 * GA4 ranges end today. Previous period = same length immediately before.
 */
export function ranges(days: number, source: "gsc" | "ga4") {
  const end = addDays(new Date(), source === "gsc" ? -3 : 0);
  const start = addDays(end, -(days - 1));
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return {
    current: { startDate: iso(start), endDate: iso(end) },
    previous: { startDate: iso(prevStart), endDate: iso(prevEnd) },
  };
}

export function parseDays(v: string | null) {
  const n = Number(v);
  return [7, 28, 90, 180].includes(n) ? n : 28;
}
