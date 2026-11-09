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
  /** More links into Google's interface (for example one report per metric). */
  links?: { label: string; url: string }[];
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

type Range = { startDate: string; endDate: string };
const compactDate = (d: string) => d.replace(/-/g, "");

/** Search Console Performance report for the same property and dates. */
export function gscPerformanceUrl(siteUrl: string, range: Range, breakdown?: "query" | "page" | "date") {
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

export function ga4RealtimeUrl(propertyId: string) {
  return `https://analytics.google.com/analytics/web/#/p${propertyId}/realtime/overview`;
}

export type Ga4Report = "traffic" | "pages" | "country" | "city" | "device";

/** GA4's standard detail reports (Life cycle and User collections). */
const GA4_REPORTS: Record<Ga4Report, { r: string; ruid: string; collection: string; seldim?: string; name: string }> = {
  traffic: { r: "lifecycle-traffic-acquisition-v2", ruid: "lifecycle-traffic-acquisition-v2,life-cycle,acquisition", collection: "life-cycle", name: "Traffic acquisition" },
  pages: { r: "all-pages-and-screens", ruid: "all-pages-and-screens,life-cycle,engagement", collection: "life-cycle", name: "Pages and screens" },
  country: { r: "user-demographics-detail", ruid: "user-demographics-detail,user,demographics", collection: "user", seldim: "country", name: "Demographic details (Country)" },
  city: { r: "user-demographics-detail", ruid: "user-demographics-detail,user,demographics", collection: "user", seldim: "city", name: "Demographic details (City)" },
  device: { r: "user-technology-detail", ruid: "user-technology-detail,user,technology", collection: "user", seldim: "deviceCategory", name: "Tech details (Device category)" },
};

export const ga4ReportName = (r: Ga4Report) => GA4_REPORTS[r].name;

/**
 * Deep link into a GA4 report, opened on the same dates as the dashboard
 * (and the comparison dates, when given). Dates are in the property's time zone, like GA4 itself.
 */
export function ga4ReportUrl(propertyId: string, report: Ga4Report, range: Range, compare?: Range | null) {
  const g = GA4_REPORTS[report];
  const params = [
    "_u..nav=maui",
    `_u.date00=${compactDate(range.startDate)}`,
    `_u.date01=${compactDate(range.endDate)}`,
    ...(compare ? [`_u.date10=${compactDate(compare.startDate)}`, `_u.date11=${compactDate(compare.endDate)}`] : []),
    ...(g.seldim ? [`_r.explorerCard..seldim=${JSON.stringify([g.seldim])}`] : []),
  ].join("&");
  return `https://analytics.google.com/analytics/web/#/p${propertyId}/reports/explorer?params=${encodeURIComponent(params)}&r=${g.r}&ruid=${g.ruid}&collectionId=${g.collection}`;
}
