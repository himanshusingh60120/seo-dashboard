// app/api/gsc/sitemap-urls/route.ts
// Sitemaps and URL lists for the Indexing tab and the Live index monitor (the reading itself is in lib/sitemapReader.ts).
//
//   GET  ?site=…&mode=list                → every sitemap file found, with URL counts, for the sitemap picker.
//   POST { site, sitemaps, includeSearch } → URL list from the chosen sitemap files, plus pages with impressions if asked.
//   GET  ?site=…                           → every sitemap plus pages with impressions (used by the audit).
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { collect, discover, MAX_FILES } from "@/lib/sitemapReader";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const siteUrl = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, siteUrl);
    if (req.nextUrl.searchParams.get("mode") === "list") return NextResponse.json(await discover(token, siteUrl));
    return NextResponse.json(await collect(token, siteUrl, null, true));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const siteUrl = typeof body.site === "string" ? body.site : "";
    await assertSiteAccess(token, siteUrl);
    const raw: unknown[] = Array.isArray(body.sitemaps) ? body.sitemaps : [];
    const chosen = Array.from(new Set(raw.filter((s): s is string => typeof s === "string" && /^https?:\/\//i.test(s)))).slice(0, MAX_FILES);
    const includeSearch = body.includeSearch === true;
    if (!chosen.length && !includeSearch) throw new HttpError(400, "Choose at least one sitemap, or include pages with search impressions.");
    return NextResponse.json(await collect(token, siteUrl, chosen, includeSearch));
  } catch (e) {
    return fail(e);
  }
}
