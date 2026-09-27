// lib/serp.ts
/**
 * `site:` checks. Google does not allow automated queries on google.com and its own
 * Custom Search JSON API is closed to new customers (shutting down 1 Jan 2027), so the
 * search runs through a SERP provider:
 *   - SerpApi (SERPAPI_KEY): keeps an archived copy of Google's results page for every
 *     search, which is the strongest evidence. Recommended.
 *   - Serper.dev (SERPER_API_KEY): cheaper, returns the results as JSON only.
 */

/** The page's own HTTP response, following redirects. Free: no search credit used. */
export type HttpCheck = {
  /** Final status after following redirects (0 = no response). */
  status: number;
  finalUrl: string;
  /** Every hop, e.g. 301 → 200. */
  chain: { url: string; status: number }[];
  /** True when the page ends in HTTP 200, directly or through redirects. */
  ok: boolean;
  /** True when the response can't settle the question (timeout, 403, 429, 5xx), e.g. bot protection. */
  inconclusive: boolean;
  error?: string;
  checkedAt: string;
};

export type SiteCheck = {
  url: string;
  /** Exactly what was searched: `site:` followed immediately by the full URL. */
  query: string;
  /**
   * found: the first result is this URL (or the URL it redirects to) AND the page loads with HTTP 200.
   * not_found: either part failed. error: the search failed or the page check was inconclusive.
   */
  status: "found" | "not_found" | "error";
  /** Plain-language reason for the status. */
  reason: string;
  /** The first organic result's link. */
  firstResultUrl: string;
  /** The result link that matched the URL, when found. */
  matchedUrl: string;
  /** The page's HTTP status check. */
  http?: HttpCheck;
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

const UA = "Mozilla/5.0 (compatible; SearchDashboard/1.0; index check)";

/** Requests the page and follows up to 5 redirects by hand so every hop is recorded. */
export async function httpCheck(url: string): Promise<HttpCheck> {
  const chain: HttpCheck["chain"] = [];
  const checkedAt = new Date().toISOString();
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    let res: Response;
    try {
      res = await fetch(cur, {
        redirect: "manual",
        cache: "no-store",
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      return { status: 0, finalUrl: cur, chain, ok: false, inconclusive: true, error: e instanceof Error ? e.message : "No response", checkedAt };
    }
    try { await res.body?.cancel(); } catch {}
    chain.push({ url: cur, status: res.status });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      continue;
    }
    const inconclusive = res.status === 403 || res.status === 429 || res.status >= 500;
    return { status: res.status, finalUrl: cur, chain, ok: res.status === 200, inconclusive, checkedAt };
  }
  return { status: chain[chain.length - 1]?.status || 0, finalUrl: cur, chain, ok: false, inconclusive: false, error: "More than 5 redirects", checkedAt };
}

const chainText = (h: HttpCheck) => h.chain.map((c) => c.status).join(" → ") || "no response";

/**
 * Applies the rule: indexed only when the FIRST site: result is the page (or where it redirects to)
 * and the page loads with HTTP 200, directly or through working redirects.
 */
function finish(url: string, query: string, provider: string, results: SiteCheck["results"], http: HttpCheck, extra: Partial<SiteCheck>): SiteCheck {
  const targets = new Set([matchKey(url), matchKey(http.finalUrl)]);
  const first = results[0];
  const firstMatches = !!first && targets.has(matchKey(first.link));
  const elsewhere = results.find((r) => targets.has(matchKey(r.link)));

  let status: SiteCheck["status"];
  let reason: string;
  if (http.inconclusive) {
    status = "error";
    reason = `Page check inconclusive (${http.error || `HTTP ${chainText(http)}`}); the site may be blocking automated requests`;
  } else if (!results.length) {
    status = "not_found";
    reason = "site: returned no results";
  } else if (!firstMatches) {
    status = "not_found";
    reason = elsewhere ? `Page is result #${elsewhere.position}, not the first` : "Page is not in the site: results";
  } else if (!http.ok) {
    status = "not_found";
    reason = `First result, but the page returns HTTP ${chainText(http)}${http.error ? ` (${http.error})` : ""}`;
  } else {
    status = "found";
    reason = `First result, page returns HTTP ${chainText(http)}`;
  }

  return {
    url,
    query,
    status,
    reason,
    firstResultUrl: first?.link || "",
    matchedUrl: firstMatches ? first.link : "",
    http,
    resultsReturned: results.length,
    results,
    provider,
    checkedAt: new Date().toISOString(),
    googleUrl: googleSearchUrl(query),
    ...extra,
  };
}

async function viaSerpApi(url: string, key: string, httpP: Promise<HttpCheck>): Promise<SiteCheck> {
  const query = siteQuery(url);
  const p = new URLSearchParams({ engine: "google", q: query, num: "10", hl: HL(), filter: "0", no_cache: "true", api_key: key });
  if (GL()) p.set("gl", GL());
  const res = await fetch(`https://serpapi.com/search.json?${p.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 || /run out of searches|plan limit/i.test(data?.error || "")) throw new QuotaError(data?.error || "SerpApi search limit reached");
  if (!res.ok && !data?.search_metadata) throw new Error(data?.error || `SerpApi error ${res.status}`);

  const meta = data.search_metadata || {};
  const extra = { archiveUrl: meta.raw_html_file, jsonUrl: meta.json_endpoint, searchId: meta.id };
  // SerpApi reports an empty Google result page as an "error" message; that is a valid "not found".
  if (data.error && !/hasn't returned any results/i.test(data.error)) {
    return { ...finish(url, query, "SerpApi", [], await httpP, extra), status: "error", reason: `Search failed: ${data.error}`, error: data.error };
  }
  const results = (data.organic_results || []).map((r: any) => ({ position: r.position, title: r.title || "", link: r.link || "" }));
  return finish(url, query, "SerpApi", results, await httpP, extra);
}

async function viaSerper(url: string, key: string, httpP: Promise<HttpCheck>): Promise<SiteCheck> {
  const query = siteQuery(url);
  const body: Record<string, unknown> = { q: query, num: 10, hl: HL() };
  if (GL()) body.gl = GL();
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    cache: "no-store",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 || (res.status === 400 && /credits/i.test(data?.message || ""))) throw new QuotaError(data?.message || "Serper credits used up");
  if (!res.ok) throw new Error(data?.message || `Serper error ${res.status}`);
  const results = (data.organic || []).map((r: any) => ({ position: r.position, title: r.title || "", link: r.link || "" }));
  return finish(url, query, "Serper.dev", results, await httpP, {});
}

export async function siteCheck(url: string): Promise<SiteCheck> {
  const p = serpProvider();
  if (!p) throw new Error("No search provider configured. Add SERPAPI_KEY or SERPER_API_KEY to the environment variables.");
  // The page check (free) and the search (one credit) run at the same time
  const httpP = httpCheck(url);
  httpP.catch(() => {});
  return p.name === "serpapi" ? viaSerpApi(url, p.key, httpP) : viaSerper(url, p.key, httpP);
}
