// app/api/ga4/overview/route.ts
// "Users" everywhere in this route is GA4's Active users — the metric GA4's own reports show — so numbers match GA4 exactly.
//
// Speed and reliability:
// - Every Google call has a time limit (lib/google.ts), so a slow answer fails in seconds with a clear message instead of
//   running into Vercel's 60-second limit (which shows up as a bare 504).
// - Totals, the daily trend and organic sessions are required. Countries, cities, channels, landing pages and realtime
//   are optional: if one of them fails, everything else is still returned and "partial" lists what was left out.
// - Complete answers are kept for 3 minutes per person, property, period and comparison, and identical requests made at
//   the same moment share one set of Google calls. Add &fresh=1 to skip the saved answer.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser } from "@/lib/token";
import { ga4Endpoint, ga4Window, runRealtime, runReport, type GaReport } from "@/lib/google";
import { Recorder, ga4HomeUrl, ga4RealtimeUrl, ga4ReportName, ga4ReportUrl, GA4_EXPLORER, type Ga4Report } from "@/lib/provenance";
import { parseCompare, parseDays, type Compare } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const METRICS = ["totalUsers", "activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration"];

/** How long a complete answer is reused. The dashboard auto-refreshes every 10 minutes, so that always gets fresh data. */
const CACHE_MS = 3 * 60_000;
const MAX_CACHED = 200;

type Range = { startDate: string; endDate: string };
type Link = { label: string; url: string };
type Built = { body: Record<string, unknown>; complete: boolean };

const cache = new Map<string, { at: number; body: Record<string, unknown> }>();
const inflight = new Map<string, Promise<Built>>();

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const email = await requireUser(req);
    const p = req.nextUrl.searchParams;
    const id = p.get("property") || "";
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: "Missing property" }, { status: 400 });
    const days = parseDays(p.get("days"));
    const compare = parseCompare(p.get("compare"), days);
    // Per person: GA4 checks each person's own access, so one person's saved answer is never shown to another.
    const key = `${email.toLowerCase()}|${id}|${days}|${compare}`;

    const hit = cache.get(key);
    if (p.get("fresh") !== "1" && hit && Date.now() - hit.at < CACHE_MS) {
      return NextResponse.json(hit.body, { headers: { "x-cache": "hit" } });
    }

    let job = inflight.get(key);
    if (!job) {
      job = build(token, id, days, compare).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const { body, complete } = await job;
    if (complete) {
      if (cache.size >= MAX_CACHED) cache.clear();
      cache.set(key, { at: Date.now(), body });
    }
    return NextResponse.json(body, { headers: { "x-cache": "miss" } });
  } catch (e) {
    return fail(e);
  }
}

async function build(token: string, id: string, days: number, compare: Compare): Promise<Built> {
  // Full days ending yesterday in the property's own time zone — the same as GA4's "Last N days".
  const { current, previous, timeZone } = await ga4Window(token, id, days, compare);
  const m = (names: string[]) => names.map((name) => ({ name }));
  const byDesc = (metric: string) => [{ metric: { metricName: metric }, desc: true }];
  const rec = new Recorder();
  const base = {
    system: "Google Analytics Data API (GA4)",
    explorerUrl: GA4_EXPLORER,
    explorerLabel: "Rerun this request in Google's GA4 Query Explorer",
  };

  // Parts that can be left out without making the rest wrong. A failure is noted in "partial" instead of failing everything.
  const skipped: string[] = [];
  const optional = <T,>(name: string, task: Promise<T>, fallback: T): Promise<T> =>
    task.catch((e) => {
      skipped.push(`${name}: ${e instanceof Error ? e.message : "failed"}`);
      return fallback;
    });
  const EMPTY: GaReport = { rows: [], totals: [] };

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
    // Required: totals and the daily chart.
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
    // Required: without it every change figure would compare against zero.
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
    optional(
      "Countries",
      report(
        "ga4.countries", "Active users by country",
        { dateRanges: [current], dimensions: [{ name: "country" }, { name: "countryId" }], metrics: m(["activeUsers", "sessions", "engagementRate"]), orderBys: byDesc("activeUsers"), limit: 250 },
        `${opens(current)} One row per country; compare the Active users column.`,
        [open("country", current, null, "Active users by country")]
      ),
      EMPTY
    ),
    optional(
      "Cities",
      report(
        "ga4.cities", "Active users by city",
        { dateRanges: [current], dimensions: [{ name: "city" }, { name: "country" }], metrics: m(["activeUsers", "sessions"]), orderBys: byDesc("activeUsers"), limit: 50 },
        `${opens(current)} One row per city; compare the Active users column.`,
        [open("city", current, null, "Active users by city")]
      ),
      EMPTY
    ),
    optional(
      "Channels",
      report(
        "ga4.channels", "Sessions by channel",
        { dateRanges: [current], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: m(["sessions", "activeUsers"]), orderBys: byDesc("sessions"), limit: 20 },
        `${opens(current)} One row per channel group; compare the Sessions column.`,
        [open("traffic", current, null, "Sessions by channel")]
      ),
      EMPTY
    ),
    optional(
      "Landing pages",
      report(
        "ga4.landing", "Top landing pages",
        { dateRanges: [current], dimensions: [{ name: "landingPage" }], metrics: m(["sessions", "activeUsers", "engagementRate"]), orderBys: byDesc("sessions"), limit: 50 },
        `GA4 → Reports → Engagement → Landing page, dates ${period(current)}. GA4 has no stable link for this report, so the button opens the property.`,
        []
      ),
      EMPTY
    ),
    // Required: a missing report here would show as zero organic sessions, which would be wrong rather than empty.
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
    optional(
      "Realtime",
      rec.call(
        {
          ...base, id: "ga4.realtime", label: "Active users in the last 30 minutes", endpoint: ga4Endpoint(id, true), request: realtimeBody,
          verifyUrl: ga4RealtimeUrl(id), verifyLabel: "Open GA4 Realtime",
          verifyHow: "GA4 → Reports → Realtime. The number changes minute to minute.",
        },
        () => runRealtime(token, id, realtimeBody),
        (r: GaReport) => r.rows
      ),
      null as GaReport | null
    ),
  ]);

  const obj = (vals: number[]) => Object.fromEntries(METRICS.map((k, i) => [k, vals[i] ?? 0]));
  const organicByDate = new Map(organic.rows.map((r) => [r.dims[0], r.mets[0]]));
  const fmtDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

  return {
    complete: skipped.length === 0,
    body: {
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
      // What was left out because Google didn't answer in time or returned an error (only present when something was).
      partial: skipped.length ? skipped : undefined,
    },
  };
}
