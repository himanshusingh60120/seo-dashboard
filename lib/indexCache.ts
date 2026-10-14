// lib/indexCache.ts
// Browser storage (IndexedDB) for the URL list, the latest URL Inspection result per URL, and index status changes.
import type { Inspection } from "./types";
import { kvDel, kvGet, kvSet } from "./idb";

export type UrlEntry = { url: string; sources: string[]; lastmod?: string };
export type InspectionRec = Inspection;
export type IndexCache = { urls: UrlEntry[]; sitemaps: string[]; inspected: Record<string, InspectionRec>; listedAt: string };
export type IndexEventType = "deindexed" | "indexed" | "fetch_error" | "recovered" | "canonical_changed";
export type IndexEvent = { at: string; url: string; type: IndexEventType; from: string; to: string; link: string };

export const EVENT_LABEL: Record<IndexEventType, string> = {
  deindexed: "Dropped from Google's index",
  indexed: "Newly indexed",
  fetch_error: "Crawl / fetch error",
  recovered: "Fetch recovered",
  canonical_changed: "Google changed the canonical",
};

const key = (site: string) => `dash:index:${site}`;
const evKey = (site: string) => `dash:events:${site}`;
const mem = new Map<string, IndexCache | null>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Accepts older saved formats (with site: results or raw responses) and keeps only what's used now. */
function tidy(c: any): IndexCache | null {
  if (!c) return null;
  const inspected: Record<string, InspectionRec> = {};
  for (const [u, r] of Object.entries<any>(c.inspected || {})) {
    inspected[u] = {
      url: u,
      verdict: r.verdict || "",
      coverageState: r.coverageState || "",
      indexingState: r.indexingState || "",
      pageFetchState: r.pageFetchState || "",
      robotsTxtState: r.robotsTxtState || "",
      lastCrawlTime: r.lastCrawlTime || "",
      googleCanonical: r.googleCanonical || "",
      userCanonical: r.userCanonical || "",
      crawledAs: r.crawledAs || "",
      sitemaps: r.sitemaps || [],
      referringUrls: r.referringUrls || [],
      richIssues: r.richIssues || [],
      link: r.link || "",
      checkedAt: r.checkedAt || new Date(0).toISOString(),
    };
  }
  return { urls: Array.isArray(c.urls) ? c.urls : [], sitemaps: Array.isArray(c.sitemaps) ? c.sitemaps : [], inspected, listedAt: c.listedAt || "" };
}

export const peekIndexCache = (site: string) => mem.get(site) ?? null;

export async function loadIndexCache(site: string): Promise<IndexCache | null> {
  if (mem.has(site)) return mem.get(site)!;
  let c: any = null;
  try {
    c = await kvGet(key(site));
  } catch {}
  if (!c) {
    try {
      const raw = localStorage.getItem(key(site)); // one-time move from the old localStorage copy
      if (raw) {
        c = JSON.parse(raw);
        localStorage.removeItem(key(site));
      }
    } catch {}
  }
  const t = tidy(c);
  mem.set(site, t);
  if (t) kvSet(key(site), t).catch(() => {});
  return t;
}

const write = (site: string) => {
  pending.delete(site);
  const c = mem.get(site);
  (c ? kvSet(key(site), c) : kvDel(key(site))).catch(() => {});
};

/** Updates memory now and writes to IndexedDB within 3 seconds (or immediately with `now`). */
export function saveIndexCache(site: string, c: IndexCache, now = false) {
  mem.set(site, c);
  const t = pending.get(site);
  if (t) clearTimeout(t);
  if (now) write(site);
  else pending.set(site, setTimeout(() => write(site), 3000));
}

export function flushIndexCache(site: string) {
  const t = pending.get(site);
  if (t) {
    clearTimeout(t);
    write(site);
  }
}

export async function clearIndexCache(site: string) {
  const t = pending.get(site);
  if (t) clearTimeout(t);
  pending.delete(site);
  mem.set(site, null);
  await kvDel(key(site)).catch(() => {});
}

export async function loadEvents(site: string): Promise<IndexEvent[]> {
  try {
    return (await kvGet<IndexEvent[]>(evKey(site))) || [];
  } catch {
    return [];
  }
}

export async function appendEvents(site: string, events: IndexEvent[]) {
  if (!events.length) return;
  const all = [...(await loadEvents(site)), ...events].slice(-5000);
  await kvSet(evKey(site), all).catch(() => {});
}

export const isIndexedVerdict = (v?: string) => v === "PASS" || v === "PARTIAL";
export const isNotIndexedVerdict = (v?: string) => !!v && v !== "ERROR" && !isIndexedVerdict(v);

const BAD_FETCH = new Set([
  "NOT_FOUND", "SOFT_404", "SERVER_ERROR", "REDIRECT_ERROR", "ACCESS_DENIED", "ACCESS_FORBIDDEN",
  "BLOCKED_4XX", "BLOCKED_ROBOTS_TXT", "INTERNAL_CRAWL_ERROR", "INVALID_URL",
]);
export const fetchProblem = (r?: InspectionRec) => !!r && BAD_FETCH.has(r.pageFetchState);

const statusOf = (r?: InspectionRec) =>
  !r || !r.verdict || r.verdict === "ERROR" ? "unknown" : isIndexedVerdict(r.verdict) ? "indexed" : "not_indexed";

/**
 * Merges new inspection results and returns the status changes they reveal.
 * A failed check never overwrites a good result, so errors can't create false "dropped" alerts.
 */
export function applyInspections(c: IndexCache, results: InspectionRec[]): { cache: IndexCache; events: IndexEvent[] } {
  const inspected = { ...c.inspected };
  const events: IndexEvent[] = [];
  for (const r of results) {
    const prev = inspected[r.url];
    if (r.verdict === "ERROR") {
      if (!prev || prev.verdict === "ERROR") inspected[r.url] = r;
      continue;
    }
    const add = (type: IndexEventType, from: string, to: string) => events.push({ at: r.checkedAt, url: r.url, type, from, to, link: r.link });
    const a = statusOf(prev);
    const b = statusOf(r);
    if (a === "indexed" && b === "not_indexed") add("deindexed", prev!.coverageState, r.coverageState);
    if (a === "not_indexed" && b === "indexed") add("indexed", prev!.coverageState, r.coverageState);
    if (prev && a !== "unknown" && !fetchProblem(prev) && fetchProblem(r)) add("fetch_error", prev.pageFetchState || "OK", r.pageFetchState);
    if (prev && fetchProblem(prev) && r.pageFetchState === "SUCCESSFUL") add("recovered", prev.pageFetchState, r.pageFetchState);
    if (prev?.googleCanonical && r.googleCanonical && prev.googleCanonical !== r.googleCanonical) add("canonical_changed", prev.googleCanonical, r.googleCanonical);
    inspected[r.url] = r;
  }
  return { cache: { ...c, inspected }, events };
}

export type IndexRow = {
  url: string; state: string; fetch: string; lastCrawl: string; inSitemap: string;
  link: string; checkedAt: string; googleCanonical: string; userCanonical: string;
};
export type SourceRow = { url: string; sources: string };
export type ErrorRow = { url: string; error: string; checkedAt: string };

/** "Indexed" / "not indexed" only count pages with a URL Inspection result. Impressions-only pages are "assumed". */
export function classify(c: IndexCache) {
  const indexed: IndexRow[] = [];
  const notIndexed: IndexRow[] = [];
  const canonicalMismatch: IndexRow[] = [];
  const assumed: SourceRow[] = [];
  const unchecked: SourceRow[] = [];
  const errors: ErrorRow[] = [];
  const all = new Map<string, string[]>(c.urls.map((u) => [u.url, u.sources]));
  for (const url of Object.keys(c.inspected)) if (!all.has(url)) all.set(url, []);
  const when = (iso: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
  all.forEach((sources, url) => {
    const r = c.inspected[url];
    if (r && r.verdict && r.verdict !== "ERROR") {
      const row: IndexRow = {
        url, state: r.coverageState, fetch: r.pageFetchState, lastCrawl: r.lastCrawlTime.slice(0, 10),
        inSitemap: sources.includes("sitemap") ? "Yes" : "No", link: r.link, checkedAt: when(r.checkedAt),
        googleCanonical: r.googleCanonical, userCanonical: r.userCanonical,
      };
      (isIndexedVerdict(r.verdict) ? indexed : notIndexed).push(row);
      if (r.googleCanonical && r.userCanonical && r.googleCanonical !== r.userCanonical) canonicalMismatch.push(row);
      return;
    }
    if (r?.verdict === "ERROR") errors.push({ url, error: r.coverageState, checkedAt: when(r.checkedAt) });
    (sources.includes("search") ? assumed : unchecked).push({ url, sources: sources.join(", ") || "inspection only" });
  });
  return { indexed, notIndexed, canonicalMismatch, assumed, unchecked, errors, total: all.size };
}

/** URLs that need a (re)check: never inspected, failed, or older than maxAgeDays. Never-inspected first. */
export function pendingUrls(c: IndexCache, o: { includeSeen: boolean; maxAgeDays: number }) {
  const cutoff = Date.now() - o.maxAgeDays * 864e5;
  return c.urls
    .filter((u) => o.includeSeen || !u.sources.includes("search"))
    .filter((u) => {
      const r = c.inspected[u.url];
      return !r || r.verdict === "ERROR" || Date.parse(r.checkedAt) < cutoff;
    })
    .sort((a, b) => Number(!!c.inspected[a.url]) - Number(!!c.inspected[b.url]))
    .map((u) => u.url);
}

/** Evidence record for the indexing figures, built from what's saved in this browser. */
export function indexScanSource(c: IndexCache | null) {
  if (!c) return null;
  const times = Object.values(c.inspected).filter((r) => r.verdict && r.verdict !== "ERROR").map((r) => r.checkedAt).sort();
  const span = times.length ? `${new Date(times[0]).toLocaleString()} to ${new Date(times[times.length - 1]).toLocaleString()}` : "never";
  return {
    id: "client.indexScan",
    label: "Indexed and not-indexed pages",
    system: "Google Search Console URL Inspection API",
    endpoint: "POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    request: { inspectionUrl: "<each URL>", siteUrl: "<this property>", languageCode: "en-US" },
    fetchedAt: times[times.length - 1] || c.listedAt || new Date().toISOString(),
    rowCount: c.urls.length,
    formula:
      `URLs come from your sitemaps (${c.sitemaps.length} file(s)) and pages with search impressions in the last 90 days. ` +
      `"Indexed" and "not indexed" count only pages with a URL Inspection result (${times.length} inspected, ${span}). ` +
      `Pages with impressions but no inspection are listed separately as "assumed indexed".`,
    verifyHow: "Every row links to Google's own inspection of that URL (Open in Search Console).",
    verifyUrl: "https://search.google.com/search-console/index",
    verifyLabel: "Open Search Console's Pages report",
  };
}
