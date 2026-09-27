// app/api/gsc/inspect/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { inspectUrl } from "@/lib/google";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The URL Inspection API allows ~2,000 calls/day and 600/minute per property.
export async function POST(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const { siteUrl, urls } = (await req.json()) as { siteUrl: string; urls: string[] };
    if (!siteUrl || !Array.isArray(urls)) return NextResponse.json({ error: "Missing siteUrl or urls" }, { status: 400 });

    let quotaExceeded = false;
    const results = await pool(urls.slice(0, 25), 5, async (url) => {
      if (quotaExceeded) return null;
      try {
        return { ...(await inspectUrl(token, siteUrl, url)), checkedAt: new Date().toISOString() };
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) quotaExceeded = true;
        return { url, verdict: "ERROR", coverageState: e instanceof Error ? e.message : "Failed", indexingState: "", lastCrawlTime: "", googleCanonical: "", link: "", checkedAt: new Date().toISOString() };
      }
    });

    return NextResponse.json({ results: results.filter(Boolean), quotaExceeded });
  } catch (e) {
    return fail(e);
  }
}
