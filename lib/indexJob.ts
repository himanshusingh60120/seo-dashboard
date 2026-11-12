// lib/indexJob.ts
// Daily index checks for enrolled properties, stored in the Google Sheet (INDEX_SHEET_ID).
//
// Each property has its own tab with one row per URL. Two scheduled jobs keep it current:
//   plan (hourly; acts once per Pacific day per property, after Google's quota resets): reads the sitemaps and
//     Search Console impressions (both free), adds new URLs, marks pages with impressions as indexed, spots pages
//     whose impressions suddenly stopped, and queues up to the daily budget of URLs for URL Inspection.
//   run (every 10 minutes): inspects queued URLs in small batches and writes each result to its row.
// Rows are only ever added at the bottom, never moved, so the queued row numbers stay valid.
import { serviceAccountToken } from "./serviceAccount";
import { appendRows, clearRange, colLetter, ensureSize, ensureTab, readRange, readRanges, safeTitle, sheetUrl, writeRange, writeRanges, type Row } from "./sheets";
import { collect } from "./sitemapReader";
import { HttpError } from "./token";
import { errorInspection, inspectUrl, latestFinalDate, listSites, searchAnalyticsAll, MAX_ROWS, type InspectionResult } from "./google";
import { addDays, GSC_TZ, todayIn } from "./dates";
import { normalizeUrl } from "./url";

const DAY = 864e5;

export const JOBS_TAB = "_Jobs";
export const SITEMAPS_TAB = "_Sitemaps";
export const LOG_TAB = "_Log";

/** Inspections per property per day for this job. Google allows 2,000; the rest is left for people using the dashboard. */
export const DEFAULT_BUDGET = Math.min(1900, Math.max(1, Math.floor(Number(process.env.INDEX_DAILY_BUDGET) || 1800)));
/** Pages are inspected again after this many days unless something makes them due sooner. */
const RECHECK_DAYS = 30;
/** "Impressions suddenly stopped": at least this many in the 14 days before, and none in the last 3 days. */
const DROP_MIN_IMPRESSIONS = 14;
const BATCH = 40;
const PARALLEL = 6;

export const URL_HEADERS = [
  "URL", "Sitemap", "Source", "Sitemap lastmod", "Status", "Verified by", "Google's reason", "Page fetch",
  "Last crawled by Google", "Google canonical", "Last inspected", "Impressions (28 days)", "Last seen in search",
  "Next check", "Flag", "Inspection link",
];
const W = URL_HEADERS.length;
const LAST = colLetter(W);
const C = {
  url: 0, sitemap: 1, source: 2, lastmod: 3, status: 4, verifiedBy: 5, reason: 6, fetch: 7,
  lastCrawl: 8, canonical: 9, inspected: 10, imp28: 11, lastSeen: 12, nextCheck: 13, flag: 14, link: 15,
} as const;

export const JOB_HEADERS = [
  "Property", "Tab", "Enabled", "Daily budget", "Added by", "Added at", "Plan day", "Plan status", "Planned at",
  "Queue (row numbers)", "Checked today", "Last run", "Last message",
];
export const SITEMAP_HEADERS = ["Property", "Sitemap", "URLs", "Verified", "Indexed", "Not indexed", "Errors", "Not checked yet", "% verified", "Updated"];
export const LOG_HEADERS = ["Time", "Property", "Step", "Inspections used", "Indexed", "Not indexed", "Errors", "Drops confirmed", "Note"];

const s = (v: unknown) => (v == null ? "" : String(v));
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const yes = (v: unknown) => v === true || /^(true|yes|y|1|on)$/i.test(s(v).trim());
const pad = (r: Row): Row => {
  const out = r.slice(0, W);
  while (out.length < W) out.push("");
  return out;
};
const ageDays = (day: string, iso: string) =>
  iso ? (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / DAY : Infinity;
const isIndexedVerdict = (v: string) => v === "PASS" || v === "PARTIAL";

/** Google's daily quotas reset at midnight Pacific time, so the job's "day" is a Pacific day. */
export const today = () => todayIn(GSC_TZ);

/** "sc-domain:example.com" → "example.com (domain)"; "https://www.example.com/" → "www.example.com". */
export function tabFor(site: string) {
  const t = site.startsWith("sc-domain:") ? `${site.slice(10)} (domain)` : site.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return safeTitle(t);
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/* ---------------- _Jobs: one row per property ---------------- */

export type Job = {
  row: number; site: string; tab: string; enabled: boolean; budget: number;
  planDay: string; planStatus: string; plannedAt: string; queue: number[];
  checkedToday: number; lastRun: string; message: string;
};

export async function readJobs(): Promise<Job[]> {
  await ensureTab(JOBS_TAB, JOB_HEADERS);
  const rows = await readRange(JOBS_TAB, "A2:M");
  return rows
    .map(
      (r, i): Job => ({
        row: i + 2,
        site: s(r[0]).trim(),
        tab: s(r[1]).trim() || tabFor(s(r[0]).trim()),
        enabled: yes(r[2]),
        budget: Math.min(1900, Math.max(1, Math.floor(n(r[3]) || DEFAULT_BUDGET))),
        planDay: s(r[6]),
        planStatus: s(r[7]),
        plannedAt: s(r[8]),
        queue: s(r[9])
          .split(",")
          .map((x) => Math.floor(Number(x)))
          .filter((x) => x >= 2),
        checkedToday: n(r[10]),
        lastRun: s(r[11]),
        message: s(r[12]),
      })
    )
    .filter((j) => j.site);
}

async function saveJob(j: Job) {
  await writeRange(JOBS_TAB, `B${j.row}:B${j.row}`, [[j.tab]]);
  await writeRange(JOBS_TAB, `G${j.row}:M${j.row}`, [
    [j.planDay, j.planStatus, j.plannedAt, j.queue.join(","), j.checkedToday, j.lastRun, j.message.slice(0, 500)],
  ]);
}

type Counts = { used: number; indexed: number; notIndexed: number; errors: number; drops: number };

async function log(site: string, step: string, c: Partial<Counts>, note: string) {
  try {
    await ensureTab(LOG_TAB, LOG_HEADERS);
    await appendRows(LOG_TAB, [
      [new Date().toISOString(), site, step, c.used ?? 0, c.indexed ?? 0, c.notIndexed ?? 0, c.errors ?? 0, c.drops ?? 0, note.slice(0, 500)],
    ]);
  } catch {
    /* the log is a convenience; never fail a job because of it */
  }
}

/* ---------------- Turning checks on and off ---------------- */

/** True when the service account has been added as a user of this Search Console property. */
export async function serviceAccountCanRead(site: string) {
  const sites = await listSites(await serviceAccountToken());
  return sites.some((x) => x.siteUrl === site);
}

/** Starts (adds the property's tab and a _Jobs row) or pauses daily checks for a property. */
export async function setEnabled(site: string, enabled: boolean, by: string) {
  const jobs = await readJobs();
  const j = jobs.find((x) => x.site === site);
  if (j) {
    await writeRange(JOBS_TAB, `C${j.row}:C${j.row}`, [[enabled]]);
    if (enabled) await ensureTab(j.tab, URL_HEADERS);
    return;
  }
  if (!enabled) return;
  const tab = tabFor(site);
  await ensureTab(tab, URL_HEADERS);
  await appendRows(JOBS_TAB, [
    [site, tab, true, DEFAULT_BUDGET, by, new Date().toISOString(), "", "waiting", "", "", 0, "", "Added. The first daily plan runs within the hour."],
  ]);
}

/** This property's job and per-sitemap summary, for the dashboard. */
export async function propertyStatus(site: string) {
  const job = (await readJobs()).find((j) => j.site === site) || null;
  await ensureTab(SITEMAPS_TAB, SITEMAP_HEADERS);
  const sitemaps = (await readRange(SITEMAPS_TAB, "A2:J"))
    .filter((r) => s(r[0]) === site)
    .map((r) => ({
      sitemap: s(r[1]), urls: n(r[2]), verified: n(r[3]), indexed: n(r[4]), notIndexed: n(r[5]),
      errors: n(r[6]), notChecked: n(r[7]), pctVerified: n(r[8]), updated: s(r[9]),
    }));
  return {
    job: job && {
      tab: job.tab, enabled: job.enabled, budget: job.budget, planDay: job.planDay, planStatus: job.planStatus,
      queued: job.queue.length, checkedToday: job.checkedToday, lastRun: job.lastRun, message: job.message,
    },
    sitemaps,
    sheetUrl: sheetUrl(),
  };
}

/* ---------------- Per-sitemap summary (_Sitemaps) ---------------- */

async function writeSitemapSummary(site: string, rows: Row[], problems: { sitemap: string; error: string }[] = []) {
  type G = { urls: number; indexed: number; notIndexed: number; errors: number; unchecked: number };
  const groups = new Map<string, G>();
  for (const r of rows) {
    const src = s(r[C.source]);
    if (!s(r[C.url]) || src === "No longer listed") continue;
    const key = src === "Search only" ? "(found in search, not in a sitemap)" : s(r[C.sitemap]) || "(sitemap unknown)";
    const g = groups.get(key) || { urls: 0, indexed: 0, notIndexed: 0, errors: 0, unchecked: 0 };
    g.urls++;
    const st = s(r[C.status]);
    if (st === "Indexed") g.indexed++;
    else if (st === "Not indexed") g.notIndexed++;
    else if (st === "Error") g.errors++;
    else g.unchecked++;
    groups.set(key, g);
  }
  const now = new Date().toISOString();
  const mine: Row[] = [...groups.entries()]
    .sort((a, b) => b[1].urls - a[1].urls)
    .map(([k, g]) => {
      const verified = g.indexed + g.notIndexed;
      return [site, k, g.urls, verified, g.indexed, g.notIndexed, g.errors, g.unchecked, g.urls ? Math.round((verified / g.urls) * 1000) / 10 : 0, now];
    });
  for (const p of problems) mine.push([site, p.sitemap, 0, 0, 0, 0, 0, 0, 0, `Couldn't read: ${p.error}`.slice(0, 300)]);

  await ensureTab(SITEMAPS_TAB, SITEMAP_HEADERS);
  const others = (await readRange(SITEMAPS_TAB, "A2:J")).filter((r) => s(r[0]) && s(r[0]) !== site);
  const out = [...others, ...mine];
  await ensureSize(SITEMAPS_TAB, out.length + 1, SITEMAP_HEADERS.length);
  await clearRange(SITEMAPS_TAB, "A2:J");
  if (out.length) await writeRange(SITEMAPS_TAB, `A2:J${out.length + 1}`, out);
}

async function refreshSummary(j: Job) {
  const rows = (await readRange(j.tab, `A2:${LAST}`)).map(pad);
  await writeSitemapSummary(j.site, rows);
}

/* ---------------- Plan: once per Pacific day per property ---------------- */

export async function failJob(j: Job, message: string) {
  j.planStatus = "error";
  j.message = `Plan failed: ${message}`.slice(0, 500);
  await saveJob(j).catch(() => {});
  await log(j.site, "plan", {}, j.message);
}

export async function planProperty(job: Job, day: string): Promise<string> {
  job.planStatus = "planning";
  job.plannedAt = new Date().toISOString();
  job.message = "Planning today's checks…";
  await saveJob(job);

  const token = await serviceAccountToken();
  await ensureTab(job.tab, URL_HEADERS, true);

  // 1. Free signals: sitemaps, and Search Console impressions per page.
  const sm = await collect(token, job.site, null, false);
  const inSitemap = new Map(sm.urls.map((u) => [u.url, u] as const));
  const end = await latestFinalDate(token, job.site);
  const byPage = async (from: string, to: string) => {
    const rows = await searchAnalyticsAll(token, job.site, { startDate: from, endDate: to, dimensions: ["page"] }, MAX_ROWS);
    const m = new Map<string, number>();
    for (const r of rows) {
      const u = normalizeUrl(r.keys[0]);
      m.set(u, (m.get(u) || 0) + r.impressions);
    }
    return m;
  };
  const [imp28, recent, before] = await Promise.all([
    byPage(addDays(end, -27), end),
    byPage(addDays(end, -2), end),
    byPage(addDays(end, -16), addDays(end, -3)),
  ]);

  // 2. Current rows, plus new URLs at the bottom.
  const rows = (await readRange(job.tab, `A2:${LAST}`)).map(pad);
  const at = new Map<string, number>();
  rows.forEach((r, i) => {
    const u = s(r[C.url]);
    if (u && !at.has(u)) at.set(u, i);
  });
  let added = 0;
  const addRow = (url: string) => {
    const r = pad([url]);
    r[C.status] = "Not checked yet";
    r[C.flag] = "New";
    rows.push(r);
    at.set(url, rows.length - 1);
    added++;
  };
  for (const u of inSitemap.keys()) if (!at.has(u)) addRow(u);
  for (const [u, v] of imp28) if (v > 0 && !at.has(u)) addRow(u);

  // 3. Decide what needs a URL Inspection today.
  const due: { i: number; p: number; sitemap: string; inspected: string }[] = [];
  let withImpressions = 0;
  let stoppedCount = 0;
  rows.forEach((r, i) => {
    const url = s(r[C.url]);
    if (!url) return;
    const smu = inSitemap.get(url);
    const imp = imp28.get(url) || 0;
    const rec = recent.get(url) || 0;
    const base = before.get(url) || 0;
    if (smu) {
      r[C.sitemap] = smu.sitemap || s(r[C.sitemap]);
      r[C.lastmod] = smu.lastmod || "";
    }
    r[C.source] = smu && imp ? "Sitemap + search" : smu ? "Sitemap" : imp ? "Search only" : "No longer listed";
    r[C.imp28] = imp;
    if (rec > 0) r[C.lastSeen] = end;

    const status = s(r[C.status]);
    const inspected = s(r[C.inspected]);
    const stopped = base >= DROP_MIN_IMPRESSIONS && rec === 0;

    // Impressions are free proof of indexing, unless they just stopped.
    if (imp > 0 && !stopped) {
      withImpressions++;
      if (status !== "Indexed") {
        r[C.flag] = status === "Not indexed" ? `Now appearing in search (${end})` : "";
        r[C.status] = "Indexed";
        r[C.verifiedBy] = "Impressions";
      } else if (s(r[C.flag]) === "New") r[C.flag] = "";
      r[C.nextCheck] = "Not needed while it gets impressions";
      return;
    }

    let p = 0;
    if (stopped && ageDays(day, inspected) > 3) {
      p = 1;
      stoppedCount++;
      r[C.flag] = `Impressions stopped (last seen ${s(r[C.lastSeen]) || "earlier"}), checking`;
    } else if (r[C.source] === "No longer listed") p = 0;
    else if (!inspected) p = 2;
    else if (s(r[C.lastmod]) && s(r[C.lastmod]).slice(0, 10) > inspected.slice(0, 10)) p = 3;
    else if (status === "Error" && ageDays(day, inspected) >= 1) p = 4;
    else if (ageDays(day, inspected) >= RECHECK_DAYS) p = status === "Not indexed" ? 5 : 6;

    if (p) {
      due.push({ i, p, sitemap: s(r[C.sitemap]), inspected });
      r[C.nextCheck] = day;
    } else if (r[C.source] === "No longer listed") {
      r[C.nextCheck] = "Not checked (no longer in a sitemap or search)";
    } else if (inspected) {
      r[C.nextCheck] = addDays(inspected.slice(0, 10), status === "Error" ? 1 : RECHECK_DAYS);
    }
  });

  // 4. Today's queue: impressions stopped first; never-checked URLs take turns across sitemaps so each sitemap
  //    gets an early picture; then changed pages, failed checks, and the oldest results.
  due.sort((a, b) => a.p - b.p || (a.inspected < b.inspected ? -1 : a.inspected > b.inspected ? 1 : 0));
  const queue: number[] = [];
  const room = () => queue.length < job.budget;
  for (const d of due) if (d.p === 1 && room()) queue.push(d.i + 2);
  const fresh = new Map<string, typeof due>();
  for (const d of due) {
    if (d.p !== 2) continue;
    const list = fresh.get(d.sitemap) || [];
    list.push(d);
    fresh.set(d.sitemap, list);
  }
  const lists = [...fresh.values()];
  for (let k = 0; room(); k++) {
    let any = false;
    for (const l of lists) {
      if (k < l.length) {
        any = true;
        if (room()) queue.push(l[k].i + 2);
      }
    }
    if (!any) break;
  }
  for (const d of due) if (d.p > 2 && room()) queue.push(d.i + 2);

  // 5. Save the tab in chunks so each request stays small.
  await ensureSize(job.tab, rows.length + 1, W);
  for (let i = 0; i < rows.length; i += 4000) {
    const part = rows.slice(i, i + 4000);
    await writeRange(job.tab, `A${i + 2}:${LAST}${i + 1 + part.length}`, part);
  }
  await writeSitemapSummary(job.site, rows, sm.errors);

  job.planDay = day;
  job.planStatus = "ready";
  job.queue = queue;
  job.checkedToday = 0;
  job.message =
    `${rows.length.toLocaleString()} URLs (${added.toLocaleString()} new) · ${withImpressions.toLocaleString()} proven indexed by impressions · ` +
    `${stoppedCount} with impressions that stopped · ${queue.length.toLocaleString()} queued for URL Inspection today` +
    (sm.errors.length ? ` · ${sm.errors.length} sitemap problem(s)` : "");
  await saveJob(job);
  await log(job.site, "plan", {}, job.message);
  return job.message;
}

/* ---------------- Run: inspect queued URLs ---------------- */

type BatchResult = Counts & { done: Set<number>; stop: string; quota: boolean };

async function checkBatch(job: Job, rowNums: number[], token: string, day: string): Promise<BatchResult> {
  const got = await readRanges(job.tab, rowNums.map((r) => `A${r}:${LAST}${r}`));
  const items = rowNums.map((row, k) => ({ row, cells: pad(got[k]?.[0] || []) }));
  const done = new Set<number>(items.filter((x) => !s(x.cells[C.url])).map((x) => x.row)); // emptied rows leave the queue
  const work = items.filter((x) => s(x.cells[C.url]));
  let quota = false;
  let rateLimited = false;
  let forbidden = "";

  const results = await pool(work, PARALLEL, async (it): Promise<{ it: typeof it; res: InspectionResult } | null> => {
    if (quota || rateLimited || forbidden) return null;
    const url = s(it.cells[C.url]);
    try {
      return { it, res: await inspectUrl(token, job.site, url) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        if (/minute/i.test(e.message)) rateLimited = true;
        else quota = true;
        return null;
      }
      if (e instanceof HttpError && e.status === 403) {
        forbidden = e.message;
        return null;
      }
      return { it, res: errorInspection(url, e instanceof Error ? e.message : "Inspection failed") };
    }
  });

  const c: Counts = { used: 0, indexed: 0, notIndexed: 0, errors: 0, drops: 0 };
  const data: { range: string; values: Row[] }[] = [];
  for (const x of results) {
    if (!x) continue;
    const { it, res } = x;
    const r = it.row;
    done.add(r);
    c.used++;
    const prev = s(it.cells[C.status]);
    const prevFlag = s(it.cells[C.flag]);

    if (res.verdict === "ERROR") {
      c.errors++;
      if (prev === "Indexed" || prev === "Not indexed") {
        // A failed check never replaces a real result.
        data.push({ range: `N${r}:O${r}`, values: [[addDays(day, 1), `Last check failed: ${res.coverageState}`.slice(0, 300)]] });
      } else {
        data.push({ range: `E${r}:K${r}`, values: [["Error", "URL Inspection", res.coverageState.slice(0, 300), "", "", "", res.checkedAt]] });
        data.push({ range: `N${r}:P${r}`, values: [[addDays(day, 1), "Check failed", ""]] });
      }
      continue;
    }

    const status = isIndexedVerdict(res.verdict) ? "Indexed" : "Not indexed";
    if (status === "Indexed") c.indexed++;
    else c.notIndexed++;
    let flag = "";
    if (status === "Not indexed" && (prev === "Indexed" || prevFlag.startsWith("Impressions stopped"))) {
      flag = `Dropped from Google's index (found ${day})`;
      c.drops++;
    } else if (status === "Indexed" && prevFlag.startsWith("Impressions stopped")) {
      flag = "Impressions stopped, but still indexed";
    } else if (status === "Indexed" && prev === "Not indexed") {
      flag = `Newly indexed (found ${day})`;
    }
    data.push({
      range: `E${r}:K${r}`,
      values: [[status, "URL Inspection", res.coverageState, res.pageFetchState, res.lastCrawlTime, res.googleCanonical, res.checkedAt]],
    });
    data.push({ range: `N${r}:P${r}`, values: [[addDays(day, RECHECK_DAYS), flag, res.link]] });
  }
  if (data.length) await writeRanges(job.tab, data);

  const stop = quota
    ? "Google's daily URL Inspection limit for this property was reached (people using the dashboard share it). Checks continue after tomorrow's plan."
    : forbidden
      ? `The service account lost access to this property: ${forbidden}`
      : rateLimited
        ? "Google asked to slow down; continuing in the next run."
        : "";
  return { ...c, done, stop, quota };
}

/** Called every 10 minutes. Works through each property's queue in turns until the time budget is used. */
export async function runChecks(deadline: number) {
  const day = today();
  const jobs = (await readJobs()).filter(
    (j) => j.enabled && j.planDay === day && j.planStatus === "ready" && j.queue.length > 0 && j.checkedToday < j.budget
  );
  if (!jobs.length) return { day, used: 0, note: "Nothing queued right now." };

  const token = await serviceAccountToken();
  const stopped = new Set<Job>();
  const timeLeft = () => Date.now() < deadline - 15_000;
  let used = 0;

  while (timeLeft()) {
    const active = jobs.filter((j) => !stopped.has(j) && j.queue.length > 0 && j.checkedToday < j.budget);
    if (!active.length) break;
    for (const j of active) {
      if (!timeLeft()) break;
      try {
        const size = Math.min(BATCH, j.budget - j.checkedToday);
        const r = await checkBatch(j, j.queue.slice(0, size), token, day);
        j.queue = j.queue.filter((row) => !r.done.has(row));
        j.checkedToday += r.used;
        used += r.used;
        j.lastRun = new Date().toISOString();
        if (r.stop) {
          stopped.add(j);
          j.message = r.stop;
          if (r.quota) j.checkedToday = Math.max(j.checkedToday, j.budget);
        } else {
          j.message = j.queue.length
            ? `Checked ${j.checkedToday.toLocaleString()} today · ${j.queue.length.toLocaleString()} still queued`
            : `Today's checks are done: ${j.checkedToday.toLocaleString()} URLs inspected.`;
        }
        await saveJob(j);
        await log(j.site, "check", r, r.stop);
        if (!j.queue.length && timeLeft()) await refreshSummary(j).catch(() => {});
      } catch (e) {
        stopped.add(j);
        j.message = `Check run failed: ${e instanceof Error ? e.message : "error"}`.slice(0, 500);
        j.lastRun = new Date().toISOString();
        await saveJob(j).catch(() => {});
        await log(j.site, "check", {}, j.message);
      }
    }
  }
  return { day, used, jobs: jobs.map((j) => ({ site: j.site, checkedToday: j.checkedToday, queued: j.queue.length })) };
}
