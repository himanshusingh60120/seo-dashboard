// app/api/gsc/fresh/route.ts
// Near-real-time signal for the Live index monitor, from Search Console's fresh data (a few hours behind).
// 1) Site-wide impressions per hour for the last ~3 days (dataState HOURLY_ALL).
// 2) Per page, per day for the last 10 days (dataState "all", includes today's partial day). Pages that had
//    impressions on 4+ of the 6 baseline days, averaging ≥3 a day, and none in the latest 2 days are
//    "suspected drops". They are only hints: the monitor confirms them with URL Inspection.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { assertSiteAccess, searchAnalytics, searchAnalyticsAll } from "@/lib/google";
import { GSC_TZ, addDays, todayIn } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX = 100_000;

type P = { page: string; baselineDays: number; baselineImpr: number; recent: number; lastSeen: string; impressions: number; clicks: number };

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const siteUrl = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, siteUrl);
    const today = todayIn(GSC_TZ);

    let hourly: { hour: string; clicks: number; impressions: number }[] = [];
    let hourlyAvailable = false;
    for (const dim of ["HOUR", "hour"]) {
      try {
        const rows = await searchAnalytics(token, siteUrl, { startDate: addDays(today, -2), endDate: today, dimensions: [dim], dataState: "HOURLY_ALL", rowLimit: 500 });
        hourly = rows
          .map((r) => ({ hour: r.keys[0], clicks: r.clicks, impressions: r.impressions }))
          .sort((a, b) => Date.parse(a.hour) - Date.parse(b.hour));
        hourlyAvailable = true;
        break;
      } catch {
        /* try the other spelling, then carry on without hourly data */
      }
    }

    const rows = await searchAnalyticsAll(token, siteUrl, { startDate: addDays(today, -9), endDate: today, dimensions: ["date", "page"], dataState: "all" }, MAX);
    const capped = rows.length >= MAX;
    const dates = Array.from(new Set(rows.map((r) => r.keys[0]))).sort();
    const asOf = dates[dates.length - 1] || today;
    const recentFrom = addDays(asOf, -1);
    const baseFrom = addDays(asOf, -7);
    const baseTo = addDays(asOf, -2);

    const pages = new Map<string, P>();
    for (const r of rows) {
      const [date, page] = r.keys;
      const p = pages.get(page) || { page, baselineDays: 0, baselineImpr: 0, recent: 0, lastSeen: "", impressions: 0, clicks: 0 };
      p.impressions += r.impressions;
      p.clicks += r.clicks;
      if (r.impressions > 0 && date > p.lastSeen) p.lastSeen = date;
      if (date >= baseFrom && date <= baseTo && r.impressions > 0) {
        p.baselineDays++;
        p.baselineImpr += r.impressions;
      }
      if (date >= recentFrom) p.recent += r.impressions;
      pages.set(page, p);
    }

    // When the 100,000-row limit is hit, low-traffic rows can be cut, so only clearly regular pages count.
    const minAvg = capped ? 20 : 3;
    const out = (p: P) => ({
      page: p.page, baselineDays: p.baselineDays, baselineAvg: Math.round((p.baselineImpr / 6) * 10) / 10,
      recent: p.recent, lastSeen: p.lastSeen, impressions: p.impressions, clicks: p.clicks,
    });
    const all = Array.from(pages.values());
    const suspected = all
      .filter((p) => p.baselineDays >= 4 && p.baselineImpr / 6 >= minAvg && p.recent === 0)
      .sort((a, b) => b.baselineImpr - a.baselineImpr)
      .slice(0, 300)
      .map(out);
    const top = all.slice().sort((a, b) => b.impressions - a.impressions).slice(0, 300).map(out);

    return NextResponse.json({
      asOf,
      recentDays: [recentFrom, asOf],
      hourly: hourly.slice(-72),
      hourlyAvailable,
      pagesSeenRecent: all.filter((p) => p.recent > 0).length,
      pagesSeenTotal: all.length,
      suspected,
      top,
      capped,
    });
  } catch (e) {
    return fail(e);
  }
}
