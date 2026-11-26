// app/api/ga4/signals/route.ts
// Extra GA4 figures for the Overview summary (lib/insights.ts): key events, visits from AI assistants and referral visits
// from spam-looking domains, for the period and comparison picked in the top bar. One GA4 batch call with 5 reports.
// Same window as every other GA4 view: full days ending yesterday in the property's time zone. AI assistants are matched
// with lib/aiSources.ts, the same list the Overview's "Visits from AI assistants" panel uses.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { ga4Window } from "@/lib/google";
import { batchReports } from "@/lib/ga4-report";
import { parseCompare, parseDays, type Range } from "@/lib/dates";
import { AI_SOURCE_PATTERN, assistantOf } from "@/lib/aiSources";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Referrer domains that are almost always spam (cheap throwaway domains such as teloogoonickel.xyz). */
const SPAM_HOST =
  /\.(xyz|top|click|icu|buzz|monster|cyou|sbs|cfd|rest|quest|lol|bond|autos|boats|hair|beauty|skin|makeup|homes|yachts|mom)$/i;

type Row = Record<string, any>;
type Totals = { sessions: number; engaged: number; keyEvents: number };
export type SignalGroup = { name: string; sessions: number; prevSessions: number; engaged: number; keyEvents: number };
export type SignalsResponse = {
  timeZone: string;
  range: Range;
  previousRange: Range;
  site: { current: Totals; previous: Totals };
  ai: {
    current: Totals;
    previous: { sessions: number };
    tools: SignalGroup[];
    pages: { page: string; sessions: number; engaged: number; keyEvents: number }[];
  };
  referrals: { current: number; previous: number };
  spam: { current: number; previous: number; sites: SignalGroup[] };
  keyEventPages: { page: string; keyEvents: number; sessions: number }[];
};

const names = (list: string[]) => list.map((name) => ({ name }));
const bySessions = [{ metric: { metricName: "sessions" }, desc: true }];

/** Rows from a report with two date ranges, grouped by name: date_range_0 = this period, date_range_1 = the comparison. */
function group(rows: Row[] | undefined, nameOf: (r: Row) => string): SignalGroup[] {
  const m = new Map<string, SignalGroup>();
  for (const r of rows || []) {
    const name = nameOf(r);
    const x = m.get(name) || { name, sessions: 0, prevSessions: 0, engaged: 0, keyEvents: 0 };
    if (r.dateRange === "date_range_1") x.prevSessions += r.sessions || 0;
    else {
      x.sessions += r.sessions || 0;
      x.engaged += r.engagedSessions || 0;
      x.keyEvents += r.keyEvents || 0;
    }
    m.set(name, x);
  }
  return Array.from(m.values()).sort((a, b) => b.sessions - a.sessions || b.prevSessions - a.prevSessions);
}

const sumOf = (list: SignalGroup[], k: "sessions" | "prevSessions" | "engaged" | "keyEvents") => list.reduce((t, x) => t + x[k], 0);

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

    const ai = {
      filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_SOURCE_PATTERN, caseSensitive: false } },
    };
    const referral = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Referral" } } };

    const reports = await batchReports(token, property, [
      // 0. Whole site: sessions, engaged sessions and key events, this period and the comparison
      { dateRanges: both, metrics: names(["sessions", "engagedSessions", "keyEvents"]) },
      // 1. AI assistants by source, both periods
      { dateRanges: both, dimensionFilter: ai, dimensions: names(["sessionSource"]), metrics: names(["sessions", "engagedSessions", "keyEvents"]), limit: 500 },
      // 2. Pages AI assistants sent visitors to (this period)
      {
        dateRanges: [win.current], dimensionFilter: ai, dimensions: names(["landingPage"]),
        metrics: names(["sessions", "engagedSessions", "keyEvents"]), orderBys: bySessions, limit: 200,
      },
      // 3. Referral sources, both periods (spam-looking domains are picked out below)
      { dateRanges: both, dimensionFilter: referral, dimensions: names(["sessionSource"]), metrics: names(["sessions", "engagedSessions"]), orderBys: bySessions, limit: 1000 },
      // 4. Landing pages by key events (this period)
      {
        dateRanges: [win.current], dimensions: names(["landingPage"]), metrics: names(["keyEvents", "sessions"]),
        orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }], limit: 100,
      },
    ]);
    const [totalRows, aiRows, aiPageRows, refRows, kePageRows] = [0, 1, 2, 3, 4].map((i) => (reports[i] || []) as Row[]);

    const totals = (key: string): Totals => {
      const r = totalRows.find((x) => x.dateRange === key) || {};
      return { sessions: r.sessions || 0, engaged: r.engagedSessions || 0, keyEvents: r.keyEvents || 0 };
    };
    const tools = group(aiRows, (r) => assistantOf(String(r.sessionSource || "")));
    const refs = group(refRows, (r) => String(r.sessionSource || "(not set)"));
    const spam = refs.filter((x) => SPAM_HOST.test(x.name));

    const body: SignalsResponse = {
      timeZone: win.timeZone,
      range: win.current,
      previousRange: win.previous,
      site: { current: totals("date_range_0"), previous: totals("date_range_1") },
      ai: {
        current: { sessions: sumOf(tools, "sessions"), engaged: sumOf(tools, "engaged"), keyEvents: sumOf(tools, "keyEvents") },
        previous: { sessions: sumOf(tools, "prevSessions") },
        tools,
        pages: aiPageRows.map((r) => ({
          page: String(r.landingPage || "(not set)"), sessions: r.sessions || 0, engaged: r.engagedSessions || 0, keyEvents: r.keyEvents || 0,
        })),
      },
      referrals: { current: sumOf(refs, "sessions"), previous: sumOf(refs, "prevSessions") },
      spam: { current: sumOf(spam, "sessions"), previous: sumOf(spam, "prevSessions"), sites: spam.slice(0, 50) },
      keyEventPages: kePageRows
        .filter((r) => (r.keyEvents || 0) > 0)
        .map((r) => ({ page: String(r.landingPage || "(not set)"), keyEvents: r.keyEvents || 0, sessions: r.sessions || 0 })),
    };
    return NextResponse.json(body);
  } catch (e) {
    return fail(e);
  }
}
