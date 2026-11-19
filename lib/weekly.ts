// lib/weekly.ts
// The weekly report for the Data Demand properties (Weekly report tab). Server-only.
//
// Weeks run Monday to Sunday in Pacific time, because that's how Search Console counts days. The latest week is the one
// ending on the most recent Sunday. On Monday morning in India, Pacific Sunday is still running, so that week is
// "partial": its changes compare Monday–Saturday with the same days of earlier weeks until Sunday is over.
// Search Console figures use fresh data (dataState "all"), so the latest days are included before Google marks them final.
// GA4 uses the same dates, judged in the GA4 property's own time zone.
//
// Who can open it: WEEKLY_REPORT_EMAILS (default hsingh@kingsresearch.com).
// Which properties: WEEKLY_SITES (exact Search Console properties, comma-separated) or, when that isn't set, the
// properties whose address contains aitech, martech, readmagazine or itdigest. When a site has several Search Console
// properties (http and https, www and no www), the one with the most impressions in the last 28 days is used.
// Which GA4 property goes with each:
//   1. WEEKLY_GA4 ("readmagazine=123456789,aitech=987654321", keyed by name, host or Search Console property), if set;
//   2. otherwise every likely candidate — GA4 properties whose web stream has the site's address, GA4 properties whose
//      name contains the site's name ("Read Magazine - GA4" for readmagazine), and the pairing recorded in the control
//      Sheet's _Archive tab — and the one with the most sessions in the last 28 days wins, so an old or empty property
//      never beats the live one.
import type { NextRequest } from "next/server";
import { HttpError, requireUser } from "./token";
import {
  ga4TimeZone, latestFinalDate, listGa4Properties, listSitemaps, listSites, listWebStreamHosts, normalizeHost, runReport,
  saEndpoint, saRequest, searchAnalytics, searchAnalyticsAll, type SABody, type SARow,
} from "./google";
import { batchReports } from "./ga4-report";
import { readArchive } from "./archive";
import { GSC_TZ, addDays, todayIn } from "./dates";
import { pool } from "./api";
import { SOCIAL_CHANNELS, SOCIAL_SOURCE_PATTERN, networkOf } from "./socialSources";
import type { Source } from "./types";

/* ---------------- Access ---------------- */

const DEFAULT_WEEKLY_EMAILS = ["hsingh@kingsresearch.com"];

export function weeklyEmails() {
  const list = (process.env.WEEKLY_REPORT_EMAILS || "")
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_WEEKLY_EMAILS;
}

export const isWeeklyEmail = (email?: string | null) => !!email && weeklyEmails().includes(email.toLowerCase());

export async function requireWeeklyUser(req: NextRequest) {
  const email = await requireUser(req);
  if (!isWeeklyEmail(email)) throw new HttpError(403, "The weekly report is only available to its own account.");
  return email;
}

/* ---------------- Which properties ---------------- */

/** Part of each site's address used to find it. "readmagzine" is kept too, for the spelling used when this was set up. */
const DEFAULT_NAMES: { name: string; match: string[] }[] = [
  { name: "aitech", match: ["aitech"] },
  { name: "martech", match: ["martech"] },
  { name: "readmagazine", match: ["readmagazine", "readmagzine"] },
  { name: "itdigest", match: ["itdigest"] },
];

export type WeeklySite = { siteUrl: string; host: string; name: string; ga4: string | null; ga4Name: string | null };
export type WeeklySites = { sites: WeeklySite[]; missing: string[]; alsoMatched: Record<string, string[]> };

const siteCache = new Map<string, { at: number; v: WeeklySites }>();

/** Impressions over the last 28 days, to tell the property with the real data from near-empty duplicates
 *  (http:// vs https://, www vs no www). */
async function recentImpressions(token: string, siteUrl: string) {
  const end = todayIn(GSC_TZ);
  try {
    const rows = await searchAnalytics(token, siteUrl, { startDate: addDays(end, -28), endDate: end, dataState: "all", rowLimit: 1 });
    return rows[0]?.impressions ?? 0;
  } catch {
    return -1;
  }
}

/** GA4 sessions over the last 28 days, to tell the live GA4 property from an old or empty one. */
async function recentSessions(token: string, property: string) {
  try {
    const r = await runReport(token, property, { dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }], metrics: [{ name: "sessions" }] });
    return r.rows[0]?.mets[0] ?? 0;
  } catch {
    return -1;
  }
}

/** WEEKLY_GA4: "readmagazine=123456789,aitech.com=987654321" → { readmagazine: "123456789", … } */
function ga4Overrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (process.env.WEEKLY_GA4 || "").split(/[,\s]+/)) {
    const i = part.lastIndexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const id = part.slice(i + 1).trim().replace(/^properties\//, "");
    if (key && /^\d+$/.test(id)) out[key] = id;
  }
  return out;
}

/** "Read Magazine - GA4" → "readmagazinega4", so names can be compared with addresses. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function weeklySites(token: string): Promise<WeeklySites> {
  const k = token.slice(-32);
  const hit = siteCache.get(k);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.v;

  const all = await listSites(token);
  const exact = (process.env.WEEKLY_SITES || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const picked: { siteUrl: string; name: string }[] = [];
  const missing: string[] = [];
  const alsoMatched: Record<string, string[]> = {};

  if (exact.length) {
    for (const u of exact) {
      if (all.some((x) => x.siteUrl === u)) picked.push({ siteUrl: u, name: normalizeHost(u).split(".")[0] });
      else missing.push(u);
    }
  } else {
    for (const n of DEFAULT_NAMES) {
      const hits = all.filter((x) => n.match.some((m) => normalizeHost(x.siteUrl).includes(m)));
      if (!hits.length) {
        missing.push(n.name);
        continue;
      }
      // Several properties for the same site: use the one with the most impressions in the last 28 days
      // (a domain property wins a tie, since it covers every version of the address).
      let best = hits[0];
      if (hits.length > 1) {
        const scored = await Promise.all(hits.map(async (h) => ({ h, imp: await recentImpressions(token, h.siteUrl) })));
        const dom = (u: string) => (u.startsWith("sc-domain:") ? 1 : 0);
        scored.sort((a, b) => b.imp - a.imp || dom(b.h.siteUrl) - dom(a.h.siteUrl));
        best = scored[0].h;
      }
      picked.push({ siteUrl: best.siteUrl, name: n.name });
      const others = hits.filter((x) => normalizeHost(x.siteUrl) !== normalizeHost(best.siteUrl)).map((x) => x.siteUrl);
      if (others.length) alsoMatched[best.siteUrl] = others;
    }
  }

  const [props, archive] = await Promise.all([listGa4Properties(token).catch(() => []), readArchive().catch(() => [])]);
  const ga4 = await pool(props, 8, async (p) => ({ ...p, hosts: await listWebStreamHosts(token, p.id) }));
  const overrides = ga4Overrides();
  const recorded = new Map(archive.filter((a) => a.ga4).map((a) => [a.site, a.ga4]));
  const label = (g: { name: string; account: string }) => `${g.name} (${g.account})`;
  const named = (id: string) => {
    const g = ga4.find((x) => x.id === id);
    return g ? label(g) : `GA4 property ${id}`;
  };

  const sites = await Promise.all(
    picked.map(async (p): Promise<WeeklySite> => {
      const host = normalizeHost(p.siteUrl);
      const base = { siteUrl: p.siteUrl, host, name: p.name };

      // 1. Pinned in WEEKLY_GA4.
      const pinned = overrides[p.name.toLowerCase()] || overrides[host] || overrides[p.siteUrl.toLowerCase()];
      if (pinned) return { ...base, ga4: pinned, ga4Name: named(pinned) };

      // 2. Every likely candidate: same web stream address, a name containing the site's name, or the recorded pairing.
      const keys = Array.from(new Set([squash(p.name), squash(host.split(".")[0])])).filter((x) => x.length >= 4);
      const ids = new Set<string>();
      for (const g of ga4) {
        if (g.hosts.some((h) => h === host || h.endsWith(`.${host}`))) ids.add(g.id);
        if (keys.some((key) => squash(g.name).includes(key))) ids.add(g.id);
      }
      const saved = recorded.get(p.siteUrl);
      if (saved && ga4.some((g) => g.id === saved)) ids.add(saved);
      if (!ids.size) return { ...base, ga4: null, ga4Name: null };

      // The one with the most sessions in the last 28 days wins.
      const scored = await Promise.all(Array.from(ids).map(async (id) => ({ id, s: await recentSessions(token, id) })));
      scored.sort((a, b) => b.s - a.s);
      return { ...base, ga4: scored[0].id, ga4Name: named(scored[0].id) };
    })
  );

  const v = { sites, missing, alsoMatched };
  if (siteCache.size > 50) siteCache.clear();
  siteCache.set(k, { at: Date.now(), v });
  return v;
}

/* ---------------- Which week ---------------- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const minD = (a: string, b: string) => (a < b ? a : b);
export const mondayOf = (d: string) => addDays(d, -((dow(d) + 6) % 7));

export type WeekInfo = {
  start: string; // Monday
  end: string; // Sunday
  /** Days compared with earlier weeks: 7 once Sunday is over in Pacific time, else the days already finished. */
  compareDays: number;
  /** Sunday (Pacific) hasn't finished yet. */
  partial: boolean;
  /** Today in Pacific time. */
  today: string;
  /** Mondays of the weeks that can be opened, newest first. */
  weeks: string[];
};

export function weekInfo(requested?: string | null): WeekInfo {
  const today = todayIn(GSC_TZ);
  // On a Pacific Sunday the latest week is the one ending today; on any other day it's the one that ended last Sunday.
  const latest = dow(today) === 0 ? mondayOf(today) : addDays(mondayOf(today), -7);
  let start = latest;
  if (requested && DATE.test(requested)) {
    const m = mondayOf(requested);
    if (m <= latest && m >= addDays(latest, -7 * 66)) start = m; // Search Console keeps about 16 months
  }
  const end = addDays(start, 6);
  const compareDays = today > end ? 7 : Math.min(7, Math.max(1, dayDiff(start, today)));
  return { start, end, compareDays, partial: today <= end, today, weeks: Array.from({ length: 26 }, (_, i) => addDays(latest, -7 * i)) };
}

/* ---------------- Search Console ---------------- */

/** Rows read for the page and query lists of each week. */
const LIST_ROWS = 10_000;

export type DayState = "final" | "provisional" | "partial" | "future";
export type GscTotals = { clicks: number; impressions: number; ctr: number; position: number };
export type Mover = {
  key: string; clicks: number; prevClicks: number; change: number; impressions: number; position: number | null; prevPosition: number | null;
};
export type Split = { name: string; clicks: number; prevClicks: number; impressions: number };
export type NewQuery = { query: string; impressions: number; clicks: number; position: number };
export type SitemapRow = {
  path: string; submitted: number; indexed: number; errors: number; warnings: number; lastDownloaded: string; isPending: boolean; isIndex: boolean;
};
export type GscWeek = {
  finalThrough: string;
  days: (GscTotals & { date: string; state: DayState })[];
  /** Every day of the week that has data. */
  week: GscTotals;
  /** The compared days of this week, last week and the average of the 4 weeks before. */
  cmp: GscTotals;
  prev: GscTotals;
  avg4: GscTotals;
  pages: { withClicks: number; prevWithClicks: number; gainers: Mover[]; losers: Mover[] };
  queries: {
    withClicks: number; prevWithClicks: number; newCount: number; newTop: NewQuery[]; gainers: Mover[]; losers: Mover[];
    branded: { term: string; clicks: number; prevClicks: number; share: number; prevShare: number };
  };
  devices: Split[];
  countries: Split[];
  sitemaps: SitemapRow[] | null;
  listRows: number;
  request: SABody;
};

function agg(rows: SARow[]): GscTotals {
  let clicks = 0, impressions = 0, p = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    p += r.position * r.impressions;
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? p / impressions : 0 };
}

function movers(now: SARow[], prev: SARow[], n = 10) {
  const m = new Map<string, Mover>();
  for (const r of now) {
    m.set(r.keys[0], { key: r.keys[0], clicks: r.clicks, prevClicks: 0, change: 0, impressions: r.impressions, position: r.position, prevPosition: null });
  }
  for (const r of prev) {
    const x = m.get(r.keys[0]) || { key: r.keys[0], clicks: 0, prevClicks: 0, change: 0, impressions: 0, position: null, prevPosition: null };
    x.prevClicks = r.clicks;
    x.prevPosition = r.position;
    m.set(r.keys[0], x);
  }
  const all = Array.from(m.values()).map((x) => ({ ...x, change: x.clicks - x.prevClicks }));
  return {
    gainers: all.filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, n),
    losers: all.filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, n),
  };
}

function split(now: SARow[], prev: SARow[]): Split[] {
  const p = new Map(prev.map((r) => [r.keys[0], r.clicks]));
  return now
    .map((r) => ({ name: r.keys[0], clicks: r.clicks, prevClicks: p.get(r.keys[0]) ?? 0, impressions: r.impressions }))
    .sort((a, b) => b.clicks - a.clicks);
}

export async function gscWeek(token: string, site: WeeklySite, wk: WeekInfo): Promise<GscWeek> {
  const s = site.siteUrl;
  const cmpEnd = addDays(wk.start, wk.compareDays - 1);
  const pStart = addDays(wk.start, -7);
  const pEnd = addDays(pStart, wk.compareDays - 1);
  const request: SABody = { startDate: addDays(wk.start, -28), endDate: wk.end, dimensions: ["date"], dataState: "all", rowLimit: 100 };
  const q = (dim: string, from: string, to: string, max: number) =>
    searchAnalyticsAll(token, s, { startDate: from, endDate: to, dimensions: [dim], dataState: "all" }, max);

  const [finalThrough, daily, pNow, pPrev, qNow, qPrev, dNow, dPrev, cNow, cPrev, maps] = await Promise.all([
    latestFinalDate(token, s),
    searchAnalyticsAll(token, s, request, 100),
    q("page", wk.start, cmpEnd, LIST_ROWS),
    q("page", pStart, pEnd, LIST_ROWS),
    q("query", wk.start, cmpEnd, LIST_ROWS),
    q("query", pStart, pEnd, LIST_ROWS),
    q("device", wk.start, cmpEnd, 10),
    q("device", pStart, pEnd, 10),
    q("country", wk.start, cmpEnd, 300),
    q("country", pStart, pEnd, 300),
    listSitemaps(token, s).catch(() => null),
  ]);

  const between = (from: string, to: string) => daily.filter((r) => r.keys[0] >= from && r.keys[0] <= to);
  const byDate = new Map(daily.map((r) => [r.keys[0], r]));

  const days: GscWeek["days"] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(wk.start, i);
    const r = byDate.get(date);
    const state: DayState = date > wk.today ? "future" : date === wk.today ? "partial" : date <= finalThrough ? "final" : "provisional";
    days.push({ date, state, clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, ctr: r?.ctr ?? 0, position: r?.position ?? 0 });
  }

  // Average of the 4 weeks before, over the same days of the week.
  const windows = [1, 2, 3, 4].map((k) => between(addDays(wk.start, -7 * k), addDays(wk.start, -7 * k + wk.compareDays - 1)));
  const filled = windows.filter((w) => w.length).length || 1;
  const a4 = agg(windows.flat());
  const avg4 = { clicks: a4.clicks / filled, impressions: a4.impressions / filled, ctr: a4.ctr, position: a4.position };

  const term = site.name.toLowerCase();
  const brandClicks = (rows: SARow[]) =>
    rows.filter((r) => r.keys[0].toLowerCase().replace(/[\s.\-]+/g, "").includes(term)).reduce((t, r) => t + r.clicks, 0);
  const qClicks = (rows: SARow[]) => rows.reduce((t, r) => t + r.clicks, 0);
  const bNow = brandClicks(qNow), bPrev = brandClicks(qPrev);
  const prevQ = new Set(qPrev.map((r) => r.keys[0]));
  const fresh = qNow.filter((r) => !prevQ.has(r.keys[0]));
  const pm = movers(pNow, pPrev);
  const qm = movers(qNow, qPrev);

  const sum = (list: { submitted?: string; indexed?: string }[] | undefined, k: "submitted" | "indexed") =>
    (list || []).reduce((t, c) => t + (Number(c[k]) || 0), 0);

  return {
    finalThrough,
    days,
    week: agg(between(wk.start, wk.end)),
    cmp: agg(between(wk.start, cmpEnd)),
    prev: agg(between(pStart, pEnd)),
    avg4,
    pages: {
      withClicks: pNow.filter((r) => r.clicks > 0).length,
      prevWithClicks: pPrev.filter((r) => r.clicks > 0).length,
      gainers: pm.gainers,
      losers: pm.losers,
    },
    queries: {
      withClicks: qNow.filter((r) => r.clicks > 0).length,
      prevWithClicks: qPrev.filter((r) => r.clicks > 0).length,
      newCount: fresh.length,
      newTop: fresh
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 15)
        .map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, position: r.position })),
      gainers: qm.gainers,
      losers: qm.losers,
      branded: {
        term,
        clicks: bNow,
        prevClicks: bPrev,
        share: qClicks(qNow) ? bNow / qClicks(qNow) : 0,
        prevShare: qClicks(qPrev) ? bPrev / qClicks(qPrev) : 0,
      },
    },
    devices: split(dNow, dPrev),
    countries: split(cNow, cPrev).slice(0, 15),
    sitemaps: maps
      ? maps.map((m) => ({
          path: m.path,
          submitted: sum(m.contents, "submitted"),
          indexed: sum(m.contents, "indexed"),
          errors: Number(m.errors || 0),
          warnings: Number(m.warnings || 0),
          lastDownloaded: m.lastDownloaded || "",
          isPending: !!m.isPending,
          isIndex: !!m.isSitemapsIndex,
        }))
      : null,
    listRows: LIST_ROWS,
    request,
  };
}

/* ---------------- AI assistants ---------------- */

/** GA4 regular expression (RE2), matched anywhere in sessionSource, case-insensitive. */
export const AI_SOURCE_PATTERN =
  "chatgpt|openai|perplexity|gemini\\.google|bard\\.google|claude\\.ai|anthropic|copilot|edgeservices|deepseek|grok|x\\.ai|meta\\.ai|mistral|you\\.com|phind|poe\\.com|character\\.ai|kagi|felo\\.ai|iask\\.ai|andisearch";

const AI_TOOLS: [RegExp, string][] = [
  [/chatgpt|openai/i, "ChatGPT"],
  [/perplexity/i, "Perplexity"],
  [/gemini\.google|bard\.google/i, "Gemini"],
  [/claude\.ai|anthropic/i, "Claude"],
  [/copilot|edgeservices/i, "Copilot"],
  [/deepseek/i, "DeepSeek"],
  [/grok|x\.ai/i, "Grok"],
  [/meta\.ai/i, "Meta AI"],
  [/mistral/i, "Mistral"],
  [/you\.com/i, "You.com"],
  [/phind/i, "Phind"],
  [/poe\.com/i, "Poe"],
];
const aiToolOf = (source: string) => AI_TOOLS.find(([re]) => re.test(source))?.[1] || "Other AI";

export const AI_TOOL_LIST = "ChatGPT, Perplexity, Gemini, Claude, Copilot, DeepSeek, Grok, Meta AI, Mistral, You.com, Phind, Poe and others";

/* ---------------- GA4 ---------------- */

export type GaTotals = { sessions: number; engaged: number; keyEvents: number; views: number; users: number; newUsers: number };
/** Sessions grouped by AI assistant, social network or referring site. */
export type SourceGroup = { name: string; sessions: number; prevSessions: number; engaged: number; keyEvents: number };
export type GaWeek = {
  property: string;
  timeZone: string;
  partial: boolean;
  compareDays: number;
  days: { date: string; sessions: number; state: DayState }[];
  week: { sessions: number; keyEvents: number; views: number };
  cmp: GaTotals;
  prev: GaTotals;
  avg4: { sessions: number; keyEvents: number };
  channels: { name: string; sessions: number; prevSessions: number; keyEvents: number }[];
  social: { sessions: number; prevSessions: number };
  socialNetworks: SourceGroup[];
  ai: { sessions: number; prevSessions: number; engaged: number; keyEvents: number; tools: SourceGroup[]; landing: { page: string; sessions: number; keyEvents: number }[] };
  referrals: SourceGroup[];
  landing: { page: string; sessions: number; prevSessions: number | null }[];
  request: object[];
};

const names = (list: string[]) => list.map((name) => ({ name }));
const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const bySessions = [{ metric: { metricName: "sessions" }, desc: true }];

/** Rows from a report with two date ranges, grouped by name: date_range_0 = this week, date_range_1 = last week. */
function group(rows: Record<string, any>[] | undefined, nameOf: (r: Record<string, any>) => string): SourceGroup[] {
  const m = new Map<string, SourceGroup>();
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

export async function gaWeek(token: string, property: string, wk: WeekInfo): Promise<GaWeek> {
  const timeZone = await ga4TimeZone(token, property);
  const today = todayIn(timeZone);
  const compareDays = today > wk.end ? 7 : Math.min(7, Math.max(1, dayDiff(wk.start, today)));
  const cmp = { startDate: wk.start, endDate: addDays(wk.start, compareDays - 1) };
  const prev = { startDate: addDays(wk.start, -7), endDate: addDays(wk.start, compareDays - 8) };
  const hist = { startDate: addDays(wk.start, -28), endDate: minD(wk.end, today) };
  const social = {
    orGroup: {
      expressions: [
        { filter: { fieldName: "sessionDefaultChannelGroup", inListFilter: { values: SOCIAL_CHANNELS } } },
        { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: SOCIAL_SOURCE_PATTERN, caseSensitive: false } } },
      ],
    },
  };
  const ai = { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_SOURCE_PATTERN, caseSensitive: false } } };
  const referral = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Referral" } } };

  const main = [
    { dateRanges: [hist], dimensions: names(["date"]), metrics: names(["sessions", "engagedSessions", "keyEvents", "screenPageViews"]), limit: 100 },
    { dateRanges: [cmp, prev], metrics: names(["totalUsers", "newUsers"]) },
    { dateRanges: [cmp, prev], dimensions: names(["sessionDefaultChannelGroup"]), metrics: names(["sessions", "keyEvents"]), limit: 100 },
    { dateRanges: [cmp, prev], dimensionFilter: social, metrics: names(["sessions"]) },
    { dateRanges: [cmp, prev], dimensions: names(["landingPage"]), metrics: names(["sessions"]), orderBys: bySessions, limit: 80 },
  ];
  const sources = [
    { dateRanges: [cmp, prev], dimensionFilter: ai, dimensions: names(["sessionSource"]), metrics: names(["sessions", "engagedSessions", "keyEvents"]), limit: 500 },
    { dateRanges: [cmp], dimensionFilter: ai, dimensions: names(["landingPage"]), metrics: names(["sessions", "keyEvents"]), orderBys: bySessions, limit: 15 },
    { dateRanges: [cmp, prev], dimensionFilter: social, dimensions: names(["sessionSource"]), metrics: names(["sessions", "engagedSessions", "keyEvents"]), limit: 1000 },
    { dateRanges: [cmp, prev], dimensionFilter: referral, dimensions: names(["sessionSource"]), metrics: names(["sessions", "engagedSessions", "keyEvents"]), orderBys: bySessions, limit: 200 },
  ];
  const [[daily, users, channels, soc, landing], [aiRows, aiLanding, socRows, refRows]] = await Promise.all([
    batchReports(token, property, main),
    batchReports(token, property, sources),
  ]);

  const byDate = new Map<string, Record<string, any>>((daily || []).map((r) => [ymd(String(r.date)), r]));
  const sumD = (from: string, to: string, metric: string) => {
    let t = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) t += Number(byDate.get(d)?.[metric] || 0);
    return t;
  };
  const pick = (rows: Record<string, any>[] | undefined, k: string) => (rows || []).find((r) => r.dateRange === k) || {};
  const totals = (r: { startDate: string; endDate: string }, k: string): GaTotals => ({
    sessions: sumD(r.startDate, r.endDate, "sessions"),
    engaged: sumD(r.startDate, r.endDate, "engagedSessions"),
    keyEvents: sumD(r.startDate, r.endDate, "keyEvents"),
    views: sumD(r.startDate, r.endDate, "screenPageViews"),
    users: Number(pick(users, k).totalUsers || 0),
    newUsers: Number(pick(users, k).newUsers || 0),
  });

  let n4 = 0, s4 = 0, k4 = 0;
  for (const k of [1, 2, 3, 4]) {
    const from = addDays(wk.start, -7 * k);
    const to = addDays(from, compareDays - 1);
    const s = sumD(from, to, "sessions");
    if (s > 0) {
      n4++;
      s4 += s;
      k4 += sumD(from, to, "keyEvents");
    }
  }

  const ch = new Map<string, { name: string; sessions: number; prevSessions: number; keyEvents: number }>();
  for (const r of channels || []) {
    const name = String(r.sessionDefaultChannelGroup || "(other)");
    const x = ch.get(name) || { name, sessions: 0, prevSessions: 0, keyEvents: 0 };
    if (r.dateRange === "date_range_1") x.prevSessions += r.sessions || 0;
    else {
      x.sessions += r.sessions || 0;
      x.keyEvents += r.keyEvents || 0;
    }
    ch.set(name, x);
  }

  const prevLanding = new Map<string, number>();
  for (const r of landing || []) if (r.dateRange === "date_range_1") prevLanding.set(String(r.landingPage), r.sessions || 0);

  const days: GaWeek["days"] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(wk.start, i);
    const state: DayState = date > today ? "future" : date === today ? "partial" : date >= addDays(today, -2) ? "provisional" : "final";
    days.push({ date, sessions: Number(byDate.get(date)?.sessions || 0), state });
  }

  const tools = group(aiRows, (r) => aiToolOf(String(r.sessionSource || "")));
  const sumG = (list: SourceGroup[], k: keyof Omit<SourceGroup, "name">) => list.reduce((t, x) => t + x[k], 0);

  return {
    property,
    timeZone,
    partial: today <= wk.end,
    compareDays,
    days,
    week: { sessions: sumD(wk.start, wk.end, "sessions"), keyEvents: sumD(wk.start, wk.end, "keyEvents"), views: sumD(wk.start, wk.end, "screenPageViews") },
    cmp: totals(cmp, "date_range_0"),
    prev: totals(prev, "date_range_1"),
    avg4: { sessions: n4 ? s4 / n4 : 0, keyEvents: n4 ? k4 / n4 : 0 },
    channels: Array.from(ch.values()).sort((a, b) => b.sessions - a.sessions),
    social: { sessions: Number(pick(soc, "date_range_0").sessions || 0), prevSessions: Number(pick(soc, "date_range_1").sessions || 0) },
    socialNetworks: group(socRows, (r) => networkOf(String(r.sessionSource || ""))),
    ai: {
      sessions: sumG(tools, "sessions"),
      prevSessions: sumG(tools, "prevSessions"),
      engaged: sumG(tools, "engaged"),
      keyEvents: sumG(tools, "keyEvents"),
      tools,
      landing: (aiLanding || []).map((r) => ({ page: String(r.landingPage), sessions: r.sessions || 0, keyEvents: r.keyEvents || 0 })),
    },
    referrals: group(refRows, (r) => String(r.sessionSource || "(not set)")).slice(0, 15),
    landing: (landing || [])
      .filter((r) => r.dateRange !== "date_range_1")
      .slice(0, 15)
      .map((r) => ({ page: String(r.landingPage), sessions: r.sessions || 0, prevSessions: prevLanding.get(String(r.landingPage)) ?? null })),
    request: [...main, ...sources],
  };
}

/* ---------------- Status and summary ---------------- */

export type Status = "good" | "watch" | "problem" | "pending";
export type Area = { id: string; label: string; status: Status; note: string };

const RANK: Record<Status, number> = { pending: -1, good: 0, watch: 1, problem: 2 };
const worst = (...list: Status[]) => list.reduce<Status>((a, b) => (RANK[b] > RANK[a] ? b : a), "good");
const drop = (now: number, base: number): Status => {
  if (!base) return "good";
  const c = (now - base) / base;
  return c <= -0.2 ? "problem" : c <= -0.08 ? "watch" : "good";
};
/** AI visits are small and jumpy, so they're only judged once last week had at least this many. */
const AI_MIN_BASE = 20;

export const WEEKLY_RULES = [
  "Search performance and Traffic: Watch when clicks (or sessions) are 8% or more below last week or the 4-week average; Problem at 20% or more.",
  "Search performance: also Watch when the average position is more than 3 places worse than last week.",
  `AI visits: Watch when visits from AI assistants are 8% or more below last week, Problem at 20% or more; only judged when last week had at least ${AI_MIN_BASE}.`,
  "Sitemaps: Problem when any sitemap has errors; Watch when there are warnings, a sitemap is still pending, Google hasn't read one for 14 days, or none is submitted.",
  "Indexing, 404s, Crawling and Experience come from the extension captures and the daily index checks; they're added in the next update.",
];

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const chg = (now: number, base: number) => (base ? `${now >= base ? "+" : ""}${(((now - base) / base) * 100).toFixed(0)}%` : now ? "new" : "no change");
const pathOf = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";
const errText = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : "error") : undefined;

export type PropertyWeek = {
  site: string;
  host: string;
  name: string;
  ga4: string | null;
  ga4Name: string | null;
  week: WeekInfo;
  gsc: GscWeek | null;
  gscError?: string;
  ga: GaWeek | null;
  gaError?: string;
  areas: Area[];
  summary: string[];
  sources: Record<string, Source>;
  sourceIds: { gsc: string; ga: string; maps: string };
};

export async function propertyWeek(token: string, site: WeeklySite, wk: WeekInfo): Promise<PropertyWeek> {
  const [g, a] = await Promise.allSettled([gscWeek(token, site, wk), site.ga4 ? gaWeek(token, site.ga4, wk) : Promise.resolve(null)]);
  const gsc = g.status === "fulfilled" ? g.value : null;
  const ga = a.status === "fulfilled" ? a.value : null;
  const gscError = errText(g);
  const gaError = site.ga4 ? errText(a) : "No GA4 property is paired with this site. Set WEEKLY_GA4 in Vercel to pair it by hand.";

  const ids = { gsc: `wk.gsc.${site.siteUrl}`, ga: `wk.ga.${site.siteUrl}`, maps: `wk.maps.${site.siteUrl}` };
  const now = new Date().toISOString();
  const sources: Record<string, Source> = {};
  if (gsc) {
    sources[ids.gsc] = {
      id: ids.gsc,
      label: `Search Console: ${site.host}, ${wk.start} to ${wk.end}`,
      system: "Google Search Console API (searchAnalytics.query)",
      endpoint: saEndpoint(site.siteUrl),
      range: { startDate: wk.start, endDate: wk.end },
      fetchedAt: now,
      request: saRequest(gsc.request),
      formula:
        `Fresh data (dataState "all"), so days Google hasn't finalised yet are included. Changes compare the first ${wk.compareDays} day(s) ` +
        "of this week with the same days of last week, and with the average of the 4 weeks before. Position is weighted by impressions. " +
        `Page and query lists are the top ${n0(gsc.listRows)} rows of each week.`,
      verifyHow: `Search Console → Performance → Search results → Date → Custom: ${wk.start} to ${wk.end}. Recent days can differ slightly until Google finalises them (final through ${gsc.finalThrough}).`,
      verifyUrl: `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(site.siteUrl)}`,
    } as Source;
    sources[ids.maps] = {
      id: ids.maps,
      label: `Sitemaps: ${site.host}`,
      system: "Google Search Console API (sitemaps.list)",
      endpoint: `GET https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.siteUrl)}/sitemaps`,
      fetchedAt: now,
      verifyHow: "Search Console → Indexing → Sitemaps.",
      verifyUrl: `https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(site.siteUrl)}`,
    } as Source;
  }
  if (ga) {
    sources[ids.ga] = {
      id: ids.ga,
      label: `GA4: ${site.ga4Name || site.ga4}, ${wk.start} to ${wk.end}`,
      system: "Google Analytics 4 Data API (batchRunReports)",
      endpoint: `POST https://analyticsdata.googleapis.com/v1beta/properties/${ga.property}:batchRunReports`,
      range: { startDate: wk.start, endDate: wk.end },
      fetchedAt: now,
      request: { requests: ga.request },
      formula:
        `Dates in the GA4 property's time zone (${ga.timeZone}). Changes compare the first ${ga.compareDays} day(s) of this week with the same days of last week. ` +
        `AI visits = sessions whose source matches “${AI_SOURCE_PATTERN}” (${AI_TOOL_LIST}). Social = the Organic and Paid Social channels plus known ` +
        "social sources. Referrals = the Referral channel, so AI assistants filed there also appear in that list. GA4 can still adjust the last two days.",
      verifyHow:
        `GA4 → Reports → Acquisition → Traffic acquisition, dates ${wk.start} to ${wk.end}, compared with the previous period. ` +
        "Change the table to “Session source” and search for chatgpt, perplexity and so on.",
    } as Source;
  }

  const areas: Area[] = [];
  if (gsc) {
    const posWorse = gsc.prev.position ? gsc.cmp.position - gsc.prev.position : 0;
    areas.push({
      id: "search",
      label: "Search performance",
      status: worst(drop(gsc.cmp.clicks, gsc.prev.clicks), drop(gsc.cmp.clicks, gsc.avg4.clicks), posWorse > 3 ? "watch" : "good"),
      note: `Clicks ${chg(gsc.cmp.clicks, gsc.prev.clicks)} vs last week, ${chg(gsc.cmp.clicks, gsc.avg4.clicks)} vs the 4-week average`,
    });
  } else {
    areas.push({ id: "search", label: "Search performance", status: "pending", note: gscError || "No data" });
  }
  areas.push({ id: "indexing", label: "Indexing", status: "pending", note: "From the Page indexing captures and the daily index checks. Added in the next update." });
  areas.push({ id: "errors", label: "404s and errors", status: "pending", note: "404, soft 404 and server-error counts, and 404 pages still getting impressions. Added in the next update." });
  areas.push({ id: "crawl", label: "Crawling", status: "pending", note: "From the Crawl stats captures. Added in the next update." });
  if (gsc?.sitemaps) {
    const sm = gsc.sitemaps;
    const errs = sm.reduce((t, m) => t + m.errors, 0);
    const warns = sm.reduce((t, m) => t + m.warnings, 0);
    const pending = sm.filter((m) => m.isPending).length;
    const stale = sm.filter((m) => !m.lastDownloaded || dayDiff(m.lastDownloaded.slice(0, 10), wk.today) > 14).length;
    areas.push({
      id: "sitemaps",
      label: "Sitemaps",
      status: !sm.length ? "watch" : errs ? "problem" : warns || pending || stale ? "watch" : "good",
      note: !sm.length
        ? "No sitemap is submitted"
        : `${sm.length} sitemap(s) · ${errs} errors · ${warns} warnings${pending ? ` · ${pending} pending` : ""}${stale ? ` · ${stale} not read for 14+ days` : ""}`,
    });
  } else {
    areas.push({ id: "sitemaps", label: "Sitemaps", status: "pending", note: gscError || "Couldn't read the sitemaps" });
  }
  areas.push({
    id: "experience",
    label: "Experience and penalties",
    status: "pending",
    note: "Core Web Vitals, structured data, manual actions and security issues come from new extension captures.",
  });
  if (ga) {
    areas.push({
      id: "traffic",
      label: "Traffic outcome",
      status: worst(drop(ga.cmp.sessions, ga.prev.sessions), drop(ga.cmp.sessions, ga.avg4.sessions)),
      note: `Sessions ${chg(ga.cmp.sessions, ga.prev.sessions)} vs last week, ${chg(ga.cmp.sessions, ga.avg4.sessions)} vs the 4-week average`,
    });
    const top = ga.ai.tools.find((t) => t.sessions > 0);
    areas.push({
      id: "ai",
      label: "AI visits",
      status: ga.ai.prevSessions >= AI_MIN_BASE ? drop(ga.ai.sessions, ga.ai.prevSessions) : "good",
      note: `${n0(ga.ai.sessions)} visits from AI assistants (${chg(ga.ai.sessions, ga.ai.prevSessions)} vs last week)${top ? `, most from ${top.name}` : ""}`,
    });
  } else {
    areas.push({ id: "traffic", label: "Traffic outcome", status: "pending", note: gaError || "No GA4 data" });
    areas.push({ id: "ai", label: "AI visits", status: "pending", note: gaError || "No GA4 data" });
  }

  const summary: string[] = [];
  if (gsc) {
    const compared = wk.partial ? " (Monday to Saturday compared, because Sunday is still running in Google's time zone)" : "";
    summary.push(
      `Clicks ${n0(gsc.week.clicks)}${wk.partial ? " so far" : ""}: ${chg(gsc.cmp.clicks, gsc.prev.clicks)} vs last week and ${chg(gsc.cmp.clicks, gsc.avg4.clicks)} vs the 4-week average${compared}.`
    );
    const d = gsc.prev.position ? gsc.prev.position - gsc.cmp.position : 0;
    summary.push(
      `Impressions ${n0(gsc.week.impressions)} (${chg(gsc.cmp.impressions, gsc.prev.impressions)} vs last week); average position ${gsc.cmp.position.toFixed(1)}` +
        (Math.abs(d) >= 0.05 ? `, ${Math.abs(d).toFixed(1)} places ${d > 0 ? "better" : "worse"} than last week.` : ", unchanged.")
    );
    const up = gsc.pages.gainers[0];
    const dn = gsc.pages.losers[0];
    if (up) summary.push(`Biggest gain: ${pathOf(up.key)} (+${n0(up.change)} clicks).`);
    if (dn) summary.push(`Biggest loss: ${pathOf(dn.key)} (${n0(dn.change)} clicks).`);
    if (gsc.queries.newCount) summary.push(`${n0(gsc.queries.newCount)} queries got impressions this week that weren't in last week's list.`);
    const errs = (gsc.sitemaps || []).reduce((t, m) => t + m.errors, 0);
    if (errs) summary.push(`Sitemaps report ${n0(errs)} error(s).`);
  }
  if (ga) {
    summary.push(
      `GA4 sessions ${n0(ga.week.sessions)}: ${chg(ga.cmp.sessions, ga.prev.sessions)} vs last week; key events ${n0(ga.week.keyEvents)} (${chg(ga.cmp.keyEvents, ga.prev.keyEvents)}).`
    );
    if (ga.ai.sessions || ga.ai.prevSessions) {
      const top = ga.ai.tools.filter((t) => t.sessions > 0).slice(0, 2).map((t) => `${t.name} ${n0(t.sessions)}`);
      summary.push(
        `AI assistants sent ${n0(ga.ai.sessions)} visits (${chg(ga.ai.sessions, ga.ai.prevSessions)} vs last week)${top.length ? `: ${top.join(", ")}` : ""}${ga.ai.keyEvents ? `, with ${n0(ga.ai.keyEvents)} key events` : ""}.`
      );
    }
    const net = ga.socialNetworks.find((x) => x.sessions > 0);
    if (ga.social.sessions || ga.social.prevSessions) {
      summary.push(`Social media sent ${n0(ga.social.sessions)} visits (${chg(ga.social.sessions, ga.social.prevSessions)} vs last week)${net ? `, most from ${net.name}` : ""}.`);
    }
  }

  return {
    site: site.siteUrl, host: site.host, name: site.name, ga4: site.ga4, ga4Name: site.ga4Name, week: wk,
    gsc, gscError, ga, gaError, areas, summary, sources, sourceIds: ids,
  };
}
