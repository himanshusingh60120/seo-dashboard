// lib/provenance.ts
/**
 * Provenance: a record of where each number in the dashboard came from.
 * Every Google API call made by a route is logged as a Source, and every figure
 * the dashboard calculates itself is logged as a computed Source that names its inputs.
 */

export type Source = {
  id: string;
  label: string;
  /** Which system produced the data. */
  system: string;
  /** HTTP method and URL of the API call. Empty for computed figures. */
  endpoint?: string;
  /** The exact request body sent to the API. */
  request?: unknown;
  /** Date range the data covers, when there is one. */
  range?: { startDate: string; endDate: string };
  /** When the data was retrieved (ISO). */
  fetchedAt: string;
  rowCount?: number;
  /** Full API response for small results, or the first rows for large ones. */
  response?: unknown;
  responseIsSample?: boolean;
  /** Where to see the same number in Google's own interface. */
  verifyUrl?: string;
  verifyLabel?: string;
  /** Plain-language steps to reproduce the number. */
  verifyHow?: string;
  /** Official Google tool that can rerun the exact request. */
  explorerUrl?: string;
  explorerLabel?: string;
  /** For computed figures: the rule used and the sources it was calculated from. */
  formula?: string;
  derivedFrom?: string[];
};

export type Sources = Record<string, Source>;

const FULL_RESPONSE_MAX_ROWS = 400;

export class Recorder {
  sources: Sources = {};

  add(s: Source) {
    this.sources[s.id] = s;
  }

  /** Runs an API call and records it. `rows` extracts the row list for counting and sampling. */
  async call<T>(meta: Omit<Source, "fetchedAt" | "rowCount" | "response" | "responseIsSample">, fn: () => Promise<T>, rows: (r: T) => unknown[]): Promise<T> {
    const fetchedAt = new Date().toISOString();
    const result = await fn();
    const list = rows(result) || [];
    this.add({
      ...meta,
      fetchedAt,
      rowCount: list.length,
      response: list.length <= FULL_RESPONSE_MAX_ROWS ? list : list.slice(0, 5),
      responseIsSample: list.length > FULL_RESPONSE_MAX_ROWS,
    });
    return result;
  }

  computed(id: string, label: string, formula: string, derivedFrom: string[]) {
    this.add({ id, label, system: "Calculated by this dashboard", fetchedAt: new Date().toISOString(), formula, derivedFrom });
  }
}

/* ---------- Links to Google's own interfaces ---------- */

const compactDate = (d: string) => d.replace(/-/g, "");

/** Search Console Performance report for the same property and dates. */
export function gscPerformanceUrl(siteUrl: string, range: { startDate: string; endDate: string }, breakdown?: "query" | "page" | "date") {
  const p = new URLSearchParams({
    resource_id: siteUrl,
    start_date: compactDate(range.startDate),
    end_date: compactDate(range.endDate),
  });
  if (breakdown) p.set("breakdown", breakdown);
  return `https://search.google.com/search-console/performance/search-analytics?${p.toString()}`;
}

export const GSC_EXPLORER = "https://developers.google.com/webmaster-tools/v1/searchanalytics/query";
export const GA4_EXPLORER = "https://ga-dev-tools.google/ga4/query-explorer/";

export function ga4HomeUrl(propertyId: string) {
  return `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/intelligenthome`;
}
