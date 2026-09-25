import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { runReport, runRealtime } from "@/lib/google";
import { ranges, parseDays } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const METRICS = ["totalUsers", "activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration"];

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const id = req.nextUrl.searchParams.get("property");
    if (!id || !/^\d+$/.test(id)) return NextResponse.json({ error: "Missing property" }, { status: 400 });
    const days = parseDays(req.nextUrl.searchParams.get("days"));
    const { current, previous } = ranges(days, "ga4");
    const m = (names: string[]) => names.map((name) => ({ name }));
    const byDesc = (metric: string) => [{ metric: { metricName: metric }, desc: true }];

    const [trend, prev, countries, cities, channels, landing, organic, realtime] = await Promise.all([
      runReport(token, id, {
        dateRanges: [current], dimensions: [{ name: "date" }], metrics: m(METRICS),
        metricAggregations: ["TOTAL"], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400,
      }),
      runReport(token, id, { dateRanges: [previous], metrics: m(METRICS) }),
      runReport(token, id, {
        dateRanges: [current], dimensions: [{ name: "country" }, { name: "countryId" }],
        metrics: m(["totalUsers", "sessions", "engagementRate"]), orderBys: byDesc("totalUsers"), limit: 250,
      }),
      runReport(token, id, {
        dateRanges: [current], dimensions: [{ name: "city" }, { name: "country" }],
        metrics: m(["totalUsers", "sessions"]), orderBys: byDesc("totalUsers"), limit: 50,
      }),
      runReport(token, id, {
        dateRanges: [current], dimensions: [{ name: "sessionDefaultChannelGroup" }],
        metrics: m(["sessions", "totalUsers"]), orderBys: byDesc("sessions"), limit: 20,
      }),
      runReport(token, id, {
        dateRanges: [current], dimensions: [{ name: "landingPage" }],
        metrics: m(["sessions", "totalUsers", "engagementRate"]), orderBys: byDesc("sessions"), limit: 50,
      }),
      runReport(token, id, {
        dateRanges: [current], dimensions: [{ name: "date" }], metrics: m(["sessions", "totalUsers"]),
        dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
        metricAggregations: ["TOTAL"], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400,
      }),
      runRealtime(token, id, { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], limit: 20 }).catch(() => null),
    ]);

    const obj = (vals: number[]) => Object.fromEntries(METRICS.map((k, i) => [k, vals[i] ?? 0]));
    const organicByDate = new Map(organic.rows.map((r) => [r.dims[0], r.mets[0]]));
    const fmtDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

    return NextResponse.json({
      range: current,
      totals: { current: obj(trend.totals), previous: obj(prev.rows[0]?.mets || []) },
      organicTotals: { sessions: organic.totals[0] ?? 0, users: organic.totals[1] ?? 0 },
      trend: trend.rows.map((r) => ({
        date: fmtDate(r.dims[0]), users: r.mets[0], sessions: r.mets[3], views: r.mets[4],
        organicSessions: organicByDate.get(r.dims[0]) ?? 0,
      })),
      countries: countries.rows.map((r) => ({ country: r.dims[0], code: r.dims[1], users: r.mets[0], sessions: r.mets[1], engagementRate: r.mets[2] })),
      cities: cities.rows.map((r) => ({ city: r.dims[0], country: r.dims[1], users: r.mets[0], sessions: r.mets[1] })),
      channels: channels.rows.map((r) => ({ channel: r.dims[0], sessions: r.mets[0], users: r.mets[1] })),
      landingPages: landing.rows.map((r) => ({ page: r.dims[0], sessions: r.mets[0], users: r.mets[1], engagementRate: r.mets[2] })),
      realtime: realtime
        ? { activeUsers: realtime.rows.reduce((s, r) => s + r.mets[0], 0), countries: realtime.rows.map((r) => ({ country: r.dims[0], users: r.mets[0] })) }
        : null,
    });
  } catch (e) {
    return fail(e);
  }
}
