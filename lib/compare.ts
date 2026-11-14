// lib/compare.ts
// Month-by-month comparisons from the saved history (lib/archive.ts), for the dashboard's Compare months mode.
// Everything comes from the Google Sheets, so months Search Console no longer shows can be compared too.
//
// How the numbers are put together, so they match Google:
// - Search Console clicks and impressions are added up from the saved daily totals; CTR = clicks ÷ impressions;
//   average position is weighted by impressions (exactly how Search Console averages over a date range).
// - GA4 sessions, new users, views and key events are added up; engagement rate and average session duration are
//   weighted by sessions. Active users can't be added up (the same person visits in several months): one month uses
//   GA4's own monthly figure, consecutive months (or a trimmed month) are asked from GA4 directly, anything else is a labelled sum.
// - Like for like: when one period ends in a part month (say 1–11 Nov 2026) and the other period has the matching month
//   in full, that month is counted to the same day (1–11 Nov 2025), so totals and charts compare equal days.
//   Monthly lists (pages, queries, landing pages) can't be trimmed and still cover whole months; a note says so.
// - Pages, queries and landing pages come from each month's saved lists (each month's top 1,000 are read); countries,
//   devices and channels are read in full. Totals always come from the daily data, so they're exact.
// - Visits from AI assistants (ChatGPT, Perplexity, Gemini…) are asked from GA4 live, by day, so they can be trimmed too.
// - AI page lists cover the date range of the capture they came from, so they're shown per capture, never added up.
//
// Google Sheets allows 60 read requests per minute for the service account, shared by everyone using the dashboard.
// So this file reads as little as possible: each Sheet's tab list is kept for 60 seconds, the property's saved history
// for 2 minutes, and finished comparisons for 2 minutes. When Google still says "quota exceeded", reads wait and retry.
// Server-only.
import { batchRead, colLetter, tabs, type Book, type Row } from "./sheets";
import { SEC, sectionRange, type SectionKey } from "./sheetLayout";
import { findSheet } from "./sheetBooks";
import { AI_PAGES_PREFIX, listTabs, type Part } from "./sheetParts";
import { GA4_PREFIX, SEARCH_PREFIX, readArchive } from "./archive";
import { IDX_LABEL } from "./indexStats";
import { runReport } from "./google";
import { GSC_TZ, addDays, todayIn } from "./dates";
import { AI_SOURCE_PATTERN, assistantOf } from "./aiSources";

const GOOGLE_KEEPS_DAYS = 486;
/** Rows read per month for long lists (pages, queries, landing pages). */
const TOP_PER_MONTH = 1000;
/** Rows sent per list per period. */
const OUT_LIMIT = 1000;
/** How long things read from the Sheets are reused. */
const TABS_MS = 60_000;
const BASE_MS = 2 * 60_000;
const RESULT_MS = 2 * 60_000;
const MAX_RESULTS = 100;
/** Waits before retrying a read that hit Google's per-minute quota (about 40 seconds in total). */
const RETRY_WAITS = [2_000, 5_000, 10_000, 20_000];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH = /^\d{4}-\d{2}$/;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const s = (v: unknown) => (v == null ? "" : String(v).trim());
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const monthOf = (d: string) => d.slice(0, 7);
const shiftMonth = (m: string, k: number) => {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const monthEnd = (m: string) => addDays(`${shiftMonth(m, 1)}-01`, -1);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const minD = (a: string, b: string) => (a < b ? a : b);
const gaDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const mName = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const isRun = (ms: string[]) => ms.every((m, i) => i === 0 || shiftMonth(ms[i - 1], 1) === m);
const uniqSorted = (ms: string[]) => [...new Set(ms)].filter((m) => MONTH.test(m)).sort();

export type SearchTotals = { clicks: number; impressions: number; ctr: number; position: number; days: number };
export type GaTotals = {
  users: number; usersExact: boolean; newUsers: number; sessions: number; views: number; engagementRate: number;
  avgSessionSec: number; keyEvents: number | null; organicSessions: number; days: number;
};
export type MonthRow = {
  month: string; from: string; through: string; partial: boolean; onlyHere: boolean;
  search: SearchTotals | null; ga: GaTotals | null; ai: number | null; crawl: number | null;
  indexed: number | null; notIndexed: number | null; indexedAsOf: string;
};
/** One month inside a period, after like-for-like trimming. */
export type MonthPoint = {
  month: string; through: string; trimmedTo: string; partial: boolean;
  search: SearchTotals | null; ga: GaTotals | null; ai: number | null; crawl: number | null;
  indexed: number | null; notIndexed: number | null; indexedAsOf: string; aiVisits: number | null;
};
export type SearchItem = { name: string; clicks: number; impressions: number; ctr: number; position: number };
export type GaItem = { name: string; sessions: number; users: number; newUsers: number; views: number; engagementRate: number; avgSessionSec: number; keyEvents: number };
export type AiItem = { name: string; impressions: number };
export type DailyPoint = {
  date: string; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null;
  sessions: number | null; users: number | null; organic: number | null; ai: number | null;
};
export type Coverage = { search: number; ga: number; ai: number; crawl: number; idx: number };
export type Group = {
  months: string[]; partial: boolean; onlyHere: number; notes: string[];
  search: SearchTotals | null; ga: GaTotals | null; ai: number | null; crawl: number | null;
  indexed: number | null; notIndexed: number | null; indexedAsOf: string;
  aiVisits: number | null; assistants: { name: string; sessions: number }[];
  /** Months with saved data, per kind, so the screen can say "3 of 6 months saved". */
  has: Coverage;
  monthly: MonthPoint[];
  trimmed: { month: string; through: string }[];
  pages: SearchItem[]; queries: SearchItem[]; countries: SearchItem[]; devices: SearchItem[];
  channels: GaItem[]; gaCountries: GaItem[]; gaDevices: GaItem[]; landing: GaItem[];
  aiPages: { from: string; to: string; items: AiItem[] } | null;
  daily: DailyPoint[];
};
export type CompareResult = { timeline: MonthRow[]; googleKeepsFrom: string; ga4: string; a: Group | null; b: Group | null };

type SDay = { date: string; clicks: number; impressions: number; position: number };
type GDay = { date: string; users: number; newUsers: number; sessions: number; views: number; er: number; avg: number; organic: number };
type GaTotalRow = { sessions: number; users: number; newUsers: number; views: number; er: number; avg: number; keyEvents: number };
type TabRef = { name: string; part: Part };
type Req = { part: Part; title: string; tag: string; range: (meta: { rows: number; cols: number }) => string };
type AiVisit = { date: string; source: string; sessions: number };

/* ---------------- Reading, gently ---------------- */

const isQuota = (e: unknown) =>
  /quota exceeded|rate ?limit|too many requests|RESOURCE_EXHAUSTED|\b429\b/i.test(e instanceof Error ? e.message : String(e ?? ""));

/** Runs a Sheets read; if Google says the per-minute quota is used up, waits and tries again. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= RETRY_WAITS.length || !isQuota(e)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_WAITS[i] + Math.random() * 1000));
    }
  }
}

type TabsP = ReturnType<typeof tabs>;
const tabsMemo = new Map<unknown, { at: number; p: TabsP }>();
const bookKey = (book: Book): unknown => {
  try {
    return typeof book === "string" ? book : JSON.stringify(book);
  } catch {
    return book;
  }
};
/** A Sheet's tab list (names and sizes), read once a minute at most instead of once per range. */
function tabsOf(book: Book): TabsP {
  const k = bookKey(book);
  const hit = tabsMemo.get(k);
  if (hit && Date.now() - hit.at < TABS_MS) return hit.p;
  const p = retry(() => tabs(book)) as TabsP;
  tabsMemo.set(k, { at: Date.now(), p });
  p.catch(() => tabsMemo.delete(k));
  return p;
}

/** Reads many ranges from many tabs, fitted to each tab's size (Google rejects ranges outside the grid). */
async function readMany(reqs: Req[]): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  const byBook = new Map<Book, { title: string; range: string; tag: string }[]>();
  for (const r of reqs) {
    const meta = (await tabsOf(r.part.book)).get(r.title);
    if (!meta) continue;
    const list = byBook.get(r.part.book) || [];
    list.push({ title: r.title, range: r.range(meta), tag: r.tag });
    byBook.set(r.part.book, list);
  }
  for (const [book, list] of byBook) {
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      const got = await retry(() => batchRead(book, chunk.map((c) => ({ title: c.title, range: c.range }))));
      chunk.forEach((c, k) => out.set(c.tag, got[k] || []));
    }
  }
  return out;
}

/** { Page: [2, 10001], … } from a monthly tab's header cell, or null for tabs written before the index existed. */
function blocksOf(v: unknown): Record<string, [number, number]> | null {
  try {
    const o = JSON.parse(s(v));
    const b = o && typeof o === "object" ? o.blocks : null;
    if (!b || typeof b !== "object") return null;
    const out: Record<string, [number, number]> = {};
    for (const [k, x] of Object.entries(b)) {
      if (Array.isArray(x) && x.length === 2 && x.every((y) => Number.isInteger(y) && y >= 2)) out[k] = [x[0], x[1]];
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

type MonthTab = { month: string; head: Row; byType: Map<string, Row[]> };

/** Reads monthly tabs: the header, then each block (long blocks only up to their limit). */
async function readMonthTabs(items: TabRef[], prefix: string, dataCols: number, indexCol: number, limits: Record<string, number>): Promise<MonthTab[]> {
  if (!items.length) return [];
  const heads = await readMany(
    items.map((it) => ({ part: it.part, title: it.name, tag: it.name, range: (m) => `A1:${colLetter(Math.min(m.cols, indexCol + 1))}1` }))
  );
  const reqs: Req[] = [];
  const byName = new Map<string, MonthTab>();
  for (const it of items) {
    const head = heads.get(it.name)?.[0] || [];
    byName.set(it.name, { month: it.name.slice(prefix.length), head, byType: new Map() });
    const blocks = blocksOf(head[indexCol]);
    if (blocks) {
      for (const [type, [a, b]] of Object.entries(blocks)) {
        const end = Math.min(b, a + (limits[type] ?? Infinity) - 1);
        reqs.push({ part: it.part, title: it.name, tag: `${it.name}\u0000${type}`, range: (m) => `A${a}:${colLetter(Math.min(m.cols, dataCols))}${Math.min(end, m.rows)}` });
      }
    } else {
      reqs.push({ part: it.part, title: it.name, tag: `${it.name}\u0000`, range: (m) => `A2:${colLetter(Math.min(m.cols, dataCols))}` });
    }
  }
  const got = await readMany(reqs);
  for (const [tag, rows] of got) {
    const [name, type] = tag.split("\u0000");
    const entry = byName.get(name);
    if (!entry) continue;
    for (const r of rows) {
      const t = type || s(r[0]);
      if (!t || s(r[0]) !== t) continue;
      const list = entry.byType.get(t) || [];
      if (list.length >= (limits[t] ?? Infinity)) continue;
      list.push(r);
      entry.byType.set(t, list);
    }
  }
  return [...byName.values()];
}

/** The property tab's saved daily data and weekly reports. */
async function mainData(book: Book, title: string) {
  const t = (await tabsOf(book)).get(title);
  const keys: SectionKey[] = ["ai", "crawl", "pages"];
  if (t && t.cols >= SEC.gaDaily.end) keys.push("searchDaily", "gaDaily");
  const got = await retry(() => batchRead(book, keys.map((k) => ({ title, range: sectionRange(k) }))));
  const part = (k: SectionKey) => got[keys.indexOf(k)] || [];

  const search: SDay[] = part("searchDaily")
    .filter((r) => DATE.test(s(r[0])))
    .map((r) => ({ date: s(r[0]), clicks: n(r[1]), impressions: n(r[2]), position: n(r[4]) }));
  const ga: GDay[] = part("gaDaily")
    .filter((r) => DATE.test(s(r[0])))
    .map((r) => ({ date: s(r[0]), users: n(r[1]), newUsers: n(r[2]), sessions: n(r[3]), views: n(r[4]), er: n(r[5]), avg: n(r[6]), organic: n(r[7]) }));
  const ai = new Map<string, number>();
  for (const r of part("ai")) if (DATE.test(s(r[0]))) ai.set(s(r[0]), n(r[1]));

  // Crawl requests per day: "All crawl requests", or Refresh + Discovery when only those were captured.
  const total = new Map<string, number>(), refresh = new Map<string, number>(), discovery = new Map<string, number>();
  for (const r of part("crawl")) {
    const key = s(r[0]), d = s(r[2]);
    if (!DATE.test(d)) continue;
    if (key === "total") total.set(d, n(r[3]));
    else if (key === "refresh") refresh.set(d, n(r[3]));
    else if (key === "discovery") discovery.set(d, n(r[3]));
  }
  const crawl = new Map<string, number>();
  for (const d of new Set([...total.keys(), ...refresh.keys()])) {
    const v = total.get(d) ?? (refresh.has(d) && discovery.has(d) ? refresh.get(d)! + discovery.get(d)! : undefined);
    if (v != null) crawl.set(d, v);
  }
  const idx = new Map<string, { indexed: number; notIndexed: number }>();
  for (const r of part("pages")) if (s(r[0]) === IDX_LABEL.ALL_URLS && DATE.test(s(r[1]))) idx.set(s(r[1]), { indexed: n(r[2]), notIndexed: n(r[3]) });
  return { search, ga, ai, crawl, idx };
}

/* ---------------- Adding up ---------------- */

function searchTotals(days: SDay[]): SearchTotals | null {
  if (!days.length) return null;
  const clicks = sum(days.map((d) => d.clicks));
  const impressions = sum(days.map((d) => d.impressions));
  const pw = sum(days.map((d) => d.position * d.impressions));
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? pw / impressions : 0, days: days.length };
}

function gaTotals(days: GDay[], total?: GaTotalRow): GaTotals | null {
  const organic = sum(days.map((d) => d.organic));
  if (total) {
    return {
      users: total.users, usersExact: true, newUsers: total.newUsers, sessions: total.sessions, views: total.views,
      engagementRate: total.er, avgSessionSec: total.avg, keyEvents: total.keyEvents, organicSessions: organic, days: days.length,
    };
  }
  if (!days.length) return null;
  const sessions = sum(days.map((d) => d.sessions));
  return {
    users: sum(days.map((d) => d.users)), usersExact: days.length === 1, newUsers: sum(days.map((d) => d.newUsers)), sessions,
    views: sum(days.map((d) => d.views)),
    engagementRate: sessions ? sum(days.map((d) => d.er * d.sessions)) / sessions : 0,
    avgSessionSec: sessions ? sum(days.map((d) => d.avg * d.sessions)) / sessions : 0,
    keyEvents: null, organicSessions: organic, days: days.length,
  };
}

function combineGa(list: GaTotals[]): GaTotals | null {
  if (!list.length) return null;
  const sessions = sum(list.map((x) => x.sessions));
  return {
    users: sum(list.map((x) => x.users)),
    usersExact: list.length === 1 && list[0].usersExact,
    newUsers: sum(list.map((x) => x.newUsers)),
    sessions,
    views: sum(list.map((x) => x.views)),
    engagementRate: sessions ? sum(list.map((x) => x.engagementRate * x.sessions)) / sessions : 0,
    avgSessionSec: sessions ? sum(list.map((x) => x.avgSessionSec * x.sessions)) / sessions : 0,
    keyEvents: list.every((x) => x.keyEvents != null) ? sum(list.map((x) => x.keyEvents ?? 0)) : null,
    organicSessions: sum(list.map((x) => x.organicSessions)),
    days: sum(list.map((x) => x.days)),
  };
}

function searchItems(lists: Row[][]): SearchItem[] {
  const m = new Map<string, { c: number; i: number; pw: number }>();
  for (const rows of lists) {
    for (const r of rows) {
      const name = s(r[1]);
      if (!name) continue;
      const e = m.get(name) || { c: 0, i: 0, pw: 0 };
      const imp = n(r[3]);
      e.c += n(r[2]);
      e.i += imp;
      e.pw += n(r[5]) * imp;
      m.set(name, e);
    }
  }
  return [...m.entries()]
    .map(([name, e]) => ({ name, clicks: e.c, impressions: e.i, ctr: e.i ? e.c / e.i : 0, position: e.i ? e.pw / e.i : 0 }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, OUT_LIMIT);
}

function gaItems(lists: { rows: Row[]; v2: boolean }[]): GaItem[] {
  const m = new Map<string, { s: number; u: number; nu: number; v: number; erw: number; avgw: number; k: number }>();
  for (const { rows, v2 } of lists) {
    for (const r of rows) {
      const name = s(r[1]);
      if (!name) continue;
      const e = m.get(name) || { s: 0, u: 0, nu: 0, v: 0, erw: 0, avgw: 0, k: 0 };
      const sessions = n(r[2]);
      e.s += sessions;
      e.u += n(r[3]);
      if (v2) {
        e.nu += n(r[4]);
        e.v += n(r[5]);
        e.erw += n(r[6]) * sessions;
        e.avgw += n(r[7]) * sessions;
        e.k += n(r[8]);
      } else {
        e.erw += n(r[4]) * sessions;
      }
      m.set(name, e);
    }
  }
  return [...m.entries()]
    .map(([name, e]) => ({
      name, sessions: e.s, users: e.u, newUsers: e.nu, views: e.v,
      engagementRate: e.s ? e.erw / e.s : 0, avgSessionSec: e.s ? e.avgw / e.s : 0, keyEvents: e.k,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, OUT_LIMIT);
}

/** Active users for a run of days, asked from GA4 itself (users can't be added up across months). */
async function liveUsers(token: string, ga4: string, from: string, to: string): Promise<number | null> {
  try {
    const r = await runReport(token, ga4, { dateRanges: [{ startDate: from, endDate: to }], metrics: [{ name: "activeUsers" }] });
    const v = r.rows[0]?.mets[0];
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Sessions from AI assistants, by day and source, for every selected month (asked from GA4 live). Null if GA4 can't be read. */
async function aiVisitsLive(token: string, ga4: string, months: string[]): Promise<AiVisit[] | null> {
  if (!ga4 || !months.length) return null;
  const from = `${months[0]}-01`;
  const to = minD(monthEnd(months[months.length - 1]), todayIn(GSC_TZ));
  if (from > to) return null;
  try {
    const r = await runReport(token, ga4, {
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: "date" }, { name: "sessionSource" }],
      metrics: [{ name: "sessions" }],
      dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_SOURCE_PATTERN, caseSensitive: false } } },
      limit: 25000,
    });
    const want = new Set(months);
    return r.rows
      .map((x) => ({ date: gaDate(x.dims[0]), source: x.dims[1], sessions: x.mets[0] ?? 0 }))
      .filter((v) => want.has(monthOf(v.date)));
  } catch {
    return null;
  }
}

/* ---------------- The property's saved history (shared by every comparison for 2 minutes) ---------------- */

async function loadBase(site: string) {
  const keeps = addDays(todayIn(GSC_TZ), -GOOGLE_KEEPS_DAYS);
  const arch = (await retry(() => readArchive())).find((r) => r.site === site) || null;
  const ga4 = arch?.ga4 || "";
  const ref = await retry(() => findSheet(site));
  if (!ref) return null;

  const main = await mainData(ref.book, ref.title);
  const [searchTabs, gaTabs, aiTabs] = await Promise.all([
    retry(() => listTabs(site, SEARCH_PREFIX)),
    retry(() => listTabs(site, GA4_PREFIX)),
    retry(() => listTabs(site, AI_PAGES_PREFIX)),
  ]);

  // GA4's own monthly totals (first row of each month's tab).
  const gaHeads = await readMany(
    gaTabs.map((t) => ({ part: t.part, title: t.name, tag: t.name, range: (m) => `A1:${colLetter(Math.min(m.cols, 9))}2` }))
  );
  const gaTotal = new Map<string, GaTotalRow>();
  for (const [name, rows] of gaHeads) {
    const h = rows[0] || [], r = rows[1] || [];
    if (s(h[4]) === "New users" && s(r[0]) === "Total") {
      gaTotal.set(name.slice(GA4_PREFIX.length), { sessions: n(r[2]), users: n(r[3]), newUsers: n(r[4]), views: n(r[5]), er: n(r[6]), avg: n(r[7]), keyEvents: n(r[8]) });
    }
  }

  // One row per month with any saved data.
  const months = new Set<string>();
  for (const d of main.search) months.add(monthOf(d.date));
  for (const d of main.ga) months.add(monthOf(d.date));
  for (const d of main.ai.keys()) months.add(monthOf(d));
  for (const d of main.crawl.keys()) months.add(monthOf(d));
  for (const d of main.idx.keys()) months.add(monthOf(d));
  for (const t of [...searchTabs, ...gaTabs]) months.add(t.name.slice(t.name.indexOf("·") + 2));
  const byMonth = <T extends { date: string }>(list: T[], m: string) => list.filter((d) => monthOf(d.date) === m);
  const mapMonth = (map: Map<string, number>, m: string) => {
    const vals = [...map.entries()].filter(([d]) => monthOf(d) === m).map(([, v]) => v);
    return vals.length ? sum(vals) : null;
  };
  const timeline: MonthRow[] = [...months]
    .filter((m) => MONTH.test(m))
    .sort()
    .map((m) => {
      const sd = byMonth(main.search, m);
      const gd = byMonth(main.ga, m);
      const dates = [...sd.map((d) => d.date), ...gd.map((d) => d.date)].sort();
      const from = dates[0] || "";
      const through = dates[dates.length - 1] || "";
      const idxDays = [...main.idx.keys()].filter((d) => monthOf(d) === m).sort();
      const lastIdx = idxDays[idxDays.length - 1];
      return {
        month: m, from, through,
        partial: !!from && (from > `${m}-01` || through < monthEnd(m)),
        onlyHere: monthEnd(m) < keeps,
        search: searchTotals(sd),
        ga: gaTotals(gd, gaTotal.get(m)),
        ai: mapMonth(main.ai, m),
        crawl: mapMonth(main.crawl, m),
        indexed: lastIdx ? main.idx.get(lastIdx)!.indexed : null,
        notIndexed: lastIdx ? main.idx.get(lastIdx)!.notIndexed : null,
        indexedAsOf: lastIdx || "",
      };
    });
  return { keeps, ga4, main, searchTabs, gaTabs, aiTabs, timeline };
}

type Base = NonNullable<Awaited<ReturnType<typeof loadBase>>>;
const baseMemo = new Map<string, { at: number; p: Promise<Base | null> }>();
function getBase(site: string) {
  const hit = baseMemo.get(site);
  if (hit && Date.now() - hit.at < BASE_MS) return hit.p;
  const p = loadBase(site);
  baseMemo.set(site, { at: Date.now(), p });
  p.catch(() => baseMemo.delete(site));
  return p;
}

/* ---------------- The comparison ---------------- */

async function compute(site: string, A: string[], B: string[], token: string): Promise<CompareResult> {
  const base = await getBase(site);
  if (!base) {
    const arch = (await retry(() => readArchive())).find((r) => r.site === site) || null;
    return { timeline: [], googleKeepsFrom: addDays(todayIn(GSC_TZ), -GOOGLE_KEEPS_DAYS), ga4: arch?.ga4 || "", a: null, b: null };
  }
  const { keeps, ga4, main, searchTabs, gaTabs, aiTabs, timeline } = base;
  if (!A.length && !B.length) return { timeline, googleKeepsFrom: keeps, ga4, a: null, b: null };
  const tl = new Map(timeline.map((t) => [t.month, t]));
  const byMonth = <T extends { date: string }>(list: T[], m: string) => list.filter((d) => monthOf(d.date) === m);

  /* Like for like: months are paired in order (1st of A with 1st of B, …). When one side of a pair is a part month that
     starts on the 1st, both sides are counted only to the earliest day both Search Console and GA4 have for it. */
  const cuts = new Map<string, string>();
  const partialThrough = (m: string) => {
    const r = tl.get(m);
    if (!r?.partial || r.from !== `${m}-01`) return "";
    const sd = byMonth(main.search, m).map((d) => d.date).sort();
    const gd = byMonth(main.ga, m).map((d) => d.date).sort();
    const ends = [sd[sd.length - 1], gd[gd.length - 1]].filter((x): x is string => !!x).sort();
    return ends[0] || "";
  };
  const setCut = (m: string, d: string) => {
    if (d >= monthEnd(m)) return;
    cuts.set(m, cuts.has(m) ? minD(cuts.get(m)!, d) : d);
  };
  if (A.length && A.length === B.length) {
    A.forEach((x, i) => {
      const y = B[i];
      for (const [p, q] of [[x, y], [y, x]] as const) {
        const d = partialThrough(p);
        if (!d) continue;
        setCut(p, d);
        setCut(q, `${q}-${d.slice(8, 10)}`);
      }
    });
  }

  const aiVisits = await aiVisitsLive(token, ga4, uniqSorted([...A, ...B]));

  const group = async (ms: string[]): Promise<Group | null> => {
    if (!ms.length) return null;
    const set = new Set(ms);
    const keep = (date: string) => {
      const m = monthOf(date);
      if (!set.has(m)) return false;
      const c = cuts.get(m);
      return !c || date <= c;
    };
    const sDays = main.search.filter((d) => keep(d.date));
    const gDays = main.ga.filter((d) => keep(d.date));
    const aiDays = [...main.ai.entries()].filter(([d]) => keep(d));
    const crawlDays = [...main.crawl.entries()].filter(([d]) => keep(d));
    const idxDays = [...main.idx.entries()].filter(([d]) => keep(d)).sort((x, y) => x[0].localeCompare(y[0]));
    const visits = aiVisits ? aiVisits.filter((v) => keep(v.date)) : null;
    const notes: string[] = [];

    const monthly: MonthPoint[] = ms.map((m) => {
      const row = tl.get(m);
      const cut = cuts.get(m) || "";
      const inM = (d: string) => monthOf(d) === m;
      const sd = sDays.filter((d) => inM(d.date));
      const gd = gDays.filter((d) => inM(d.date));
      const ai = aiDays.filter(([d]) => inM(d)).map(([, v]) => v);
      const cr = crawlDays.filter(([d]) => inM(d)).map(([, v]) => v);
      const ix = idxDays.filter(([d]) => inM(d));
      const li = ix[ix.length - 1];
      const vs = visits ? visits.filter((v) => inM(v.date)) : null;
      return {
        month: m,
        through: cut || row?.through || "",
        trimmedTo: cut,
        partial: !!row?.partial || !!cut,
        search: searchTotals(sd),
        ga: cut ? gaTotals(gd) : row?.ga ?? null,
        ai: ai.length ? sum(ai) : null,
        crawl: cr.length ? sum(cr) : null,
        indexed: li ? li[1].indexed : null,
        notIndexed: li ? li[1].notIndexed : null,
        indexedAsOf: li ? li[0] : "",
        aiVisits: vs ? sum(vs.map((v) => v.sessions)) : null,
      };
    });

    const search = searchTotals(sDays);
    let ga = combineGa(monthly.map((p) => p.ga).filter((x): x is GaTotals => !!x));
    const lastP = monthly[monthly.length - 1];
    const midCut = monthly.slice(0, -1).some((p) => p.trimmedTo);
    if (ga && ga4 && isRun(ms) && !midCut && (ms.length > 1 || lastP.trimmedTo)) {
      const to = lastP.trimmedTo || (lastP.through && lastP.through < monthEnd(lastP.month) ? lastP.through : monthEnd(lastP.month));
      const users = await liveUsers(token, ga4, `${ms[0]}-01`, to);
      if (users != null) ga = { ...ga, users, usersExact: true };
    }
    if (ga && !ga.usersExact) notes.push("Active users is the sum of each month's users: the same person can be counted in more than one month.");

    // Lists from the monthly tabs.
    const sTabs = await readMonthTabs(searchTabs.filter((t) => set.has(t.name.slice(SEARCH_PREFIX.length))), SEARCH_PREFIX, 6, 7, { Page: TOP_PER_MONTH, Query: TOP_PER_MONTH });
    const gTabs = await readMonthTabs(gaTabs.filter((t) => set.has(t.name.slice(GA4_PREFIX.length))), GA4_PREFIX, 9, 10, { "Landing page": TOP_PER_MONTH });
    const sList = (type: string) => sTabs.map((t) => t.byType.get(type) || []);
    const gList = (type: string) => gTabs.map((t) => ({ rows: t.byType.get(type) || [], v2: s(t.head[4]) === "New users" }));
    if (sTabs.length) notes.push(`Pages and queries: each month's top ${TOP_PER_MONTH.toLocaleString("en-US")} by clicks, added up over the selected months.`);
    const missingLists = ms.filter((m) => !sTabs.some((t) => t.month === m));
    if (missingLists.length) notes.push(`No saved page and query lists for ${missingLists.map(mName).join(", ")} yet; totals still include those months.`);

    // AI pages: the latest capture inside the selected months (captures cover their own date range, so never added up).
    let aiPages: Group["aiPages"] = null;
    const aiTab = aiTabs.filter((t) => set.has(t.name.slice(AI_PAGES_PREFIX.length))).sort((x, y) => y.name.localeCompare(x.name))[0];
    if (aiTab) {
      const got = await readMany([{ part: aiTab.part, title: aiTab.name, tag: "ai", range: () => "A2:G" }]);
      const r = got.get("ai") || [];
      if (r.length) {
        aiPages = {
          from: s(r[0][0]), to: s(r[0][1]),
          items: r.filter((x) => s(x[5])).map((x) => ({ name: s(x[5]), impressions: n(x[6]) })).sort((a, b) => b.impressions - a.impressions).slice(0, OUT_LIMIT),
        };
      }
    }

    const trimmed = monthly.filter((p) => p.trimmedTo).map((p) => ({ month: p.month, through: p.trimmedTo }));
    if (trimmed.length) {
      notes.push(
        `Counted to the same day as the month it's compared with: ${trimmed.map((t) => `${mName(t.month)} (1–${Number(t.through.slice(8))})`).join(", ")}. ` +
          "Page, query and landing-page lists still cover whole months."
      );
    }
    const partialOnly = monthly.filter((p) => p.partial && !p.trimmedTo);
    if (partialOnly.length) notes.push(`Part-month data: ${partialOnly.map((p) => `${mName(p.month)} (to ${p.through})`).join(", ")}.`);
    const rows = ms.map((m) => tl.get(m)).filter((x): x is MonthRow => !!x);
    const onlyHere = rows.filter((r) => r.onlyHere).length;
    if (onlyHere) notes.push(`${onlyHere} of these months are no longer in Search Console; they come from your saved history.`);

    // Day by day, for lining up the two periods.
    const sMap = new Map(sDays.map((d) => [d.date, d]));
    const gMap = new Map(gDays.map((d) => [d.date, d]));
    const aMap = new Map(aiDays);
    const daily: DailyPoint[] = [...new Set([...sMap.keys(), ...gMap.keys(), ...aMap.keys()])].sort().map((date) => {
      const sd = sMap.get(date);
      const gd = gMap.get(date);
      return {
        date,
        clicks: sd?.clicks ?? null,
        impressions: sd?.impressions ?? null,
        ctr: sd ? (sd.impressions ? sd.clicks / sd.impressions : 0) : null,
        position: sd && sd.position ? sd.position : null,
        sessions: gd?.sessions ?? null,
        users: gd?.users ?? null,
        organic: gd?.organic ?? null,
        ai: aMap.get(date) ?? null,
      };
    });

    const byAssistant = new Map<string, number>();
    for (const v of visits || []) byAssistant.set(assistantOf(v.source), (byAssistant.get(assistantOf(v.source)) || 0) + v.sessions);
    const aiVals = monthly.map((p) => p.ai).filter((x): x is number => x != null);
    const crawlVals = monthly.map((p) => p.crawl).filter((x): x is number => x != null);
    const withIdx = monthly.filter((p) => p.indexed != null);
    const lastIdx = withIdx[withIdx.length - 1];

    return {
      months: ms, partial: monthly.some((p) => p.partial), onlyHere, notes,
      search, ga,
      ai: aiVals.length ? sum(aiVals) : null,
      crawl: crawlVals.length ? sum(crawlVals) : null,
      indexed: lastIdx?.indexed ?? null, notIndexed: lastIdx?.notIndexed ?? null, indexedAsOf: lastIdx?.indexedAsOf || "",
      aiVisits: visits ? sum(visits.map((v) => v.sessions)) : null,
      assistants: [...byAssistant.entries()].map(([name, sessions]) => ({ name, sessions })).sort((x, y) => y.sessions - x.sessions),
      has: {
        search: monthly.filter((p) => p.search).length,
        ga: monthly.filter((p) => p.ga).length,
        ai: monthly.filter((p) => p.ai != null).length,
        crawl: monthly.filter((p) => p.crawl != null).length,
        idx: withIdx.length,
      },
      monthly, trimmed,
      pages: searchItems(sList("Page")), queries: searchItems(sList("Query")),
      countries: searchItems(sList("Country")), devices: searchItems(sList("Device")),
      channels: gaItems(gList("Channel")), gaCountries: gaItems(gList("Country")), gaDevices: gaItems(gList("Device")), landing: gaItems(gList("Landing page")),
      aiPages, daily,
    };
  };

  // One period after the other, so the two don't read the Sheets at the same moment.
  const a = await group(A);
  const b = await group(B);
  return { timeline, googleKeepsFrom: keeps, ga4, a, b };
}

const resultMemo = new Map<string, { at: number; p: Promise<CompareResult> }>();

/** The comparison for two sets of months. Identical requests within 2 minutes reuse the same answer. */
export function compareData(site: string, aMonths: string[], bMonths: string[], token: string): Promise<CompareResult> {
  const A = uniqSorted(aMonths);
  const B = uniqSorted(bMonths);
  const key = `${site}|${A.join(",")}|${B.join(",")}`;
  const hit = resultMemo.get(key);
  if (hit && Date.now() - hit.at < RESULT_MS) return hit.p;
  const p = compute(site, A, B, token);
  resultMemo.set(key, { at: Date.now(), p });
  p.catch(() => resultMemo.delete(key));
  if (resultMemo.size > MAX_RESULTS) {
    const oldest = [...resultMemo.entries()].sort((x, y) => x[1].at - y[1].at)[0];
    if (oldest) resultMemo.delete(oldest[0]);
  }
  return p;
}
