// app/api/ga4/overview/route.ts
// "Users" everywhere in this route is GA4's Active users — the metric GA4's own reports show — so numbers match GA4 exactly.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { ga4Endpoint, ga4Window, runRealtime, runReport, type GaReport } from "@/lib/google";
import { Recorder, ga4HomeUrl, ga4RealtimeUrl, ga4ReportName, ga4ReportUrl, GA4_EXPLORER, type Ga4Report } from "@/lib/provenance";
import { parseCompare, parseDays } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const METRICS = ["totalUsers", "activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration"];

type Range = { startDate: string; endDate: string };
type Link = { label: string; url: string };

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
      explorerUrl: GA4_EXPLORER,
      explorerLabel: "Rerun this request in Google's GA4 Query Explorer",
    };

    // Links into GA4's own reports, opened on the same dates (and comparison dates) as the dashboard.
    const open = (r: Ga4Report, range: Range, cmp: Range | null, what: string): Link => ({
      label: `${what}: ${ga4ReportName(r)}`,
      url: ga4ReportUrl(id, r, range, cmp),
    });
    const report = (sid: string, label: string, body: Record<string, any>, how: string, links: Link[]) =>
      rec.call(
        {
          ...base, id: sid, label, endpoint: ga4Endpoint(id), request: body, range: body.dateRanges?.[0], verifyHow: how,
          verifyUrl: links[0]?.url ?? ga4HomeUrl(id),
          verifyLabel: links[0]?.label ?? "Open this GA4 property",
          links: links.slice(1),
        },
        () => runReport(token, id, body),
        (r: GaReport) => (r.totals.length ? [...r.rows, { totals: r.totals }] : r.rows)
      );
    const period = (r: Range) => `${r.startDate} – ${r.endDate} (property time zone ${timeZone})`;
    const opens = (r: Range, cmp?: Range | null) =>
      `The buttons open GA4 on ${period(r)}${cmp ? `, compared with ${cmp.startDate} – ${cmp.endDate}` : ""}.`;
    const totalsHow = (r: Range, cmp: Range | null) =>
      `${opens(r, cmp)} Check the totals row at the top of each table: Demographic details shows Active users and New users, ` +
      `Traffic acquisition shows Sessions and Engagement rate, and Pages and screens shows Views. ` +
      `Average session duration isn't a default column; add it with Customize report (pencil icon).`;
    // TOTAL counts every country, not just the 20 rows returned.
    const realtimeBody = { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], metricAggregations: ["TOTAL"], limit: 20 };

    const [trend, prev, countries, cities, channels, landing, organic, realtime] = await Promise.all([
      report(
        "ga4.trend", "Active users, sessions and page views by day (this period)",
        { dateRanges: [current], dimensions: [{ name: "date" }], metrics: m(METRICS), metricAggregations: ["TOTAL"], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400 },
        totalsHow(current, previous),
        [
          open("country", current, previous, "Active users and new users"),
          open("traffic", current, previous, "Sessions and engagement rate"),
          open("pages", current, previous, "Views"),
        ]
      ),
      report(
        "ga4.previous", "Totals for the comparison period",
        { dateRanges: [previous], metrics: m(METRICS) },
        totalsHow(previous, null),
        [
          open("country", previous, null, "Active users and new users"),
          open("traffic", previous, null, "Sessions and engagement rate"),
          open("pages", previous, null, "Views"),
        ]
      ),
      report(
        "ga4.countries", "Active users by country",
        { dateRanges: [current], dimensions: [{ name: "country" }, { name: "countryId" }], metrics: m(["activeUsers", "sessions", "engagementRate"]), orderBys: byDesc("activeUsers"), limit: 250 },
        `${opens(current)} One row per country; compare the Active users column.`,
        [open("country", current, null, "Active users by country")]
      ),
      report(
        "ga4.cities", "Active users by city",
        { dateRanges: [current], dimensions: [{ name: "city" }, { name: "country" }], metrics: m(["activeUsers", "sessions"]), orderBys: byDesc("activeUsers"), limit: 50 },
        `${opens(current)} One row per city; compare the Active users column.`,
        [open("city", current, null, "Active users by city")]
      ),
      report(
        "ga4.channels", "Sessions by channel",
        { dateRanges: [current], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: m(["sessions", "activeUsers"]), orderBys: byDesc("sessions"), limit: 20 },
        `${opens(current)} One row per channel group; compare the Sessions column.`,
        [open("traffic", current, null, "Sessions by channel")]
      ),
      report(
        "ga4.landing", "Top landing pages",
        { dateRanges: [current], dimensions: [{ name: "landingPage" }], metrics: m(["sessions", "activeUsers", "engagementRate"]), orderBys: byDesc("sessions"), limit: 50 },
        `GA4 → Reports → Engagement → Landing page, dates ${period(current)}. GA4 has no stable link for this report, so the button opens the property.`,
        []
      ),
      report(
        "ga4.organic", "Organic search sessions by day",
        {
          dateRanges: [current], dimensions: [{ name: "date" }], metrics: m(["sessions", "activeUsers"]),
          dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
          metricAggregations: ["TOTAL"], orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400,
        },
        `${opens(current)} Look at the “Organic Search” row of Traffic acquisition.`,
        [open("traffic", current, null, "Organic Search sessions")]
      ),
      rec
        .call(
          {
            ...base, id: "ga4.realtime", label: "Active users in the last 30 minutes", endpoint: ga4Endpoint(id, true), request: realtimeBody,
            verifyUrl: ga4RealtimeUrl(id), verifyLabel: "Open GA4 Realtime",
            verifyHow: "GA4 → Reports → Realtime. The number changes minute to minute.",
          },
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
      // users = activeUsers (index 1 of METRICS)
      trend: trend.rows.map((r) => ({ date: fmtDate(r.dims[0]), users: r.mets[1], sessions: r.mets[3], views: r.mets[4], organicSessions: organicByDate.get(r.dims[0]) ?? 0 })),
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
