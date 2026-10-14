// app/api/site-check/route.ts
// Page checks for the /site-check page: status code, redirect chain, noindex, canonical and robots.txt.
// Free (no search API). Only URLs on your own Search Console properties can be checked, so the server
// can't be used to fetch arbitrary or internal addresses. The Google "site:" column is no longer filled.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { listSites } from "@/lib/google";
import { checkPage } from "@/lib/safeFetch";
import { propertyHost } from "@/lib/url";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_URLS = 20;

/** Kept so the existing /site-check page compiles unchanged; googleResult is always "off" now. */
export type GoogleResult =
  | "found" | "not_found" | "other_urls_only" | "blocked" | "js_required" | "consent_page"
  | "redirected" | "unknown" | "error" | "skipped" | "off";

export type PageCheckRow = {
  url: string; pageStatus: number; chain: string; finalUrl: string; noindex: "yes" | "no" | "";
  canonical: string; canonicalElsewhere: boolean; robotsBlocked: boolean;
  googleHttp: number | null; googleResult: GoogleResult; googleUrl: string; error: string; checkedAt: string;
};

async function hostRule(req: NextRequest) {
  const token = await getGoogleAccessToken(req);
  const sites = await listSites(token);
  const domains = sites.filter((s) => s.siteUrl.startsWith("sc-domain:")).map((s) => propertyHost(s.siteUrl));
  const hosts = new Set(sites.filter((s) => !s.siteUrl.startsWith("sc-domain:")).map((s) => propertyHost(s.siteUrl)));
  const extra = (process.env.SITE_CHECK_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean);
  return (h: string) => {
    const host = h.toLowerCase();
    const own = hosts.has(host) || domains.some((d) => host === d || host.endsWith(`.${d}`));
    return own && (!extra.length || extra.some((d) => host.replace(/^www\./, "") === d || host.endsWith(`.${d}`)));
  };
}

async function run(urls: string[], allowHost: (h: string) => boolean) {
  const results = await pool(urls, 5, async (url): Promise<PageCheckRow> => {
    const p = await checkPage(url, { allowHost, robots: true });
    return {
      url,
      pageStatus: p.status,
      chain: p.chain.map((c) => c.status).join(" → ") || (p.error ? "no response" : ""),
      finalUrl: p.finalUrl,
      noindex: p.status === 200 ? (p.noindex ? "yes" : "no") : "",
      canonical: p.canonical,
      canonicalElsewhere: p.canonicalElsewhere,
      robotsBlocked: p.robotsBlocked,
      googleHttp: null,
      googleResult: "off",
      googleUrl: `https://www.google.com/search?q=${encodeURIComponent(`site:${url}`)}`,
      error: [p.error, p.robotsBlocked ? "Blocked by robots.txt for Googlebot" : ""].filter(Boolean).join("; "),
      checkedAt: p.checkedAt,
    };
  });
  return { results, googleBlocked: false };
}

export async function POST(req: NextRequest) {
  try {
    const allowHost = await hostRule(req);
    const body = await req.json().catch(() => null);
    const list: string[] = Array.isArray(body?.urls) ? body.urls.map(String) : [];
    const urls = Array.from(new Set(list.map((u) => u.trim()).filter(Boolean)));
    if (!urls.length) return NextResponse.json({ error: 'Send JSON: { "urls": ["https://..."] }' }, { status: 400 });
    if (urls.length > MAX_URLS) return NextResponse.json({ error: `Max ${MAX_URLS} URLs per request` }, { status: 400 });
    return NextResponse.json(await run(urls, allowHost));
  } catch (e) {
    return fail(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const allowHost = await hostRule(req);
    const url = req.nextUrl.searchParams.get("url");
    if (!url) return NextResponse.json({ error: "Add ?url=https://..." }, { status: 400 });
    return NextResponse.json(await run([url.trim()], allowHost));
  } catch (e) {
    return fail(e);
  }
}
