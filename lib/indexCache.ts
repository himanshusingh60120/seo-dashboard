// lib/indexCache.ts
import type { Inspection, SiteCheck } from "./types";
import { kvGet, kvSet, kvDel } from "./idb";

export type IndexCache = {
  urls: { url: string; sources: string[] }[];
  sitemaps: string[];
  inspected: Record<string, Inspection & { checkedAt: string }>;
  /** Latest `site:` search result per URL. */
  site?: Record<string, SiteCheck>;
  listedAt: string;
};

const key = (site: string) => `dash:index:${site}`;

/*
 * Saved in IndexedDB (room for 50,000+ URLs). A copy is kept in memory so screens can read it
 * instantly; writes to disk are batched every few seconds while a scan runs.
 */
const mem = new Map<string, IndexCache | null>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Latest saved results already in memory (null until loadIndexCache has run for this property). */
export const peekIndexCache = (site: string) => mem.get(site) ?? null;

export async function loadIndexCache(site: string): Promise<IndexCache | null> {
  if (mem.has(site)) return mem.get(site)!;
  let c: IndexCache | null = null;
  try {
    c = (await kvGet<IndexCache>(key(site))) || null;
  } catch {}
  if (!c) {
    // One-time move from the older localStorage copy
    try {
      const raw = localStorage.getItem(key(site));
      if (raw) {
        c = JSON.parse(raw);
        await kvSet(key(site), c);
        localStorage.removeItem(key(site));
      }
    } catch {}
  }
  mem.set(site, c);
  return c;
}

/** Keeps stored results compact: the full Google responses live in the daily snapshots. */
function slim(c: IndexCache): IndexCache {
  const inspected: IndexCache["inspected"] = {};
  for (const [u, r] of Object.entries(c.inspected)) {
    const { raw, ...rest } = r;
    void raw;
    inspected[u] = rest;
  }
  const site: Record<string, SiteCheck> = {};
  for (const [u, r] of Object.entries(c.site || {})) site[u] = { ...r, results: r.results.slice(0, 3) };
  return { ...c, inspected, site };
}

const write = (site: string) => {
  pending.delete(site);
  const c = mem.get(site);
  (c ? kvSet(key(site), c) : kvDel(key(site))).catch(() => {});
};

/** Updates memory now and writes to disk within 3 seconds (or immediately with `now`). */
export function saveIndexCache(site: string, c: IndexCache, now = false) {
  mem.set(site, slim(c));
  if (pending.has(site)) clearTimeout(pending.get(site)!);
  if (now) write(site);
  else pending.set(site, setTimeout(() => write(site), 3000));
}

export function flushIndexCache(site: string) {
  if (pending.has(site)) { clearTimeout(pending.get(site)!); write(site); }
}

export async function clearIndexCache(site: string) {
  if (pending.has(site)) clearTimeout(pending.get(site)!);
  pending.delete(site);
  mem.set(site, null);
  try { localStorage.removeItem(key(site)); } catch {}
  await kvDel(key(site)).catch(() => {});
}

export const isIndexedVerdict = (v: string) => v === "PASS" || v === "PARTIAL";
export const isNotIndexedVerdict = (v: string) => v === "FAIL" || v === "NEUTRAL";

export type SiteCell = { status: string; reason: string; http: string; googleUrl: string; archiveUrl?: string; checkedAt: string } | null;
export const httpText = (s?: SiteCheck) => (s?.http ? s.http.chain.map((c) => c.status).join(" → ") || "no response" : "");
const siteCell = (s?: SiteCheck): SiteCell =>
  s ? { status: s.status, reason: s.reason || "", http: httpText(s), googleUrl: s.googleUrl, archiveUrl: s.archiveUrl, checkedAt: s.checkedAt } : null;
const siteLabel = (s?: SiteCheck) => (!s ? "Not run" : s.status === "found" ? "Found" : s.status === "not_found" ? "Not found" : "Error");

/**
 * Classifies every known URL.
 * Order of trust: URL Inspection result → `site:` search result → search impressions in the last 90 days.
 */
export function classify(c: IndexCache) {
  type Base = { url: string; site: string; siteCell: SiteCell; siteCheckedAt: string };
  const indexed: (Base & { how: string; state: string; lastCrawl: string; link: string; checkedAt: string })[] = [];
  const notIndexed: (Base & { how: string; state: string; lastCrawl: string; inSitemap: string; link: string; checkedAt: string })[] = [];
  const unchecked: (Base & { sources: string })[] = [];
  const errors: { url: string; error: string }[] = [];
  const disagree: (Base & { inspection: string; link: string })[] = [];
  const all = new Map(c.urls.map((u) => [u.url, u.sources]));
  for (const url of Object.keys(c.inspected)) if (!all.has(url)) all.set(url, []);
  for (const url of Object.keys(c.site || {})) if (!all.has(url)) all.set(url, []);

  all.forEach((sources, url) => {
    const r = c.inspected[url];
    const s = c.site?.[url];
    const base: Base = { url, site: siteLabel(s), siteCell: siteCell(s), siteCheckedAt: s?.checkedAt?.slice(0, 16).replace("T", " ") || "" };
    const checkedAt = r?.checkedAt?.slice(0, 16).replace("T", " ") || "";
    if (r && r.verdict === "ERROR") errors.push({ url, error: r.coverageState });
    if (s && s.status === "error") errors.push({ url, error: `site: check: ${s.reason || s.error || "unknown error"}` });

    if (r && isIndexedVerdict(r.verdict)) {
      indexed.push({ ...base, how: "URL Inspection", state: r.coverageState, lastCrawl: r.lastCrawlTime.slice(0, 10), link: r.link, checkedAt });
      if (s?.status === "not_found") disagree.push({ ...base, inspection: `Indexed (${r.coverageState})`, link: r.link });
    } else if (r && isNotIndexedVerdict(r.verdict)) {
      notIndexed.push({ ...base, how: "URL Inspection", state: r.coverageState, lastCrawl: r.lastCrawlTime.slice(0, 10), inSitemap: sources.includes("sitemap") ? "Yes" : "No", link: r.link, checkedAt });
      if (s?.status === "found") disagree.push({ ...base, inspection: `Not indexed (${r.coverageState})`, link: r.link });
    } else if (s?.status === "found") {
      indexed.push({ ...base, how: "site: search", state: s.reason || "First site: result, HTTP 200", lastCrawl: "", link: "", checkedAt: "" });
    } else if (s?.status === "not_found") {
      notIndexed.push({ ...base, how: "site: search", state: s.reason || "Not the first site: result", lastCrawl: "", inSitemap: sources.includes("sitemap") ? "Yes" : "No", link: "", checkedAt: "" });
    } else if (sources.includes("search")) {
      indexed.push({ ...base, how: "Search impressions", state: "Appeared in search (last 90 days)", lastCrawl: "", link: "", checkedAt: "" });
    } else unchecked.push({ ...base, sources: sources.join(", ") });
  });
  return { indexed, notIndexed, unchecked, errors, disagree, total: all.size };
}

/** Provenance record for the indexing figures, built from what's saved in this browser. */
export function indexScanSource(c: IndexCache | null) {
  if (!c) return null;
  const insp = Object.values(c.inspected).map((r) => r.checkedAt).filter(Boolean).sort();
  const site = Object.values(c.site || {}).map((r) => r.checkedAt).filter(Boolean).sort();
  const providers = Array.from(new Set(Object.values(c.site || {}).map((r) => r.provider).filter(Boolean)));
  const span = (l: string[]) => (l.length ? `${new Date(l[0]).toLocaleString()} to ${new Date(l[l.length - 1]).toLocaleString()}` : "never");
  return {
    id: "client.indexScan",
    label: "Indexed and not-indexed pages",
    system: `Google Search Console URL Inspection API${site.length ? ` + Google site: search via ${providers.join(", ")}` : ""}`,
    endpoint: "POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    request: { inspectionUrl: "<each URL>", siteUrl: "<this property>", languageCode: "en-US" },
    fetchedAt: insp[insp.length - 1] || site[site.length - 1] || c.listedAt,
    rowCount: c.urls.length,
    formula:
      `URLs come from your sitemaps (${c.sitemaps.length} file(s)) and from pages with search impressions in the last 90 days, listed ${new Date(c.listedAt).toLocaleString()}. ` +
      `A page's status comes from its URL Inspection result if it has one (${insp.length} inspected, ${span(insp)}); otherwise from a site: search (${site.length} searched, ${span(site)}); otherwise pages with search impressions count as indexed. ` +
      `site: rule: the page counts as indexed only when the first result for site:<full URL> is that page (or the URL it redirects to) and the page loads with HTTP 200, directly or through redirects. Timeouts, 403, 429 and 5xx responses are marked inconclusive rather than not indexed.`,
    verifyHow:
      "Every URL has its own evidence in the Indexing tab: “Open in Search Console” opens Google's inspection of that exact URL, and the site: links repeat the search on Google or open the saved results page.",
    verifyUrl: "https://search.google.com/search-console/index",
    verifyLabel: "Open Search Console's Pages report",
  };
}
