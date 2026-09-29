// app/api/site-check/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { fail, pool } from "@/lib/api";
import { httpCheck, matchKey, siteQuery, googleSearchUrl } from "@/lib/serp";

/*
 * No-API-key checks for the /site-check page. Signed-in users only (middleware skips /api).
 * For each URL:
 *   1) the page's own response: status, redirect chain, noindex, canonical  (reliable)
 *   2) optionally, a direct request to google.com for site:<url>          (Google often blocks
 *      requests from Vercel's servers; the result says so when it does)
 *
 * POST /api/site-check   { "urls": ["https://..."], "google": true }   max 20 URLs per call
 * GET  /api/site-check?url=https://...&google=0                       one URL, for testing
 *
 * Optional env var: SITE_CHECK_ALLOWED_HOSTS=martech360.com (comma-separated) limits which sites can be checked.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_URLS = 20;
const TIME_BUDGET_MS = 45_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export type GoogleResult =
  | "found" | "not_found" | "other_urls_only" | "blocked" | "js_required"
  | "consent_page" | "redirected" | "unknown" | "error" | "skipped" | "off";

export type PageCheckRow = {
  url: string;
  /** Final HTTP status after redirects (0 = no response or URL not allowed). */
  pageStatus: number;
  /** Every hop, e.g. "301 → 200". */
  chain: string;
  finalUrl: string;
  noindex: "yes" | "no" | "";
  canonical: string;
  /** True when the canonical points at a different URL. */
  canonicalElsewhere: boolean;
  googleHttp: number | null;
  googleResult: GoogleResult;
  /** Opens the same site: search on google.com. */
  googleUrl: string;
  error: string;
  checkedAt: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

function isAllowed(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.startsWith("[") || /^[\d.]+$/.test(h)) return false;
  const list = (process.env.SITE_CHECK_ALLOWED_HOSTS || "").split(",").map((s) => bareHost(s.trim())).filter(Boolean);
  return !list.length || list.some((d) => bareHost(h) === d || h.endsWith(`.${d}`));
}

async function drain(res: Response) {
  try { await res.body?.cancel(); } catch {}
}

/** Reads noindex (meta robots / X-Robots-Tag) and the canonical from a page that returned 200. */
async function pageMeta(url: string): Promise<{ noindex: "yes" | "no" | ""; canonical: string }> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(10_000),
    });
    let noindex = /noindex/i.test(res.headers.get("x-robots-tag") || "");
    let canonical = "";
    if ((res.headers.get("content-type") || "").includes("html")) {
      const html = await res.text();
      for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
        if (/name\s*=\s*["']?(robots|googlebot)\b/i.test(tag) && /noindex/i.test(tag)) noindex = true;
      }
      for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
        if (/rel\s*=\s*["']?canonical\b/i.test(tag)) {
          canonical = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
          break;
        }
      }
    } else {
      await drain(res);
    }
    return { noindex: noindex ? "yes" : "no", canonical };
  } catch {
    return { noindex: "", canonical: "" };
  }
}

async function checkPage(url: string): Promise<PageCheckRow> {
  const query = siteQuery(url);
  const row: PageCheckRow = {
    url, pageStatus: 0, chain: "", finalUrl: "", noindex: "", canonical: "", canonicalElsewhere: false,
    googleHttp: null, googleResult: "off", googleUrl: googleSearchUrl(query), error: "", checkedAt: new Date().toISOString(),
  };
  if (!isAllowed(url)) {
    row.error = "URL not allowed (check SITE_CHECK_ALLOWED_HOSTS)";
    return row;
  }
  const http = await httpCheck(url);
  row.pageStatus = http.status;
  row.chain = http.chain.map((c) => c.status).join(" → ") || "no response";
  row.finalUrl = http.finalUrl;
  if (http.error) row.error = http.error;
  else if (http.inconclusive) row.error = "Inconclusive: the site may be blocking automated requests";
  if (http.ok) {
    const meta = await pageMeta(http.finalUrl);
    row.noindex = meta.noindex;
    if (meta.canonical) {
      const abs = new URL(meta.canonical, http.finalUrl).toString();
      row.canonical = abs;
      row.canonicalElsewhere = matchKey(abs) !== matchKey(http.finalUrl);
    }
  }
  return row;
}

/** Requests Google's results page directly (no API key) and looks for the URL in it. */
async function googleCheck(row: PageCheckRow): Promise<{ googleHttp: number | null; googleResult: GoogleResult; error?: string }> {
  try {
    const res = await fetch(row.googleUrl, {
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html" },
      signal: AbortSignal.timeout(12_000),
    });
    const loc = res.headers.get("location") || "";
    if (res.status === 429 || res.status === 403 || loc.includes("/sorry/")) {
      await drain(res);
      return { googleHttp: res.status, googleResult: "blocked" };
    }
    if (res.status >= 300 && res.status < 400) {
      await drain(res);
      return { googleHttp: res.status, googleResult: loc.includes("consent.google") ? "consent_page" : "redirected" };
    }
    if (res.status !== 200) {
      await drain(res);
      return { googleHttp: res.status, googleResult: "unknown" };
    }

    const html = await res.text();
    const host = bareHost(new URL(row.url).hostname);
    const targets = new Set([matchKey(row.url), row.finalUrl ? matchKey(row.finalUrl) : ""].filter(Boolean));
    const onSite = [...html.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1].replace(/&amp;/g, "&"))
      .map((h) => (h.startsWith("/url?") ? new URL(h, "https://www.google.com").searchParams.get("q") || "" : h))
      .filter((h) => {
        try {
          const x = bareHost(new URL(h).hostname);
          return /^https?:/i.test(h) && (x === host || x.endsWith(`.${host}`));
        } catch {
          return false;
        }
      });

    let googleResult: GoogleResult = "unknown";
    if (onSite.some((h) => targets.has(matchKey(h)))) googleResult = "found";
    else if (/did not match any documents/i.test(html)) googleResult = "not_found";
    else if (/enablejs|turn on javascript|not redirected within a few seconds/i.test(html)) googleResult = "js_required";
    else if (/unusual traffic|captcha/i.test(html)) googleResult = "blocked";
    else if (onSite.length) googleResult = "other_urls_only";
    return { googleHttp: 200, googleResult };
  } catch (e) {
    return { googleHttp: null, googleResult: "error", error: `Google: ${e instanceof Error ? e.message : "request failed"}` };
  }
}

async function run(urls: string[], withGoogle: boolean) {
  const started = Date.now();
  const rows = await pool(urls, 5, checkPage);

  // Google one URL at a time; stop as soon as Google blocks this server
  let googleBlocked = false;
  if (withGoogle) {
    for (const row of rows) {
      if (row.error.startsWith("URL not allowed")) continue;
      if (googleBlocked || Date.now() - started > TIME_BUDGET_MS) {
        row.googleResult = "skipped";
        continue;
      }
      const g = await googleCheck(row);
      row.googleHttp = g.googleHttp;
      row.googleResult = g.googleResult;
      if (g.error) row.error = row.error ? `${row.error}; ${g.error}` : g.error;
      if (g.googleResult === "blocked" || g.googleResult === "js_required" || g.googleResult === "consent_page") googleBlocked = true;
      else await sleep(800 + Math.random() * 1200);
    }
  }
  return { results: rows, googleBlocked };
}

export async function POST(req: NextRequest) {
  try {
    await requireUser(req);
    const body = (await req.json().catch(() => null)) as { urls?: unknown; google?: boolean } | null;
    const list = Array.isArray(body?.urls) ? (body!.urls as unknown[]) : [];
    const urls = [...new Set(list.map((u) => String(u).trim()).filter(Boolean))];
    if (!urls.length) return NextResponse.json({ error: 'Send JSON: { "urls": ["https://..."] }' }, { status: 400 });
    if (urls.length > MAX_URLS) return NextResponse.json({ error: `Max ${MAX_URLS} URLs per request` }, { status: 400 });
    return NextResponse.json(await run(urls, body?.google !== false));
  } catch (e) {
    return fail(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const url = req.nextUrl.searchParams.get("url");
    if (!url) return NextResponse.json({ error: "Add ?url=https://..." }, { status: 400 });
    return NextResponse.json(await run([url.trim()], req.nextUrl.searchParams.get("google") !== "0"));
  } catch (e) {
    return fail(e);
  }
}
