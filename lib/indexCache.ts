import type { Inspection } from "./types";

export type IndexCache = {
  urls: { url: string; sources: string[] }[];
  sitemaps: string[];
  inspected: Record<string, Inspection & { checkedAt: string }>;
  listedAt: string;
};

const key = (site: string) => `dash:index:${site}`;

export function loadIndexCache(site: string): IndexCache | null {
  try {
    const raw = localStorage.getItem(key(site));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveIndexCache(site: string, c: IndexCache) {
  try {
    localStorage.setItem(key(site), JSON.stringify(c));
  } catch {
    // Storage full: drop the URL list but keep inspection results
    try {
      localStorage.setItem(key(site), JSON.stringify({ ...c, urls: [] }));
    } catch {}
  }
}

export const isIndexedVerdict = (v: string) => v === "PASS" || v === "PARTIAL";
export const isNotIndexedVerdict = (v: string) => v === "FAIL" || v === "NEUTRAL";

/** Classifies every known URL. Pages with search impressions are treated as indexed unless an inspection says otherwise. */
export function classify(c: IndexCache) {
  const indexed: { url: string; how: string; state: string; lastCrawl: string; link: string }[] = [];
  const notIndexed: { url: string; state: string; lastCrawl: string; inSitemap: string; link: string }[] = [];
  const unchecked: { url: string; sources: string }[] = [];
  const errors: { url: string; error: string }[] = [];
  const all = new Map(c.urls.map((u) => [u.url, u.sources]));
  for (const url of Object.keys(c.inspected)) if (!all.has(url)) all.set(url, []);

  all.forEach((sources, url) => {
    const r = c.inspected[url];
    if (r && r.verdict === "ERROR") errors.push({ url, error: r.coverageState });
    if (r && isIndexedVerdict(r.verdict)) indexed.push({ url, how: "Inspected", state: r.coverageState, lastCrawl: r.lastCrawlTime.slice(0, 10), link: r.link });
    else if (r && isNotIndexedVerdict(r.verdict)) notIndexed.push({ url, state: r.coverageState, lastCrawl: r.lastCrawlTime.slice(0, 10), inSitemap: sources.includes("sitemap") ? "Yes" : "No", link: r.link });
    else if (sources.includes("search")) indexed.push({ url, how: "Has search impressions", state: "Appeared in search (last 90 days)", lastCrawl: "", link: "" });
    else unchecked.push({ url, sources: sources.join(", ") });
  });
  return { indexed, notIndexed, unchecked, errors, total: all.size };
}
