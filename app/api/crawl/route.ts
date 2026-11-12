// app/api/crawl/route.ts
// GET only: Crawl stats saved in the Google Sheet. They're written only by the Chrome extension (through
// /api/capture), so nothing can be saved or deleted from the dashboard. Data saved earlier in Upstash Redis is
// copied over once, the first time the Sheet has none.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { sharedStorageReady, getJson } from "@/lib/kvStore";
import { loadCrawl, restoreCrawl } from "@/lib/reportStore";
import type { CrawlStore } from "@/lib/crawlStats";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    if (!site) throw new HttpError(400, "Missing site");
    const token = await getGoogleAccessToken(req);
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) {
      throw new HttpError(501, "The Google Sheet isn't set up. Add GOOGLE_SERVICE_ACCOUNT_JSON and INDEX_SHEET_ID in Vercel and redeploy.");
    }
    let store = await loadCrawl(site);
    if (!Object.keys(store.series).length && sharedStorageReady()) {
      const old = await getJson<CrawlStore>(`crawl:${site}`).catch(() => null);
      if (old && Object.keys(old.series || {}).length) {
        await restoreCrawl(site, old);
        store = await loadCrawl(site, true);
      }
    }
    return NextResponse.json({ store });
  } catch (e) {
    return fail(e);
  }
}
