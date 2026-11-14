// app/api/ga4/page/route.ts
// GA4 numbers for one page: views and users on the page, sessions that started on it (with their sources),
// visits from AI assistants, daily views, countries and devices. Same window as every other GA4 view:
// full days ending yesterday in the property's time zone, compared with the chosen comparison period.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { ga4Window } from "@/lib/google";
import { batchReports } from "@/lib/ga4-report";
import { parseCompare, parseDays, type Range } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Session sources that are AI assistants (domains and the utm_source names they use). */
const AI_SOURCE = /chatgpt|openai|perplexity|gemini\.google|bard\.google|copilot|claude\.ai|anthropic|deepseek|grok|meta\.ai|mistral|phind|you\.com|poe\.com/i;
/** Daily rows: periods can be up to 16 months (486 days). */
const DAILY_LIMIT = 1000;

type PageTotals = { views: number; users: number; engagementSec: number; keyEvents: number };
type LandingTotals = { sessions: number; users: number; engagedSessions: number; keyEvents: number };
export type Ga4SourceRow = { channel: string; source: string; medium: string; sessions: number; engaged: number; keyEvents: number };
export type Ga4PageResponse = {
  property: string;
  timeZone: string;
  path: string;
  range: Range;
  previousRange: Range;
  page: { current: PageTotals; previous: PageTotals };
  landing: { current: LandingTotals; previous: LandingTotals };
  daily: { date: string; views: number; users: number }[];
  sources: Ga4SourceRow[];
  ai: { sessions: number; sources: { source: string; sessions: number }[] };
  countries: { country: string; users: number; views: number }[];
  devices: { device: string; users: number; views: number }[];
};

type Row = Record<string, any>;
const metrics = (names: string[]) => names.map((name) => ({ name }));
const dims = (names: string[]) => names.map((name) => ({ name }));
const inList = (fieldName: string, values: string[]) => ({ filter: { fieldName, inListFilter: { values, caseSensitive: true } } });
const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
/** GA4 may record a page with or without its trailing slash, so ask for both. */
const variants = (p: string) => {
  const bare = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  return Array.from(new Set([bare, bare === "/" ? "/" : `${bare}/`]));
};
const pick = (rows: Row[] | undefined, key: string): Row => (rows || []).find((r) => r.dateRange === key) || {};
const pageTotals = (r: Row): PageTotals => ({
  views: r.screenPageViews || 0,
  users: r.activeUsers || 0,
  engagementSec: r.userEngagementDuration || 0,
  keyEvents: r.keyEvents || 0,
});
const landingTotals = (r: Row): LandingTotals => ({
  sessions: r.sessions || 0,
  users: r.totalUsers || 0,
  engagedSessions: r.engagedSessions || 0,
  keyEvents: r.keyEvents || 0,
});

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const property = p.get("property") || "";
    if (!/^\d+$/.test(property)) throw new HttpError(400, "Choose a GA4 property first.");
    const path = p.get("path") || "";
    if (!path.startsWith("/") || path.length > 1000) throw new HttpError(400, "Invalid page path");
    const days = parseDays(p.get("days"));
    const compare = parseCompare(p.get("compare"), days);
    const token = await getGoogleAccessToken(req);
    const win = await ga4Window(token, property, days, compare);
    const both = [win.current, win.previous];
    const onPage = inList("pagePath", variants(path));
    const landedOn = inList("landingPage", variants(path));

    const [a, b] = await Promise.all([
      batchReports(token, property, [
        { dateRanges: both, dimensionFilter: onPage, metrics: metrics(["screenPageViews", "activeUsers", "userEngagementDuration", "keyEvents"]) },
        { dateRanges: both, dimensionFilter: landedOn, metrics: metrics(["sessions", "totalUsers", "engagedSessions", "keyEvents"]) },
        {
          dateRanges: [win.current],
          dimensionFilter: onPage,
          dimensions: dims(["date"]),
          metrics: metrics(["screenPageViews", "activeUsers"]),
          orderBys: [{ dimension: { dimensionName: "date" } }],
          limit: DAILY_LIMIT,
        },
        {
          dateRanges: [win.current],
          dimensionFilter: landedOn,
          dimensions: dims(["sessionDefaultChannelGroup", "sessionSource", "sessionMedium"]),
          metrics: metrics(["sessions", "engagedSessions", "keyEvents"]),
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: 100,
        },
        {
          dateRanges: [win.current],
          dimensionFilter: onPage,
          dimensions: dims(["country"]),
          metrics: metrics(["activeUsers", "screenPageViews"]),
          orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
          limit: 15,
        },
      ]),
      batchReports(token, property, [
        {
          dateRanges: [win.current],
          dimensionFilter: onPage,
          dimensions: dims(["deviceCategory"]),
          metrics: metrics(["activeUsers", "screenPageViews"]),
          limit: 10,
        },
      ]),
    ]);

    const sources: Ga4SourceRow[] = (a[3] || []).map((r) => ({
      channel: String(r.sessionDefaultChannelGroup || ""),
      source: String(r.sessionSource || ""),
      medium: String(r.sessionMedium || ""),
      sessions: r.sessions || 0,
      engaged: r.engagedSessions || 0,
      keyEvents: r.keyEvents || 0,
    }));
    const aiRows = sources.filter((s) => AI_SOURCE.test(s.source));

    const body: Ga4PageResponse = {
      property,
      timeZone: win.timeZone,
      path,
      range: win.current,
      previousRange: win.previous,
      page: { current: pageTotals(pick(a[0], "date_range_0")), previous: pageTotals(pick(a[0], "date_range_1")) },
      landing: { current: landingTotals(pick(a[1], "date_range_0")), previous: landingTotals(pick(a[1], "date_range_1")) },
      daily: (a[2] || []).map((r) => ({ date: ymd(String(r.date)), views: r.screenPageViews || 0, users: r.activeUsers || 0 })),
      sources,
      ai: {
        sessions: aiRows.reduce((s, r) => s + r.sessions, 0),
        sources: aiRows.map((r) => ({ source: r.source, sessions: r.sessions })),
      },
      countries: (a[4] || []).map((r) => ({ country: String(r.country || ""), users: r.activeUsers || 0, views: r.screenPageViews || 0 })),
      devices: (b[0] || []).map((r) => ({ device: String(r.deviceCategory || ""), users: r.activeUsers || 0, views: r.screenPageViews || 0 })),
    };
    return NextResponse.json(body);
  } catch (e) {
    return fail(e);
  }
}
