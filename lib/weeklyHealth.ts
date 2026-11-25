// lib/weeklyHealth.ts
// Indexing, 404s and errors, and Crawling for the weekly report (lib/weekly.ts). Server-only.
// No Google API calls: everything comes from what the dashboard already saves in each property's Google Sheet.
//   • Google's Page indexing report and its "Why pages aren't indexed" table (extension captures or imports):
//     loadIdx in lib/reportStore.ts
//   • Crawl stats captures: loadCrawl in lib/reportStore.ts
//   • The daily index checks (URL Inspection): the "Status changes" and "404 link sources" sections of the property's
//     Sheet, and its _Jobs row (lib/indexJob.ts)
// Each part is read on its own, so one missing or failing part never hides the others.
import { loadCrawl, loadIdx } from "./reportStore";
import { IDX_LABEL, IDX_VIEWS, type IdxStore, type IdxViewData } from "./indexStats";
import type { CrawlStore } from "./crawlStats";
import { readJobs } from "./indexJob";
import { batchRead, type Row } from "./sheets";
import { assertLayout, sectionRange } from "./sheetLayout";
import { findSheet } from "./sheetBooks";
import { normalizeUrl } from "./url";
import { GSC_TZ, addDays } from "./dates";

/** Longest lists sent to the browser. */
const MAX_LIST = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type IndexCapture = {
  /** The Page indexing view used (the largest one captured, normally "All known pages"). */
  view: string;
  date: string;
  indexed: number;
  notIndexed: number;
  /** About a week before `date` (or the earliest saved day). */
  baseDate: string | null;
  baseIndexed: number | null;
  baseNotIndexed: number | null;
  latestSaved: string;
};
export type IndexChange = { date: string; url: string; change: string; before: string; after: string; link: string };
export type IndexChecks = {
  enabled: boolean;
  dropped: number;
  newlyIndexed: number;
  impressionsStopped: number;
  backInSearch: number;
  /** This week's "Dropped from Google's index" and "Newly indexed" rows, newest first. */
  changes: IndexChange[];
};
export type ReasonRow = { reason: string; pages: number; prevPages: number | null };
export type ErrorReasons = {
  view: string;
  asOf: string;
  prevAsOf: string | null;
  notFound: number;
  soft404: number;
  server: number;
  prevNotFound: number | null;
  prevSoft404: number | null;
  prevServer: number | null;
  list: ReasonRow[];
};
export type Link404 = {
  url: string; state: string; inSitemap: boolean; sitemaps: string; linkedFrom: string; checked: string; impressions: number;
};
export type Links404 = { total: number; inSitemap: number; withImpressions: number; impressions: number; rows: Link404[] };
export type CrawlDayRow = { date: string; requests: number | null; prevRequests: number | null; ms: number | null; prevMs: number | null };
export type CrawlHealth = {
  days: CrawlDayRow[];
  /** Days of this week with crawl data. */
  covered: number;
  /** Days with data both this week and on the same weekday last week (the compared days). */
  pairs: number;
  requests: number;
  prevRequests: number;
  /** Average response time over the compared days, weighted by requests. */
  ms: number | null;
  prevMs: number | null;
  latestSaved: string;
};
export type HealthProblems = { idx?: string; crawl?: string; checks?: string };
export type WeekHealth = {
  index: { capture: IndexCapture | null; checks: IndexChecks | null };
  errors: { reasons: ErrorReasons | null; links: Links404 | null };
  crawl: CrawlHealth | null;
  problems: HealthProblems;
};

const s = (v: unknown) => (v == null ? "" : String(v).trim());

/** The latest date in an ascending list that is on or before `max`, or "". */
function latestOnOrBefore(sorted: string[], max: string) {
  let out = "";
  for (const d of sorted) {
    if (d > max) break;
    out = d;
  }
  return out;
}

/** The day (Pacific time, like the report's weeks) of an ISO timestamp. */
const pacificDay = new Intl.DateTimeFormat("en-CA", { timeZone: GSC_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? pacificDay.format(new Date(t)) : "";
};

const norm = (u: string) => {
  try {
    return normalizeUrl(u);
  } catch {
    return u;
  }
};

/* ---------------- Page indexing ---------------- */

function indexCapture(store: IdxStore, end: string): IndexCapture | null {
  let best: { label: string; view: IdxViewData; dates: string[] } | null = null;
  let size = -1;
  for (const v of IDX_VIEWS) {
    const view = store.views[v];
    if (!view) continue;
    const dates = Object.keys(view.days || {}).filter((d) => DATE.test(d)).sort();
    const last = dates[dates.length - 1];
    if (!last) continue;
    const total = view.days[last].indexed + view.days[last].notIndexed;
    if (total > size) {
      size = total;
      best = { label: IDX_LABEL[v], view, dates };
    }
  }
  if (!best) return null;
  const date = latestOnOrBefore(best.dates, end);
  if (!date) return null;
  let base = latestOnOrBefore(best.dates, addDays(date, -7));
  if (!base && best.dates[0] < date) base = best.dates[0];
  const x = best.view.days[date];
  const b = base ? best.view.days[base] : null;
  return {
    view: best.label,
    date,
    indexed: x.indexed,
    notIndexed: x.notIndexed,
    baseDate: base || null,
    baseIndexed: b ? b.indexed : null,
    baseNotIndexed: b ? b.notIndexed : null,
    latestSaved: best.dates[best.dates.length - 1],
  };
}

const RE_404 = /not found \(404\)/i;
const RE_SOFT = /soft 404/i;
const RE_5XX = /server error \(5xx\)/i;

function reasonsPart(store: IdxStore, end: string): ErrorReasons | null {
  let best: { label: string; hist: Record<string, Record<string, number>>; snaps: string[]; cur: string } | null = null;
  let size = -1;
  for (const v of IDX_VIEWS) {
    const view = store.views[v];
    if (!view) continue;
    const hist = view.reasonsHistory || {};
    const snaps = Object.keys(hist).filter((d) => DATE.test(d)).sort();
    const cur = latestOnOrBefore(snaps, end);
    if (!cur) continue;
    const total = Object.values(hist[cur] || {}).reduce((t, x) => t + (Number(x) || 0), 0);
    if (total > size) {
      size = total;
      best = { label: IDX_LABEL[v], hist, snaps, cur };
    }
  }
  if (!best) return null;
  const { hist, snaps, cur } = best;
  let prev = latestOnOrBefore(snaps, addDays(cur, -7));
  if (!prev) {
    const i = snaps.indexOf(cur);
    prev = i > 0 ? snaps[i - 1] : "";
  }
  const now = hist[cur] || {};
  const before = prev ? hist[prev] || {} : null;
  const sum = (m: Record<string, number>, re: RegExp) =>
    Object.entries(m).reduce((t, [k, v]) => t + (re.test(k) ? Number(v) || 0 : 0), 0);
  const names = new Set<string>([...Object.keys(now), ...Object.keys(before || {})]);
  const list: ReasonRow[] = Array.from(names)
    .map((reason) => ({ reason, pages: Number(now[reason]) || 0, prevPages: before ? Number(before[reason]) || 0 : null }))
    .sort((a, b) => b.pages - a.pages || (b.prevPages || 0) - (a.prevPages || 0));
  return {
    view: best.label,
    asOf: cur,
    prevAsOf: prev || null,
    notFound: sum(now, RE_404),
    soft404: sum(now, RE_SOFT),
    server: sum(now, RE_5XX),
    prevNotFound: before ? sum(before, RE_404) : null,
    prevSoft404: before ? sum(before, RE_SOFT) : null,
    prevServer: before ? sum(before, RE_5XX) : null,
    list,
  };
}

/* ---------------- Daily index checks ---------------- */

async function checksPart(site: string, start: string, end: string): Promise<{ checks: IndexChecks | null; links: Links404 | null }> {
  await assertLayout();
  const [jobs, ref] = await Promise.all([readJobs(), findSheet(site)]);
  const job = jobs.find((j) => j.site === site) || null;
  let chRows: Row[] = [];
  let linkRows: Row[] = [];
  if (ref) {
    const parts = await batchRead(ref.book, [
      { title: ref.title, range: sectionRange("changes") },
      { title: ref.title, range: sectionRange("links404") },
    ]);
    chRows = parts[0] || [];
    linkRows = parts[1] || [];
  }

  const week = chRows
    .filter((r) => s(r[0]) && s(r[1]))
    .map((r) => ({ at: s(r[0]), day: dayOf(s(r[0])), url: s(r[1]), change: s(r[2]), before: s(r[3]), after: s(r[4]), link: s(r[5]) }))
    .filter((x) => x.day >= start && x.day <= end);
  const count = (re: RegExp) => week.filter((x) => re.test(x.change)).length;
  const checks: IndexChecks | null =
    job || week.length
      ? {
          enabled: !!job?.enabled,
          dropped: count(/^Dropped from Google/i),
          newlyIndexed: count(/^Newly indexed/i),
          impressionsStopped: count(/^Impressions stopped/i),
          backInSearch: count(/^Back in search/i),
          changes: week
            .filter((x) => /^(Dropped from Google|Newly indexed)/i.test(x.change))
            .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
            .slice(0, MAX_LIST)
            .map((x) => ({ date: x.day, url: x.url, change: x.change, before: x.before, after: x.after, link: x.link })),
        }
      : null;

  const rows = linkRows
    .filter((r) => /^https?:\/\//i.test(s(r[0])))
    .map((r): Link404 => {
      const refs = s(r[2]).split("|").map((x) => x.trim()).filter(Boolean);
      const maps = s(r[3]);
      return {
        url: s(r[0]),
        state: s(r[1]),
        inSitemap: !!maps,
        sitemaps: maps.slice(0, 500),
        linkedFrom: refs.length ? `${refs[0]}${refs.length > 1 ? ` (+${refs.length - 1} more)` : ""}` : "",
        checked: s(r[4]).slice(0, 10),
        impressions: 0,
      };
    });
  const links: Links404 | null =
    job || rows.length ? { total: rows.length, inSitemap: rows.filter((x) => x.inSitemap).length, withImpressions: 0, impressions: 0, rows } : null;
  return { checks, links };
}

/* ---------------- Crawl stats ---------------- */

function crawlPart(store: CrawlStore, start: string): CrawlHealth | null {
  const series = store.series || {};
  const keys = Object.keys(series);
  if (!keys.length) return null;
  let latestSaved = "";
  for (const k of keys) for (const d of Object.keys(series[k].days || {})) if (d > latestSaved) latestSaved = d;

  /** The reported total, or Refresh + Discovery when both exist (every crawl is one or the other). */
  const at = (d: string): { requests: number | null; ms: number | null } => {
    const t = series.total?.days?.[d];
    if (t) return { requests: t.requests, ms: t.ms ?? null };
    const r = series.refresh?.days?.[d];
    const x = series.discovery?.days?.[d];
    if (r && x) {
      const req = r.requests + x.requests;
      const ms = r.ms != null && x.ms != null && req > 0 ? (r.ms * r.requests + x.ms * x.requests) / req : null;
      return { requests: req, ms };
    }
    return { requests: null, ms: null };
  };

  const days: CrawlDayRow[] = [];
  let covered = 0;
  let pairs = 0;
  let requests = 0;
  let prevRequests = 0;
  let msSum = 0;
  let msW = 0;
  let pmsSum = 0;
  let pmsW = 0;
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const cur = at(date);
    const prev = at(addDays(date, -7));
    days.push({ date, requests: cur.requests, prevRequests: prev.requests, ms: cur.ms, prevMs: prev.ms });
    if (cur.requests == null) continue;
    covered++;
    if (prev.requests == null) continue;
    pairs++;
    requests += cur.requests;
    prevRequests += prev.requests;
    if (cur.ms != null) {
      msSum += cur.ms * cur.requests;
      msW += cur.requests;
    }
    if (prev.ms != null) {
      pmsSum += prev.ms * prev.requests;
      pmsW += prev.requests;
    }
  }
  return { days, covered, pairs, requests, prevRequests, ms: msW ? msSum / msW : null, prevMs: pmsW ? pmsSum / pmsW : null, latestSaved };
}

/* ---------------- Loading ---------------- */

/** Everything saved for this property that the week's Indexing, 404s and Crawling rows need. Never throws. */
export async function loadHealth(site: string, start: string, end: string): Promise<WeekHealth> {
  const problems: HealthProblems = {};
  const fail = (k: keyof HealthProblems) => (e: unknown) => {
    problems[k] = e instanceof Error ? e.message : "error";
    return null;
  };
  const [idx, crawl, checks] = await Promise.all([
    loadIdx(site).catch(fail("idx")),
    loadCrawl(site).catch(fail("crawl")),
    checksPart(site, start, end).catch(fail("checks")),
  ]);
  return {
    index: { capture: idx ? indexCapture(idx, end) : null, checks: checks ? checks.checks : null },
    errors: { reasons: idx ? reasonsPart(idx, end) : null, links: checks ? checks.links : null },
    crawl: crawl ? crawlPart(crawl, start) : null,
    problems,
  };
}

/**
 * Adds this week's search impressions to the known 404 URLs (pages Google still shows although they return 404),
 * then keeps the most important rows for the browser.
 */
export function addImpressions(h: WeekHealth, pages: { keys: string[]; impressions: number }[]) {
  const l = h.errors.links;
  if (!l) return;
  if (l.rows.length && pages.length) {
    const m = new Map<string, number>();
    for (const r of pages) {
      const u = norm(r.keys[0]);
      m.set(u, (m.get(u) || 0) + r.impressions);
    }
    for (const x of l.rows) x.impressions = m.get(norm(x.url)) || 0;
  }
  l.withImpressions = l.rows.filter((x) => x.impressions > 0).length;
  l.impressions = l.rows.reduce((t, x) => t + x.impressions, 0);
  l.rows.sort((a, b) => b.impressions - a.impressions || Number(b.inSitemap) - Number(a.inSitemap) || a.url.localeCompare(b.url));
  l.rows = l.rows.slice(0, MAX_LIST);
}
