// app/api/ga4/overview/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { ga4Endpoint, ga4Window, runRealtime, runReport, type GaReport } from "@/lib/google";
import { Recorder, ga4HomeUrl, GA4_EXPLORER } from "@/lib/provenance";
import { parseCompare, parseDays } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const METRICS = ["totalUsers", "activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration"];

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const p = req.nextUrl.searchParams;
    const id = p.get("property") || "";
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Missing property" }, { status: 400 });
    const days = parseDays(p.get("days"));
    // Full days ending yesterday in the property's own time zone — the same as GA4's "Last N days".
    const { current, previous, timeZone } = await ga4Window(token, id, days, parseCompare(p.get("compare"), days));
    const m = (names: string[]) => names.map((name) => ({ name }));
    const byDesc = (metric: string) => [{ metric: { metricName: metric }, desc: true }];
    const rec = new Recorder();
    const base = {
      system: "Google Analytics Data API (GA4)",
      verifyUrl: ga4HomeUrl(id),
      verifyLabel: "Open this GA4 property",
      explorerUrl: GA4_EXPLORER,
      explorerLabel: "Rerun this request in Google's GA4 Query Explorer",
    };
    const report = (sid: string, label: string, body: Record<string, any>, how: string) =>
      rec.call(
        { ...base, id: sid, label, endpoint: ga4Endpoint(id), request: body, range: body.dateRanges?.[0], verifyHow: how },
        () => runReport(token, id, body),
        (r: GaReport) => (r.totals.length ? [...r.rows, { totals: r.totals }] : r.rows)
      );
    const period = (r: { startDate: string; endDate: string }) => `set the date range to ${r.startDate} – ${r.endDate} (custom; property time zone ${timeZone})`;
    // TOTAL counts every country, not just the 20 rows returned.
    const realtimeBody = { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], metricAggregations: ["TOTAL"], limit: 20 };

    const [trend, prev, countries, cities, channels, landing, organic, realtime] = await Promise.all([
      report(
        "ga4.trend", "Users, sessions and page views by day (this period)",
        { dateRanges: [current], dimensions: [{ name: "date" }], metrics: m(METRICS), metricAggregations: ["TOTAL"], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400 },
        `GA4 → Reports → Reports snapshot, ${period(current)}. “Users” is GA4's Total users metric.`
      ),
      report("ga4.previous", "Totals for the comparison period", { dateRanges: [previous], metrics: m(METRICS) }, `GA4 → Reports → Reports snapshot, ${period(previous)}.`),
      report(
        "ga4.countries", "Users by country",
        { dateRanges: [current], dimensions: [{ name: "country" }, { name: "countryId" }], metrics: m(["totalUsers", "sessions", "engagementRate"]), orderBys: byDesc("totalUsers"), limit: 250 },
        `GA4 → Reports → User attributes → Demographic details (Country), ${period(current)}.`
      ),
      report(
        "ga4.cities", "Users by city",
        { dateRanges: [current], dimensions: [{ name: "city" }, { name: "country" }], metrics: m(["totalUsers", "sessions"]), orderBys: byDesc("totalUsers"), limit: 50 },
        `GA4 → Reports → User attributes → Demographic details (City), ${period(current)}.`
      ),
      report(
        "ga4.channels", "Sessions by channel",
        { dateRanges: [current], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: m(["sessions", "totalUsers"]), orderBys: byDesc("sessions"), limit: 20 },
        `GA4 → Reports → Acquisition → Traffic acquisition, ${period(current)}.`
      ),
      report(
        "ga4.landing", "Top landing pages",
        { dateRanges: [current], dimensions: [{ name: "landingPage" }], metrics: m(["sessions", "totalUsers", "engagementRate"]), orderBys: byDesc("sessions"), limit: 50 },
        `GA4 → Reports → Engagement → Landing page, ${period(current)}.`
      ),
      report(
        "ga4.organic", "Organic search sessions by day",
        {
          dateRanges: [current], dimensions: [{ name: "date" }], metrics: m(["sessions", "totalUsers"]),
          dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
          metricAggregations: ["TOTAL"], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400,
        },
        `GA4 → Reports → Acquisition → Traffic acquisition, row “Organic Search”, ${period(current)}.`
      ),
      rec
        .call(
          { ...base, id: "ga4.realtime", label: "Active users in the last 30 minutes", endpoint: ga4Endpoint(id, true), request: realtimeBody, verifyHow: "GA4 → Reports → Realtime. The number changes minute to minute." },
          () => runRealtime(token, id, realtimeBody),
          (r) => r.rows
        )
        .catch(() => null),
    ]);

    const obj = (vals: number[]) => Object.fromEntries(METRICS.map((k, i) => [k, vals[i] ?? 0]));
    const organicByDate = new Map(organic.rows.map((r) => [r.dims[0], r.mets[0]]));
    const fmtDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

    return NextResponse.json({
      sources: rec.sources,
      range: current,
      timeZone,
      totals: { current: obj(trend.totals), previous: obj(prev.rows[0]?.mets || []) },
      organicTotals: { sessions: organic.totals[0] ?? 0, users: organic.totals[1] ?? 0 },
      trend: trend.rows.map((r) => ({ date: fmtDate(r.dims[0]), users: r.mets[0], sessions: r.mets[3], views: r.mets[4], organicSessions: organicByDate.get(r.dims[0]) ?? 0 })),
      countries: countries.rows.map((r) => ({ country: r.dims[0], code: r.dims[1], users: r.mets[0], sessions: r.mets[1], engagementRate: r.mets[2] })),
      cities: cities.rows.map((r) => ({ city: r.dims[0], country: r.dims[1], users: r.mets[0], sessions: r.mets[1] })),
      channels: channels.rows.map((r) => ({ channel: r.dims[0], sessions: r.mets[0], users: r.mets[1] })),
      landingPages: landing.rows.map((r) => ({ page: r.dims[0], sessions: r.mets[0], users: r.mets[1], engagementRate: r.mets[2] })),
      realtime: realtime
        ? {
            activeUsers: realtime.totals[0] ?? realtime.rows.reduce((s, r) => s + r.mets[0], 0),
            countries: realtime.rows.map((r) => ({ country: r.dims[0], users: r.mets[0] })),
          }
        : null,
    });
  } catch (e) {
    return fail(e);
  }
}
