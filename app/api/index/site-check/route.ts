// app/api/index/site-check/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { normalizeHost } from "@/lib/google";
import { siteCheck, serpProvider, siteQuery, googleSearchUrl, QuotaError, SiteCheck } from "@/lib/serp";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tells the browser which search provider is in use (direct = no API key). */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const p = serpProvider();
    return NextResponse.json({ provider: p?.label || null, archives: p?.name === "serpapi", direct: p?.name === "direct" });
  } catch (e) {
    return fail(e);
  }
}

/** Runs `site:<url>` for up to 20 URLs belonging to the selected property. */
export async function POST(req: NextRequest) {
  try {
    await requireUser(req);
    const { siteUrl, urls } = (await req.json()) as { siteUrl: string; urls: string[] };
    if (!siteUrl || !Array.isArray(urls)) return NextResponse.json({ error: "Missing siteUrl or urls" }, { status: 400 });
    const provider = serpProvider();
    if (!provider) {
      return NextResponse.json({ error: "site: search is switched off (SITE_SEARCH_DIRECT=off). Remove that setting, or add SERPAPI_KEY or SERPER_API_KEY, and redeploy." }, { status: 400 });
    }
    const direct = provider.name === "direct";

    // Only check URLs on this property, so searches can't be spent on other sites
    const host = normalizeHost(siteUrl);
    const own = (u: string) => {
      try {
        const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
        return h === host || h.endsWith(`.${host}`);
      } catch {
        return false;
      }
    };

    const started = Date.now();
    let quotaExceeded = false;
    let stopReason = "";
    // Direct Google requests go one at a time with a pause, and stop before the function times out.
    // URLs not reached are left out of the response, so the next run picks them up.
    const results = await pool(urls.filter(own).slice(0, 20), direct ? 1 : 10, async (url): Promise<SiteCheck | null> => {
      if (quotaExceeded) return null;
      if (direct && Date.now() - started > 45_000) return null;
      try {
        const r = await siteCheck(url);
        if (direct) await sleep(1000 + Math.random() * 1500);
        return r;
      } catch (e) {
        if (e instanceof QuotaError) {
          // Blocked or out of credits: nothing was learned about this URL, so don't record it
          quotaExceeded = true;
          stopReason = e.message;
          return null;
        }
        const query = siteQuery(url);
        return {
          url, query, status: "error", reason: `Search failed: ${e instanceof Error ? e.message : "unknown error"}`, firstResultUrl: "", matchedUrl: "", resultsReturned: 0, results: [], provider: provider.label,
          checkedAt: new Date().toISOString(), googleUrl: googleSearchUrl(query), error: e instanceof Error ? e.message : "Search failed",
        };
      }
    });
    return NextResponse.json({ results: results.filter(Boolean), quotaExceeded, stopReason });
  } catch (e) {
    return fail(e);
  }
}
