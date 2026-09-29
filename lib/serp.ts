// lib/serp.ts
/**
 * `site:` checks. Google does not allow automated queries on google.com and its own
 * Custom Search JSON API is closed to new customers (shutting down 1 Jan 2027), so the
 * search runs through a SERP provider:
 *   - SerpApi (SERPAPI_KEY): keeps an archived copy of Google's results page for every
 *     search, which is the strongest evidence. Recommended.
 *   - Serper.dev (SERPER_API_KEY): cheaper, returns the results as JSON only.
 *   - Direct (no key): used when neither key is set. Requests google.com from the server,
 *     one URL at a time. Google often blocks this from cloud servers (429, CAPTCHA or a
 *     "turn on JavaScript" page); the run then stops and says why. SITE_SEARCH_DIRECT=off disables it.
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

export function serpProvider(): { name: "serpapi" | "serper" | "direct"; label: string; key: string } | null {
  if (process.env.SERPAPI_KEY) return { name: "serpapi", label: "SerpApi", key: process.env.SERPAPI_KEY };
  if (process.env.SERPER_API_KEY) return { name: "serper", label: "Serper.dev", key: process.env.SERPER_API_KEY };
  if (process.env.SITE_SEARCH_DIRECT !== "off") return { name: "direct", label: "Google (direct, no key)", key: "" };
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

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const decodeEntities = (t: string) =>
  t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Organic results (link + title, in page order) from a Google results page: links that wrap an <h3> title. */
export function parseGoogleHtml(html: string): SiteCheck["results"] {
  const out: SiteCheck["results"] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?\shref="([^"]+)"[^>]*>((?:(?!<\/a>)[\s\S]){0,3000}?<h3[^>]*>([\s\S]*?)<\/h3>)/gi;
  for (const m of html.matchAll(re)) {
    let link = decodeEntities(m[1]);
    if (link.startsWith("/url?")) link = new URLSearchParams(link.slice(5)).get("q") || "";
    if (!/^https?:\/\//i.test(link)) continue;
    try {
      if (/(^|\.)google\./i.test(new URL(link).hostname)) continue;
    } catch {
      continue;
    }
    if (seen.has(link)) continue;
    seen.add(link);
    out.push({ position: out.length + 1, title: decodeEntities(m[3].replace(/<[^>]+>/g, "")).trim(), link });
  }
  return out;
}

/** No key: asks google.com directly. Any sign of blocking throws QuotaError so the run stops instead of retrying. */
async function viaDirect(url: string, httpP: Promise<HttpCheck>): Promise<SiteCheck> {
  const query = siteQuery(url);
  let res: Response;
  try {
    res = await fetch(googleSearchUrl(query), {
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": `${HL()},en;q=0.8`, Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`Google did not respond: ${e instanceof Error ? e.message : "request failed"}`);
  }
  const loc = res.headers.get("location") || "";
  const drain = async () => { try { await res.body?.cancel(); } catch {} };
  if (res.status === 429 || res.status === 403 || loc.includes("/sorry/")) {
    await drain();
    throw new QuotaError(`Google blocked the search from this server (HTTP ${res.status}).`);
  }
  if (loc.includes("consent.google")) {
    await drain();
    throw new QuotaError("Google showed its cookie-consent page instead of results.");
  }
  if (res.status !== 200) {
    await drain();
    throw new QuotaError(`Google answered HTTP ${res.status}${loc ? ` (redirect to ${loc})` : ""} instead of results.`);
  }
  const html = await res.text();
  if (/unusual traffic from your computer|id="captcha-form"|g-recaptcha/i.test(html)) {
    throw new QuotaError("Google showed a CAPTCHA (unusual traffic from this server).");
  }
  const results = parseGoogleHtml(html);
  if (!results.length && !/did not match any documents|No results found for/i.test(html)) {
    if (/enablejs|turn on javascript|not redirected within a few seconds/i.test(html)) {
      throw new QuotaError("Google sent its “turn on JavaScript” page instead of results, so they can't be read from the server.");
    }
    throw new QuotaError("Couldn't read Google's results page (its layout may have changed).");
  }
  return finish(url, query, "Google (direct)", results, await httpP, {});
}

export async function siteCheck(url: string): Promise<SiteCheck> {
  const p = serpProvider();
  if (!p) throw new Error("No search provider configured. Add SERPAPI_KEY or SERPER_API_KEY to the environment variables.");
  // The page check (free) and the search run at the same time
  const httpP = httpCheck(url);
  httpP.catch(() => {});
  if (p.name === "serpapi") return viaSerpApi(url, p.key, httpP);
  if (p.name === "serper") return viaSerper(url, p.key, httpP);
  return viaDirect(url, httpP);
}
