// app/api/ga4/ai-traffic/route.ts
// Site-wide visits from AI assistants (GA4 sessions whose source is ChatGPT, Perplexity, Gemini, Copilot, Claude and others):
// totals vs the comparison period, share of all sessions, by assistant, by day and by landing page.
// Same window as every other GA4 view: full days ending yesterday in the property's time zone.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { ga4Window } from "@/lib/google";
import { batchReports } from "@/lib/ga4-report";
import { addDays, parseCompare, parseDays, type Range } from "@/lib/dates";
import { AI_SOURCE_PATTERN, assistantOf } from "@/lib/aiSources";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily rows: periods can be up to 16 months (486 days). */
const DAILY_LIMIT = 1000;

type Totals = { sessions: number; users: number; engaged: number; keyEvents: number };
export type AiAssistantRow = {
  name: string;
  sessions: number;
  prevSessions: number;
  users: number;
  engaged: number;
  keyEvents: number;
  sources: string[];
};
export type AiTrafficResponse = {
  timeZone: string;
  range: Range;
  previousRange: Range;
  totals: { current: Totals; previous: Totals };
  siteSessions: { current: number; previous: number };
  assistants: AiAssistantRow[];
  daily: { date: string; sessions: number }[];
  pages: { page: string; sessions: number; engaged: number; keyEvents: number }[];
};

type Row = Record<string, any>;
const metrics = (names: string[]) => names.map((name) => ({ name }));
const dims = (names: string[]) => names.map((name) => ({ name }));
const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const pick = (rows: Row[] | undefined, key: string): Row => (rows || []).find((r) => r.dateRange === key) || {};
const totals = (r: Row): Totals => ({
  sessions: r.sessions || 0,
  users: r.totalUsers || 0,
  engaged: r.engagedSessions || 0,
  keyEvents: r.keyEvents || 0,
});

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
    const fromAi = {
      filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_SOURCE_PATTERN, caseSensitive: false } },
    };

    const r = await batchReports(token, property, [
      { dateRanges: both, dimensionFilter: fromAi, metrics: metrics(["sessions", "totalUsers", "engagedSessions", "keyEvents"]) },
      { dateRanges: both, metrics: metrics(["sessions"]) },
      {
        dateRanges: both,
        dimensionFilter: fromAi,
        dimensions: dims(["sessionSource"]),
        metrics: metrics(["sessions", "totalUsers", "engagedSessions", "keyEvents"]),
        limit: 200,
      },
      { dateRanges: [win.current], dimensionFilter: fromAi, dimensions: dims(["date"]), metrics: metrics(["sessions"]), limit: DAILY_LIMIT },
      {
        dateRanges: [win.current],
        dimensionFilter: fromAi,
        dimensions: dims(["landingPage"]),
        metrics: metrics(["sessions", "engagedSessions", "keyEvents"]),
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 200,
      },
    ]);

    // Group sources into assistants (chatgpt.com and chat.openai.com are both ChatGPT, and so on).
    const groups = new Map<string, AiAssistantRow & { set: Set<string> }>();
    for (const row of r[2] || []) {
      const source = String(row.sessionSource || "");
      const name = assistantOf(source);
      const g = groups.get(name) || { name, sessions: 0, prevSessions: 0, users: 0, engaged: 0, keyEvents: 0, sources: [], set: new Set<string>() };
      if (row.dateRange === "date_range_1") g.prevSessions += row.sessions || 0;
      else {
        g.sessions += row.sessions || 0;
        g.users += row.totalUsers || 0;
        g.engaged += row.engagedSessions || 0;
        g.keyEvents += row.keyEvents || 0;
      }
      g.set.add(source);
      groups.set(name, g);
    }
    const assistants: AiAssistantRow[] = Array.from(groups.values())
      .map(({ set, ...g }) => ({ ...g, sources: Array.from(set) }))
      .sort((a, b) => b.sessions - a.sessions || b.prevSessions - a.prevSessions);

    // Every day of the period, including days with no AI visits.
    const byDay = new Map((r[3] || []).map((row) => [ymd(String(row.date)), row.sessions || 0] as [string, number]));
    const daily: { date: string; sessions: number }[] = [];
    for (let d = win.current.startDate; d <= win.current.endDate && daily.length < DAILY_LIMIT; d = addDays(d, 1)) {
      daily.push({ date: d, sessions: byDay.get(d) || 0 });
    }

    const body: AiTrafficResponse = {
      timeZone: win.timeZone,
      range: win.current,
      previousRange: win.previous,
      totals: { current: totals(pick(r[0], "date_range_0")), previous: totals(pick(r[0], "date_range_1")) },
      siteSessions: { current: pick(r[1], "date_range_0").sessions || 0, previous: pick(r[1], "date_range_1").sessions || 0 },
      assistants,
      daily,
      pages: (r[4] || []).map((row) => ({
        page: String(row.landingPage || ""),
        sessions: row.sessions || 0,
        engaged: row.engagedSessions || 0,
        keyEvents: row.keyEvents || 0,
      })),
    };
    return NextResponse.json(body);
  } catch (e) {
    return fail(e);
  }
}
