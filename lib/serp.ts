// lib/serp.ts
/**
 * `site:` checks. Google does not allow automated queries on google.com and its own
 * Custom Search JSON API is closed to new customers (shutting down 1 Jan 2027), so the
 * search runs through a SERP provider:
 *   - SerpApi (SERPAPI_KEY): keeps an archived copy of Google's results page for every
 *     search, which is the strongest evidence. Recommended.
 *   - Serper.dev (SERPER_API_KEY): cheaper, returns the results as JSON only.
 */

export type SiteCheck = {
  url: string;
  /** Exactly what was searched: `site:` followed immediately by the full URL. */
  query: string;
  status: "found" | "not_found" | "error";
  /** The result link that matched the URL, when found. */
  matchedUrl: string;
  resultsReturned: number;
  results: { position: number; title: string; link: string }[];
  provider: string;
  checkedAt: string;
  /** Opens the same search on google.com so anyone can repeat it. */
  googleUrl: string;
  /** SerpApi only: saved copy of the Google results page at the time of the check. */
  archiveUrl?: string;
  /** SerpApi only: saved JSON of the search. */
  jsonUrl?: string;
  searchId?: string;
  error?: string;
};

export class QuotaError extends Error {}

const HL = () => process.env.SERP_HL || "en";
const GL = () => process.env.SERP_GL || "";

export function serpProvider(): { name: "serpapi" | "serper"; label: string; key: string } | null {
  if (process.env.SERPAPI_KEY) return { name: "serpapi", label: "SerpApi", key: process.env.SERPAPI_KEY };
  if (process.env.SERPER_API_KEY) return { name: "serper", label: "Serper.dev", key: process.env.SERPER_API_KEY };
  return null;
}

export const siteQuery = (url: string) => `site:${url.trim()}`;

export function googleSearchUrl(query: string) {
  const p = new URLSearchParams({ q: query, num: "10", hl: HL(), filter: "0" });
  if (GL()) p.set("gl", GL());
  return `https://www.google.com/search?${p.toString()}`;
}

/** Normalises a URL for comparison: ignores protocol, www, host case, trailing slash and #fragment. Path case and query string are kept. */
export function matchKey(u: string) {
  try {
    const x = new URL(u.trim());
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    let path = decodeURI(x.pathname);
    if (path.length > 1) path = path.replace(/\/+$/, "");
    if (path === "/") path = "";
    return `${host}${path}${x.search}`;
  } catch {
    return u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function finish(url: string, query: string, provider: string, results: SiteCheck["results"], extra: Partial<SiteCheck>): SiteCheck {
  const target = matchKey(url);
  const hit = results.find((r) => matchKey(r.link) === target);
  return {
    url,
    query,
    status: hit ? "found" : "not_found",
    matchedUrl: hit?.link || "",
    resultsReturned: results.length,
    results,
    provider,
    checkedAt: new Date().toISOString(),
    googleUrl: googleSearchUrl(query),
    ...extra,
  };
}

async function viaSerpApi(url: string, key: string): Promise<SiteCheck> {
  const query = siteQuery(url);
  const p = new URLSearchParams({ engine: "google", q: query, num: "10", hl: HL(), filter: "0", no_cache: "true", api_key: key });
  if (GL()) p.set("gl", GL());
  const res = await fetch(`https://serpapi.com/search.json?${p.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(45000) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 || /run out of searches|plan limit/i.test(data?.error || "")) throw new QuotaError(data?.error || "SerpApi search limit reached");
  if (!res.ok && !data?.search_metadata) throw new Error(data?.error || `SerpApi error ${res.status}`);

  const meta = data.search_metadata || {};
  const extra = { archiveUrl: meta.raw_html_file, jsonUrl: meta.json_endpoint, searchId: meta.id };
  // SerpApi reports an empty Google result page as an "error" message; that is a valid "not found".
  if (data.error && !/hasn't returned any results/i.test(data.error)) {
    return { ...finish(url, query, "SerpApi", [], extra), status: "error", error: data.error };
  }
  const results = (data.organic_results || []).map((r: any) => ({ position: r.position, title: r.title || "", link: r.link || "" }));
  return finish(url, query, "SerpApi", results, extra);
}

async function viaSerper(url: string, key: string): Promise<SiteCheck> {
  const query = siteQuery(url);
  const body: Record<string, unknown> = { q: query, num: 10, hl: HL() };
  if (GL()) body.gl = GL();
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    cache: "no-store",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 || (res.status === 400 && /credits/i.test(data?.message || ""))) throw new QuotaError(data?.message || "Serper credits used up");
  if (!res.ok) throw new Error(data?.message || `Serper error ${res.status}`);
  const results = (data.organic || []).map((r: any) => ({ position: r.position, title: r.title || "", link: r.link || "" }));
  return finish(url, query, "Serper.dev", results, {});
}

export async function siteCheck(url: string): Promise<SiteCheck> {
  const p = serpProvider();
  if (!p) throw new Error("No search provider configured. Add SERPAPI_KEY or SERPER_API_KEY to the environment variables.");
  return p.name === "serpapi" ? viaSerpApi(url, p.key) : viaSerper(url, p.key);
}
