// app/api/gsc/inspect/route.ts
// URL Inspection for up to 20 URLs of one property. Google allows about 2,000 inspections per property per day
// (and 600 per minute). A 429 is never saved as a result: the URL comes back in "skipped" and is retried later.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { assertSiteAccess, errorInspection, inspectUrl, type InspectionResult } from "@/lib/google";
import { urlInProperty } from "@/lib/url";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const siteUrl = String(body.siteUrl || "");
    await assertSiteAccess(token, siteUrl);
    const asked: string[] = Array.isArray(body.urls) ? body.urls.map(String) : [];
    const urls = Array.from(new Set(asked.filter((u) => urlInProperty(siteUrl, u)))).slice(0, 20);
    let quotaExceeded = false;
    let rateLimited = false;
    const skipped: string[] = [];
    const results = await pool(urls, 4, async (url): Promise<InspectionResult | null> => {
      if (quotaExceeded || rateLimited) {
        skipped.push(url);
        return null;
      }
      try {
        return await inspectUrl(token, siteUrl, url);
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
          if (/minute/i.test(e.message)) rateLimited = true;
          else quotaExceeded = true;
          skipped.push(url);
          return null;
        }
        return errorInspection(url, e instanceof Error ? e.message : "Inspection failed");
      }
    });
    return NextResponse.json({
      results: results.filter(Boolean),
      skipped,
      quotaExceeded,
      rateLimited,
      notAccepted: asked.length - urls.length,
    });
  } catch (e) {
    return fail(e);
  }
}
