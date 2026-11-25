// app/api/weekly/property/route.ts
// One property's week: Search Console, sitemaps and GA4, with statuses and a short summary.
import { NextRequest, NextResponse } from "next/server";
import { HttpError, getGoogleAccessToken } from "@/lib/token";
import { propertyWeek, requireWeeklyUser, weekInfo, weeklySites } from "@/lib/weekly";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  try {
    const { sites: chosen } = await requireWeeklyUser(req);
    const p = req.nextUrl.searchParams;
    const token = await getGoogleAccessToken(req);
    const { sites } = await weeklySites(token, chosen);
    const site = sites.find((s) => s.siteUrl === (p.get("site") || ""));
    if (!site) throw new HttpError(404, "This property isn't part of your weekly report.");
    return NextResponse.json(await propertyWeek(token, site, weekInfo(p.get("week"))));
  } catch (e) {
    return fail(e);
  }
}
