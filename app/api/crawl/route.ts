// app/api/crawl/route.ts
// Crawl stats (from the "Copy crawl stats" bookmark, its exports, or the Chrome extension), saved for everyone in the
// Google Sheet. Data saved earlier in Upstash Redis is copied over once, the first time the Sheet has none.
// Only signed-in users who can open the property in Search Console can read or change it.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { sharedStorageReady, getJson, delKey } from "@/lib/kvStore";
import { clearCrawl, loadCrawl, restoreCrawl, saveCrawl } from "@/lib/reportStore";
import type { CrawlStore } from "@/lib/crawlStats";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const oldKey = (site: string) => `crawl:${site}`;

async function checkAccess(req: NextRequest, site: string) {
  if (!site) throw new HttpError(400, "Missing site");
  const token = await getGoogleAccessToken(req);
  await assertSiteAccess(token, site);
  if (!serviceAccountReady()) {
    throw new HttpError(501, "The Google Sheet isn't set up yet, so crawl data can only be saved in this browser. Add GOOGLE_SERVICE_ACCOUNT_JSON and INDEX_SHEET_ID in Vercel and redeploy.");
  }
}

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    let store = await loadCrawl(site);
    if (!Object.keys(store.series).length && sharedStorageReady()) {
      const old = await getJson<CrawlStore>(oldKey(site)).catch(() => null);
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const site = typeof body.site === "string" ? body.site : "";
    await checkAccess(req, site);
    const email = await requireUser(req);
    const incoming: unknown[] = Array.isArray(body.series) ? body.series.slice(0, 10) : [];
    if (!incoming.length) throw new HttpError(400, "Nothing to save.");
    const { store, saved } = await saveCrawl(site, incoming as object[], email, "Crawl stats");
    if (!saved) throw new HttpError(400, "No valid daily data to save.");
    return NextResponse.json({ store });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    await clearCrawl(site, await requireUser(req));
    if (sharedStorageReady()) await delKey(oldKey(site)).catch(() => {});
    return NextResponse.json({ store: { series: {}, imports: [] } });
  } catch (e) {
    return fail(e);
  }
}
