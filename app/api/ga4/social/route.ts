// app/api/ga4/social/route.ts
// Visits from social media (lib/socialSources.ts): totals vs the comparison period, share of all sessions, each network,
// every landing page each network sent visitors to, tagged links (UTM campaigns) and sessions per day.
// Same window as every other GA4 view: full days ending yesterday in the property's time zone.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { ga4Window } from "@/lib/google";
import { batchReports } from "@/lib/ga4-report";
import { addDays, parseCompare, parseDays, type Range } from "@/lib/dates";
import { SOCIAL_CHANNELS, SOCIAL_SOURCE_PATTERN, networkOf } from "@/lib/socialSources";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Source × landing page rows read from GA4. */
const PAGE_LIMIT = 25_000;
/** Day × source rows (periods can be up to 16 months). */
const DAILY_LIMIT = 25_000;
/** GA4's campaign values for sessions without a utm_campaign tag. */
const UNTAGGED = new Set(["(not set)", "(referral)", "(organic)", "(direct)", "(none)"]);

type Totals = { sessions: number; users: number; engaged: number; keyEvents: number };
export type SocialNetworkRow = {
  name: string; sessions: number; prevSessions: number; users: number; engaged: number; durationSec: number; keyEvents: number; sources: string[];
};
export type SocialPageRow = {
  network: string; page: string; sessions: number; users: number; engaged: number; durationSec: number; keyEvents: number; sources: string;
};
export type SocialCampaignRow = {
  network: string; campaign: string; source: string; medium: string; sessions: number; engaged: number; keyEvents: number;
};
export type SocialResponse = {
  timeZone: string;
  range: Range;
  previousRange: Range;
  totals: { current: Totals; previous: Totals };
  siteSessions: { current: number; previous: number };
  networks: SocialNetworkRow[];
  pages: SocialPageRow[];
  campaigns: SocialCampaignRow[];
  daily: { date: string; total: number; byNetwork: Record<string, number> }[];
  pagesCapped: boolean;
};

type Row = Record<string, any>;
const names = (list: string[]) => list.map((name) => ({ name }));
const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const pick = (rows: Row[] | undefined, key: string): Row => (rows || []).find((r) => r.dateRange === key) || {};
const totals = (r: Row): Totals => ({
  sessions: r.sessions || 0,
  users: r.totalUsers || 0,
  engaged: r.engagedSessions || 0,
  keyEvents: r.keyEvents || 0,
});
const bySessions = [{ metric: { metricName: "sessions" }, desc: true }];

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const property = p.get("property") || "";
    if (!/^\d+$/.test(property)) throw new HttpError(400, "Choose a GA4 property first.");
    const days = parseDays(p.get("days"));
    const compare = parseCompare(p.get("compare"), days);
    const token = await getGoogleAccessToken(req);
    const win = await ga4Window(token, property, days, compare);
    const both = [win.current, win.previous];

    const social = {
      orGroup: {
        expressions: [
          { filter: { fieldName: "sessionDefaultChannelGroup", inListFilter: { values: SOCIAL_CHANNELS } } },
          {
            filter: {
              fieldName: "sessionSource",
              stringFilter: { matchType: "PARTIAL_REGEXP", value: SOCIAL_SOURCE_PATTERN, caseSensitive: false },
            },
          },
        ],
      },
    };
    const MET = names(["sessions", "totalUsers", "engagedSessions", "userEngagementDuration", "keyEvents"]);

    const [a, b] = await Promise.all([
      batchReports(token, property, [
        { dateRanges: both, dimensionFilter: social, metrics: names(["sessions", "totalUsers", "engagedSessions", "keyEvents"]) },
        { dateRanges: both, metrics: names(["sessions"]) },
        { dateRanges: both, dimensionFilter: social, dimensions: names(["sessionSource", "sessionMedium"]), metrics: MET, limit: 2000 },
      ]),
      batchReports(token, property, [
        {
          dateRanges: [win.current],
          dimensionFilter: social,
          dimensions: names(["sessionSource", "landingPage"]),
          metrics: MET,
          orderBys: bySessions,
          limit: PAGE_LIMIT,
        },
        {
          dateRanges: [win.current],
          dimensionFilter: social,
          dimensions: names(["sessionSource", "sessionMedium", "sessionCampaignName"]),
          metrics: names(["sessions", "engagedSessions", "keyEvents"]),
          orderBys: bySessions,
          limit: 5000,
        },
        { dateRanges: [win.current], dimensionFilter: social, dimensions: names(["date", "sessionSource"]), metrics: names(["sessions"]), limit: DAILY_LIMIT },
      ]),
    ]);

    // Networks: sources grouped (linkedin.com, lnkd.in and linkedin are all LinkedIn).
    const nets = new Map<string, SocialNetworkRow & { set: Set<string> }>();
    for (const r of a[2] || []) {
      const source = String(r.sessionSource || "(not set)");
      const medium = String(r.sessionMedium || "(not set)");
      const name = networkOf(source);
      const g = nets.get(name) || { name, sessions: 0, prevSessions: 0, users: 0, engaged: 0, durationSec: 0, keyEvents: 0, sources: [], set: new Set<string>() };
      if (r.dateRange === "date_range_1") g.prevSessions += r.sessions || 0;
      else {
        g.sessions += r.sessions || 0;
        g.users += r.totalUsers || 0;
        g.engaged += r.engagedSessions || 0;
        g.durationSec += r.userEngagementDuration || 0;
        g.keyEvents += r.keyEvents || 0;
      }
      g.set.add(`${source} / ${medium}`);
      nets.set(name, g);
    }
    const networks: SocialNetworkRow[] = Array.from(nets.values())
      .map(({ set, ...g }) => ({ ...g, sources: Array.from(set) }))
      .sort((x, y) => y.sessions - x.sessions || y.prevSessions - x.prevSessions);

    // Landing pages per network (one row per network and page, its sources merged).
    const pageMap = new Map<string, SocialPageRow & { set: Set<string> }>();
    for (const r of b[0] || []) {
      const source = String(r.sessionSource || "(not set)");
      const network = networkOf(source);
      const page = String(r.landingPage || "(not set)");
      const key = `${network}\u0000${page}`;
      const g = pageMap.get(key) || { network, page, sessions: 0, users: 0, engaged: 0, durationSec: 0, keyEvents: 0, sources: "", set: new Set<string>() };
      g.sessions += r.sessions || 0;
      g.users += r.totalUsers || 0;
      g.engaged += r.engagedSessions || 0;
      g.durationSec += r.userEngagementDuration || 0;
      g.keyEvents += r.keyEvents || 0;
      g.set.add(source);
      pageMap.set(key, g);
    }
    const pages: SocialPageRow[] = Array.from(pageMap.values())
      .map(({ set, ...g }) => ({ ...g, sources: Array.from(set).join(", ") }))
      .sort((x, y) => y.sessions - x.sessions);

    // Tagged links only (utm_campaign set).
    const campaigns: SocialCampaignRow[] = (b[1] || [])
      .filter((r) => !UNTAGGED.has(String(r.sessionCampaignName || "(not set)")))
      .map((r) => ({
        network: networkOf(String(r.sessionSource || "")),
        campaign: String(r.sessionCampaignName),
        source: String(r.sessionSource || ""),
        medium: String(r.sessionMedium || ""),
        sessions: r.sessions || 0,
        engaged: r.engagedSessions || 0,
        keyEvents: r.keyEvents || 0,
      }));

    // Every day of the period, by network.
    const byDay = new Map<string, Record<string, number>>();
    for (const r of b[2] || []) {
      const date = ymd(String(r.date));
      const net = networkOf(String(r.sessionSource || ""));
      const o = byDay.get(date) || {};
      o[net] = (o[net] || 0) + (r.sessions || 0);
      byDay.set(date, o);
    }
    const daily: SocialResponse["daily"] = [];
    for (let d = win.current.startDate; d <= win.current.endDate && daily.length < 1000; d = addDays(d, 1)) {
      const o = byDay.get(d) || {};
      daily.push({ date: d, total: Object.values(o).reduce((s, v) => s + v, 0), byNetwork: o });
    }

    const body: SocialResponse = {
      timeZone: win.timeZone,
      range: win.current,
      previousRange: win.previous,
      totals: { current: totals(pick(a[0], "date_range_0")), previous: totals(pick(a[0], "date_range_1")) },
      siteSessions: { current: pick(a[1], "date_range_0").sessions || 0, previous: pick(a[1], "date_range_1").sessions || 0 },
      networks,
      pages,
      campaigns,
      daily,
      pagesCapped: (b[0] || []).length >= PAGE_LIMIT,
    };
    return NextResponse.json(body);
  } catch (e) {
    return fail(e);
  }
}
