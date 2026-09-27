// app/api/index/site-check/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { normalizeHost } from "@/lib/google";
import { siteCheck, serpProvider, siteQuery, googleSearchUrl, QuotaError, SiteCheck } from "@/lib/serp";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Tells the browser whether a search provider is configured. */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const p = serpProvider();
    return NextResponse.json({ provider: p?.label || null, archives: p?.name === "serpapi" });
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
    if (!serpProvider()) {
      return NextResponse.json({ error: "site: checks need a search provider. Add SERPAPI_KEY (recommended) or SERPER_API_KEY to your environment variables and redeploy." }, { status: 400 });
    }

    // Only check URLs on this property, so search credits can't be spent on other sites
    const host = normalizeHost(siteUrl);
    const own = (u: string) => {
      try {
        const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
        return h === host || h.endsWith(`.${host}`);
      } catch {
        return false;
      }
    };

    let quotaExceeded = false;
    const results = await pool(urls.filter(own).slice(0, 20), 4, async (url): Promise<SiteCheck | null> => {
      if (quotaExceeded) return null;
      try {
        return await siteCheck(url);
      } catch (e) {
        if (e instanceof QuotaError) quotaExceeded = true;
        const query = siteQuery(url);
        return {
          url, query, status: "error", matchedUrl: "", resultsReturned: 0, results: [], provider: serpProvider()?.label || "",
          checkedAt: new Date().toISOString(), googleUrl: googleSearchUrl(query), error: e instanceof Error ? e.message : "Search failed",
        };
      }
    });
    return NextResponse.json({ results: results.filter(Boolean), quotaExceeded });
  } catch (e) {
    return fail(e);
  }
}
