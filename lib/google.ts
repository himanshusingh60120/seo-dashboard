// lib/google.ts
// Server-only wrappers for the Search Console and GA4 APIs.
import { HttpError } from "./token";
import { GSC_TZ, addDays, gscFallbackEnd, todayIn, windowEnding, type Compare } from "./dates";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON in/out. Retries 5xx, and 429 unless the caller says a 429 means "daily quota used up". */
async function g<T = any>(token: string, url: string, init: RequestInit = {}, opts: { retry429?: boolean } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { message: text.slice(0, 300) } };
    }
    if (res.ok) return data as T;
    const retry = res.status >= 500 || (res.status === 429 && opts.retry429 !== false);
    if (retry && attempt < 2) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    throw new HttpError(res.status, data?.error?.message || `Google API error ${res.status}`);
  }
}

/* ---------------- Search Console ---------------- */

const GSC = "https://searchconsole.googleapis.com";
const enc = encodeURIComponent;

export type Site = { siteUrl: string; permissionLevel: string };

export async function listSites(token: string): Promise<Site[]> {
  const data = await g<{ siteEntry?: Site[] }>(token, `${GSC}/webmasters/v3/sites`);
  return (data.siteEntry || []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

const siteCache = new Map<string, { at: number; sites: Set<string> }>();

/** Throws 403 unless the signed-in Google account can read this Search Console property. */
export async function assertSiteAccess(token: string, siteUrl: string) {
  if (!siteUrl) throw new HttpError(400, "Missing site");
  const k = token.slice(-32);
  let c = siteCache.get(k);
  if (!c || Date.now() - c.at > 5 * 60_000) {
    if (siteCache.size > 200) siteCache.clear();
    c = { at: Date.now(), sites: new Set((await listSites(token)).map((s) => s.siteUrl)) };
    siteCache.set(k, c);
  }
  if (!c.sites.has(siteUrl)) throw new HttpError(403, "Your Google account doesn't have access to this Search Console property.");
}

export type SARow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
export type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
export type SABody = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
  type?: SearchType;
  dataState?: "final" | "all" | "HOURLY_ALL";
  aggregationType?: "auto" | "byPage" | "byProperty";
  dimensionFilterGroups?: unknown[];
};

/** The exact body sent to searchAnalytics.query (defaults included), for the evidence log. */
export const saRequest = (body: SABody) => ({ type: "web" as SearchType, dataState: "final" as SABody["dataState"], ...body });
export const saEndpoint = (siteUrl: string) => `POST ${GSC}/webmasters/v3/sites/${enc(siteUrl)}/searchAnalytics/query`;

export async function searchAnalytics(token: string, siteUrl: string, body: SABody): Promise<SARow[]> {
  const data = await g<{ rows?: SARow[] }>(token, `${GSC}/webmasters/v3/sites/${enc(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    body: JSON.stringify(saRequest(body)),
  });
  return data.rows || [];
}

const PAGE = 25_000;
export const MAX_ROWS = 50_000;

/** Pages through results 25,000 rows at a time, up to maxRows. */
export async function searchAnalyticsAll(token: string, siteUrl: string, body: SABody, maxRows = MAX_ROWS): Promise<SARow[]> {
  const out: SARow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += PAGE) {
    const rowLimit = Math.min(PAGE, maxRows - startRow);
    const rows = await searchAnalytics(token, siteUrl, { ...body, rowLimit, startRow });
    out.push(...rows);
    if (rows.length < rowLimit) break;
  }
  return out;
}

const finalCache = new Map<string, { at: number; date: string }>();

/**
 * Latest day with final (complete) data, looked up per property instead of guessed.
 * Falls back to "3 days ago, Pacific Time" for small sites with gaps.
 */
export async function latestFinalDate(token: string, siteUrl: string, type: SearchType = "web") {
  const k = `${siteUrl}|${type}`;
  const hit = finalCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.date;
  const fallback = gscFallbackEnd();
  let date = fallback;
  try {
    const end = todayIn(GSC_TZ);
    const rows = await searchAnalytics(token, siteUrl, { startDate: addDays(end, -10), endDate: end, dimensions: ["date"], type, dataState: "final", rowLimit: 20 });
    const max = rows.map((r) => r.keys[0]).sort().pop();
    if (max && max >= addDays(fallback, -2)) date = max;
  } catch {
    /* keep the fallback */
  }
  finalCache.set(k, { at: Date.now(), date });
  return date;
}

export async function gscWindow(token: string, siteUrl: string, days: number, compare: Compare = "previous", type: SearchType = "web") {
  const end = await latestFinalDate(token, siteUrl, type);
  return { ...windowEnding(end, days, compare), dataThrough: end };
}

export type SitemapInfo = {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings?: string;
  errors?: string;
  contents?: { type?: string; submitted?: string; indexed?: string }[];
};

export async function listSitemaps(token: string, siteUrl: string): Promise<SitemapInfo[]> {
  const data = await g<{ sitemap?: SitemapInfo[] }>(token, `${GSC}/webmasters/v3/sites/${enc(siteUrl)}/sitemaps`);
  return data.sitemap || [];
}

export type InspectionResult = {
  url: string;
  verdict: string;
  coverageState: string;
  indexingState: string;
  pageFetchState: string;
  robotsTxtState: string;
  lastCrawlTime: string;
  googleCanonical: string;
  userCanonical: string;
  crawledAs: string;
  sitemaps: string[];
  referringUrls: string[];
  richIssues: { type: string; severity: string; message: string }[];
  link: string;
  checkedAt: string;
};

export const INSPECT_ENDPOINT = `POST ${GSC}/v1/urlInspection/index:inspect`;

/** A 429 here means the daily quota is used up, so it isn't retried. */
export async function inspectUrl(token: string, siteUrl: string, inspectionUrl: string): Promise<InspectionResult> {
  const data = await g<any>(
    token,
    `${GSC}/v1/urlInspection/index:inspect`,
    { method: "POST", body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: "en-US" }) },
    { retry429: false }
  );
  const ir = data?.inspectionResult || {};
  const r = ir.indexStatusResult || {};
  const rich = (ir.richResultsResult?.detectedItems || []).flatMap((d: any) =>
    (d.items || []).flatMap((it: any) =>
      (it.issues || []).map((i: any) => ({ type: String(d.richResultType || ""), severity: String(i.severity || ""), message: String(i.issueMessage || "") }))
    )
  );
  return {
    url: inspectionUrl,
    verdict: r.verdict || "VERDICT_UNSPECIFIED",
    coverageState: r.coverageState || "Unknown",
    indexingState: r.indexingState || "",
    pageFetchState: r.pageFetchState || "",
    robotsTxtState: r.robotsTxtState || "",
    lastCrawlTime: r.lastCrawlTime || "",
    googleCanonical: r.googleCanonical || "",
    userCanonical: r.userCanonical || "",
    crawledAs: r.crawledAs || "",
    sitemaps: (r.sitemap || []).slice(0, 5),
    referringUrls: (r.referringUrls || []).slice(0, 5),
    richIssues: rich.slice(0, 10),
    link: ir.inspectionResultLink || "",
    checkedAt: new Date().toISOString(),
  };
}

export function errorInspection(url: string, message: string): InspectionResult {
  return {
    url, verdict: "ERROR", coverageState: message, indexingState: "", pageFetchState: "", robotsTxtState: "", lastCrawlTime: "",
    googleCanonical: "", userCanonical: "", crawledAs: "", sitemaps: [], referringUrls: [], richIssues: [], link: "",
    checkedAt: new Date().toISOString(),
  };
}

/* ---------------- Google Analytics 4 ---------------- */

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

export const ga4Endpoint = (propertyId: string, realtime = false) =>
  `POST ${DATA}/properties/${propertyId}:${realtime ? "runRealtimeReport" : "runReport"}`;

export async function listGa4Properties(token: string) {
  const out: { id: string; name: string; account: string }[] = [];
  let pageToken = "";
  do {
    const data = await g<any>(token, `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${enc(pageToken)}` : ""}`);
    for (const acc of data.accountSummaries || []) {
      for (const p of acc.propertySummaries || []) {
        out.push({ id: String(p.property).replace("properties/", ""), name: p.displayName, account: acc.displayName });
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

export async function listWebStreamHosts(token: string, propertyId: string): Promise<string[]> {
  try {
    const data = await g<any>(token, `${ADMIN}/properties/${propertyId}/dataStreams?pageSize=50`);
    return (data.dataStreams || []).map((s: any) => s.webStreamData?.defaultUri).filter(Boolean).map((u: string) => normalizeHost(u));
  } catch {
    return [];
  }
}

export function normalizeHost(u: string) {
  const s = u.replace(/^sc-domain:/, "");
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return s.replace(/^www\./, "").toLowerCase();
  }
}

const tzCache = new Map<string, string>();

/** The property's reporting time zone, so date windows match the GA4 interface. */
export async function ga4TimeZone(token: string, propertyId: string) {
  const hit = tzCache.get(propertyId);
  if (hit) return hit;
  try {
    const p = await g<any>(token, `${ADMIN}/properties/${propertyId}`);
    if (p?.timeZone) {
      tzCache.set(propertyId, String(p.timeZone));
      return String(p.timeZone);
    }
  } catch {
    /* fall back to UTC */
  }
  return "UTC";
}

/** Full days ending yesterday in the property's time zone — the same as GA4's "Last N days". */
export async function ga4Window(token: string, propertyId: string, days: number, compare: Compare = "previous") {
  const timeZone = await ga4TimeZone(token, propertyId);
  return { ...windowEnding(addDays(todayIn(timeZone), -1), days, compare), timeZone };
}

export type GaReport = { rows: { dims: string[]; mets: number[] }[]; totals: number[] };

export async function runReport(token: string, propertyId: string, body: Record<string, unknown>): Promise<GaReport> {
  return parseGa(await g<any>(token, `${DATA}/properties/${propertyId}:runReport`, { method: "POST", body: JSON.stringify(body) }));
}

export async function runRealtime(token: string, propertyId: string, body: Record<string, unknown>): Promise<GaReport> {
  return parseGa(await g<any>(token, `${DATA}/properties/${propertyId}:runRealtimeReport`, { method: "POST", body: JSON.stringify(body) }));
}

function parseGa(data: any): GaReport {
  return {
    rows: (data.rows || []).map((r: any) => ({
      dims: (r.dimensionValues || []).map((d: any) => d.value),
      mets: (r.metricValues || []).map((m: any) => Number(m.value)),
    })),
    totals: (data.totals?.[0]?.metricValues || []).map((m: any) => Number(m.value)),
  };
}
