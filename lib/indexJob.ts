// lib/indexJob.ts
// Daily index checks for enrolled properties, stored in the Google Sheet (INDEX_SHEET_ID).
//
// Only Google's URL Inspection decides whether a URL is Indexed or Not indexed. Search impressions are used only to
// decide what to check first. Every tracked URL goes through a rotation within the daily budget (oldest result first),
// so each URL is re-checked about every (URLs ÷ daily budget) days, automatically.
//
// Each property has ONE row in _Jobs and ONE tab with one row per URL, whoever started it, so nothing is checked twice.
//   plan (hourly; acts once per Pacific day per property, after Google's quota resets): reads the sitemaps and the
//     Search Console impressions per page (both free), adds new URLs and builds today's queue:
//       1. pages with no impressions for 4+ days that had impressions before (up to half the budget),
//       2. "Not indexed" pages that have impressions again,
//       3. URLs never checked (taking turns across sitemaps),
//       4. pages whose sitemap lastmod is newer than their last check,
//       5. failed checks,
//       6. pages that were quiet and now have impressions again (confirmation),
//       7. everything else, oldest result first (the rotation).
//   run (every 10 minutes): inspects queued URLs in small batches and writes each result to its row.
// Search Console is read as the service account when it has been added to the property; otherwise as the person who
// started the checks (their saved Google sign-in, see lib/userCredential.ts). The Sheet is always the service account.
// Status changes are also written to the _Changes tab. Rows are only added at the bottom, never moved.
import { serviceAccountToken } from "./serviceAccount";
import { userAccessToken } from "./userCredential";
import {
  appendRows, batchRead, clearRange, colLetter, ensureSize, ensureTab, readRange, readRanges, safeTitle, sheetUrl,
  tabs, writeRange, writeRanges, type Row,
} from "./sheets";
import { collect } from "./sitemapReader";
import { HttpError } from "./token";
import { errorInspection, inspectUrl, latestFinalDate, listSites, searchAnalyticsAll, MAX_ROWS, type InspectionResult } from "./google";
import { addDays, GSC_TZ, todayIn } from "./dates";
import { normalizeUrl } from "./url";

const DAY = 864e5;

export const JOBS_TAB = "_Jobs";
export const SITEMAPS_TAB = "_Sitemaps";
export const LOG_TAB = "_Log";
export const CHANGES_TAB = "_Changes";
/** Value of the "Runs as" column when Search Console is read as the service account. */
export const SA_LABEL = "Service account";

/** Inspections per property per day for this job. Google allows 2,000; the rest is left for people using the dashboard. */
export const DEFAULT_BUDGET = Math.min(1900, Math.max(1, Math.floor(Number(process.env.INDEX_DAILY_BUDGET) || 1800)));
/** "Quiet": no impressions on the latest 4 complete days… */
const QUIET_DAYS = 4;
/** …after at least this many impressions in the 14 days before. */
const QUIET_MIN_BEFORE = 3;
/** A quiet page that was checked and still indexed isn't re-checked for its quiet streak for this many days. */
const QUIET_COOLDOWN_DAYS = 7;
/** Quiet pages may use at most this share of the daily budget, so the rotation keeps moving. */
const QUIET_SHARE = 0.5;
const FLAG_QUIET = `No impressions for ${QUIET_DAYS}+ days, checking`;
const FLAG_BACK = "Back in search, checking";
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
  "Queue (row numbers)", "Checked today", "Last run", "Last message", "Runs as", "Plan stats",
];
export const SITEMAP_HEADERS = ["Property", "Sitemap", "URLs", "Verified", "Indexed", "Not indexed", "Errors", "Not checked yet", "% verified", "Updated"];
export const LOG_HEADERS = ["Time", "Property", "Step", "Inspections used", "Indexed", "Not indexed", "Errors", "Drops confirmed", "Note"];
export const CHANGE_HEADERS = ["Time", "Property", "URL", "Change", "Before", "After", "Inspection link"];

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

/** Written by the daily plan: how far the rotation has got. */
export type PlanStats = {
  tracked: number; verified: number; unchecked: number; seenInSearch: number; quiet: number;
  oldest: string; cycleDays: number; firstPassDays: number;
};

export type Job = {
  row: number; site: string; tab: string; enabled: boolean; budget: number;
  planDay: string; planStatus: string; plannedAt: string; queue: number[];
  checkedToday: number; lastRun: string; message: string; runAs: string; stats: PlanStats | null;
};

const parseStats = (v: unknown): PlanStats | null => {
  try {
    const o = JSON.parse(s(v));
    return o && typeof o === "object" ? (o as PlanStats) : null;
  } catch {
    return null;
  }
};

export async function readJobs(): Promise<Job[]> {
  await ensureTab(JOBS_TAB, JOB_HEADERS);
  const t = (await tabs()).get(JOBS_TAB);
  if (t && t.cols < JOB_HEADERS.length) await ensureTab(JOBS_TAB, JOB_HEADERS, true); // adds new columns to older sheets
  const rows = await readRange(JOBS_TAB, "A2:O");
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
        runAs: s(r[13]).trim() || SA_LABEL,
        stats: parseStats(r[14]),
      })
    )
    .filter((j) => j.site);
}

async function saveJob(j: Job) {
  await writeRange(JOBS_TAB, `B${j.row}:B${j.row}`, [[j.tab]]);
  await writeRange(JOBS_TAB, `G${j.row}:O${j.row}`, [
    [
      j.planDay, j.planStatus, j.plannedAt, j.queue.join(","), j.checkedToday, j.lastRun, j.message.slice(0, 500), j.runAs,
      j.stats ? JSON.stringify(j.stats) : "",
    ],
  ]);
}

/** The Search Console access token for this job: the service account, or the saved sign-in of the person in "Runs as". */
function jobToken(j: Job): Promise<string> {
  return !j.runAs || j.runAs === SA_LABEL ? serviceAccountToken() : userAccessToken(j.runAs);
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

/** Adds rows to _Changes (dropped, newly indexed, impressions stopped…). Never fails a job. */
async function recordChanges(rows: Row[]) {
  if (!rows.length) return;
  try {
    await ensureTab(CHANGES_TAB, CHANGE_HEADERS);
    await appendRows(CHANGES_TAB, rows);
  } catch {
    /* a convenience, like the log */
  }
}

/* ---------------- Turning checks on and off ---------------- */

/** True when the service account has been added as a user of this Search Console property. */
export async function serviceAccountCanRead(site: string) {
  const sites = await listSites(await serviceAccountToken());
  return sites.some((x) => x.siteUrl === site);
}

/**
 * Starts or pauses daily checks for a property. Starting a property that isn't in the Sheet yet adds its _Jobs row
 * and its tab; starting one that is already there reuses them (nothing is checked twice).
 */
export async function setEnabled(site: string, enabled: boolean, by: string, runAs: string = SA_LABEL) {
  const jobs = await readJobs();
  const j = jobs.find((x) => x.site === site);
  if (j) {
    await writeRange(JOBS_TAB, `C${j.row}:C${j.row}`, [[enabled]]);
    if (enabled) {
      await writeRange(JOBS_TAB, `N${j.row}:N${j.row}`, [[runAs]]);
      if (j.planStatus === "error") await writeRange(JOBS_TAB, `H${j.row}:H${j.row}`, [["waiting"]]);
      await ensureTab(j.tab, URL_HEADERS);
    }
    return;
  }
  if (!enabled) return;
  const tab = tabFor(site);
  await ensureTab(tab, URL_HEADERS);
  await appendRows(JOBS_TAB, [
    [site, tab, true, DEFAULT_BUDGET, by, new Date().toISOString(), "", "waiting", "", "", 0, "", "Added. The first daily plan runs within the hour.", runAs, ""],
  ]);
}

/** This property's job, per-sitemap summary and recent status changes, for the dashboard. */
export async function propertyStatus(site: string) {
  const job = (await readJobs()).find((j) => j.site === site) || null;
  const [smRows, chRows] = await batchRead([
    { title: SITEMAPS_TAB, range: "A2:J" },
    { title: CHANGES_TAB, range: "A2:G" },
  ]);
  const sitemaps = smRows
    .filter((r) => s(r[0]) === site)
    .map((r) => ({
      sitemap: s(r[1]), urls: n(r[2]), verified: n(r[3]), indexed: n(r[4]), notIndexed: n(r[5]),
      errors: n(r[6]), notChecked: n(r[7]), pctVerified: n(r[8]), updated: s(r[9]),
    }));
  const changes = chRows
    .filter((r) => s(r[1]) === site)
    .slice(-300)
    .reverse()
    .map((r) => ({ at: s(r[0]), url: s(r[2]), change: s(r[3]), before: s(r[4]), after: s(r[5]), link: s(r[6]) }));
  return {
    job: job && {
      tab: job.tab, enabled: job.enabled, budget: job.budget, planDay: job.planDay, planStatus: job.planStatus,
      queued: job.queue.length, checkedToday: job.checkedToday, lastRun: job.lastRun, message: job.message, runAs: job.runAs,
      stats: job.stats,
    },
    sitemaps,
    changes,
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
    const byInspection = s(r[C.verifiedBy]) === "URL Inspection";
    if (st === "Indexed" && byInspection) g.indexed++;
    else if (st === "Not indexed" && byInspection) g.notIndexed++;
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

  // Prefer the service account; fall back to the saved sign-in of the person who started the checks.
  const saOk = await serviceAccountCanRead(job.site).catch(() => false);
  if (saOk) job.runAs = SA_LABEL;
  else if (!job.runAs || job.runAs === SA_LABEL) {
    await saveJob(job);
    throw new Error(
      "The service account can't open this property and nobody's Google sign-in is saved for it. Anyone who can open it in Search Console can open the Index checks tab and click “Use my Google sign-in”."
    );
  }
  await saveJob(job);
  const token = await jobToken(job);
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
    byPage(addDays(end, -(QUIET_DAYS - 1)), end),
    byPage(addDays(end, -(QUIET_DAYS + 13)), addDays(end, -QUIET_DAYS)),
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

  // 3. Decide what to inspect today. Only URL Inspection sets Indexed / Not indexed.
  const now = new Date().toISOString();
  const changes: Row[] = [];
  type Due = { i: number; p: number; sitemap: string; inspected: string };
  const due: Due[] = [];
  let tracked = 0;
  let verified = 0;
  let seenInSearch = 0;
  let quietCount = 0;
  let reset = 0;
  let oldest = "";

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
    if (r[C.source] === "No longer listed") return;
    tracked++;
    if (rec > 0) seenInSearch++;

    // Results that earlier versions took from impressions are cleared: those URLs wait for a real inspection.
    if (s(r[C.verifiedBy]) === "Impressions") {
      r[C.status] = "Not checked yet";
      r[C.verifiedBy] = "";
      r[C.reason] = "";
      r[C.inspected] = "";
      reset++;
    }
    const inspected = s(r[C.inspected]);
    if (!inspected && s(r[C.status]) !== "Not checked yet") r[C.status] = "Not checked yet";
    const status = s(r[C.status]);
    const flag = s(r[C.flag]);
    const age = ageDays(day, inspected);
    if (status === "Indexed" || status === "Not indexed") {
      verified++;
      if (!oldest || inspected < oldest) oldest = inspected;
    }

    const quiet = rec === 0 && base >= QUIET_MIN_BEFORE;
    let p = 0;
    if (quiet && status !== "Not indexed") {
      if (age >= QUIET_COOLDOWN_DAYS) {
        p = 1;
        quietCount++;
        if (!flag.startsWith("No impressions")) {
          changes.push([now, job.site, url, "Impressions stopped", `${base} impressions in the 14 days before`, "Being checked with URL Inspection", s(r[C.link])]);
        }
        r[C.flag] = FLAG_QUIET;
      } else {
        r[C.flag] = `No impressions for ${QUIET_DAYS}+ days · still indexed when checked on ${inspected.slice(0, 10)}`;
      }
    } else if (rec > 0 && status === "Not indexed" && age >= 1) {
      p = 2;
      if (!flag.startsWith("Back in search")) {
        changes.push([now, job.site, url, "Back in search", "Not indexed", "Has impressions again; being checked", s(r[C.link])]);
      }
      r[C.flag] = FLAG_BACK;
    } else if (!inspected) {
      p = 3;
    } else if (s(r[C.lastmod]) && s(r[C.lastmod]).slice(0, 10) > inspected.slice(0, 10)) {
      p = 4;
    } else if (status === "Error" && age >= 1) {
      p = 5;
    } else if (rec > 0 && flag.startsWith("No impressions") && age >= 1) {
      p = 6;
      changes.push([now, job.site, url, "Back in search", "No impressions", "Has impressions again; being checked", s(r[C.link])]);
      r[C.flag] = FLAG_BACK;
    } else if (age >= 1) {
      p = 7;
    }
    if (p) due.push({ i, p, sitemap: s(r[C.sitemap]), inspected });
  });

  // 4. Today's queue, within the daily budget.
  due.sort((a, b) => a.p - b.p || (a.inspected < b.inspected ? -1 : a.inspected > b.inspected ? 1 : 0));
  const queue: number[] = [];
  const room = () => queue.length < job.budget;
  const quietCap = Math.floor(job.budget * QUIET_SHARE);
  for (const d of due) if (d.p === 1 && queue.length < quietCap) queue.push(d.i + 2);
  for (const d of due) if (d.p === 2 && room()) queue.push(d.i + 2);
  const fresh = new Map<string, Due[]>();
  for (const d of due) {
    if (d.p !== 3) continue;
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
  for (const d of due) if (d.p > 3 && room()) queue.push(d.i + 2);

  // 5. "Next check" for every row.
  const queued = new Set(queue);
  const cycleDays = Math.max(1, Math.ceil(tracked / Math.max(1, job.budget)));
  rows.forEach((r, i) => {
    if (!s(r[C.url])) return;
    if (queued.has(i + 2)) r[C.nextCheck] = day;
    else if (r[C.source] === "No longer listed") r[C.nextCheck] = "Not checked (no longer in a sitemap or search)";
    else if (!s(r[C.inspected])) r[C.nextCheck] = "Waiting for its first check";
    else r[C.nextCheck] = `In rotation (about every ${cycleDays} days)`;
  });

  // 6. Save the tab in chunks so each request stays small.
  await ensureSize(job.tab, rows.length + 1, W);
  for (let i = 0; i < rows.length; i += 4000) {
    const part = rows.slice(i, i + 4000);
    await writeRange(job.tab, `A${i + 2}:${LAST}${i + 1 + part.length}`, part);
  }
  await writeSitemapSummary(job.site, rows, sm.errors);
  await recordChanges(changes);

  const unchecked = tracked - verified;
  job.stats = {
    tracked,
    verified,
    unchecked,
    seenInSearch,
    quiet: quietCount,
    oldest: unchecked ? "" : oldest,
    cycleDays,
    firstPassDays: Math.ceil(unchecked / Math.max(1, job.budget)),
  };
  job.planDay = day;
  job.planStatus = "ready";
  job.queue = queue;
  job.checkedToday = 0;
  job.message =
    `${tracked.toLocaleString()} URLs tracked (${added.toLocaleString()} new) · ${verified.toLocaleString()} checked with URL Inspection · ` +
    `${queue.length.toLocaleString()} queued today` +
    (quietCount ? ` (including ${quietCount.toLocaleString()} with no impressions for ${QUIET_DAYS}+ days)` : "") +
    (reset ? ` · ${reset.toLocaleString()} earlier impression-based results reset` : "") +
    (sm.errors.length ? ` · ${sm.errors.length} sitemap problem(s)` : "");
  await saveJob(job);
  await log(job.site, "plan", {}, `${job.message} · runs as ${job.runAs}`);
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
  const changes: Row[] = [];
  const now = new Date().toISOString();
  for (const x of results) {
    if (!x) continue;
    const { it, res } = x;
    const r = it.row;
    const url = s(it.cells[C.url]);
    done.add(r);
    c.used++;
    const prev = s(it.cells[C.status]);
    const prevFlag = s(it.cells[C.flag]);
    const prevReason = s(it.cells[C.reason]);

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
    if (status === "Not indexed" && (prev === "Indexed" || prevFlag.startsWith("No impressions"))) {
      flag = `Dropped from Google's index (found ${day})`;
      c.drops++;
      changes.push([now, job.site, url, "Dropped from Google's index", prevReason || prev || "Indexed", res.coverageState, res.link]);
    } else if (status === "Indexed" && prevFlag.startsWith("No impressions")) {
      flag = "No recent impressions, but still indexed";
      changes.push([now, job.site, url, "No impressions, still indexed", "No impressions for 4+ days", res.coverageState, res.link]);
    } else if (status === "Indexed" && prev === "Not indexed") {
      flag = `Newly indexed (found ${day})`;
      changes.push([now, job.site, url, "Newly indexed", prevReason || "Not indexed", res.coverageState, res.link]);
    }
    data.push({
      range: `E${r}:K${r}`,
      values: [[status, "URL Inspection", res.coverageState, res.pageFetchState, res.lastCrawlTime, res.googleCanonical, res.checkedAt]],
    });
    data.push({ range: `N${r}:P${r}`, values: [["In rotation", flag, res.link]] });
  }
  if (data.length) await writeRanges(job.tab, data);
  await recordChanges(changes);

  const who = job.runAs === SA_LABEL ? "the service account" : job.runAs;
  const stop = quota
    ? "Google's daily URL Inspection limit for this property was reached (people using the dashboard share it). Checks continue after tomorrow's plan."
    : forbidden
      ? `The Google account used for these checks (${who}) can't open this property any more. Anyone who can open it can click “Use my Google sign-in” in the Index checks tab. (${forbidden})`
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

  const tokens = new Map<Job, string>();
  const stopped = new Set<Job>();
  const touched = new Set<Job>();
  const timeLeft = () => Date.now() < deadline - 15_000;
  let used = 0;

  while (timeLeft()) {
    const active = jobs.filter((j) => !stopped.has(j) && j.queue.length > 0 && j.checkedToday < j.budget);
    if (!active.length) break;
    for (const j of active) {
      if (!timeLeft()) break;
      try {
        let token = tokens.get(j);
        if (!token) {
          token = await jobToken(j);
          tokens.set(j, token);
        }
        const size = Math.min(BATCH, j.budget - j.checkedToday);
        const r = await checkBatch(j, j.queue.slice(0, size), token, day);
        j.queue = j.queue.filter((row) => !r.done.has(row));
        j.checkedToday += r.used;
        used += r.used;
        if (r.used) touched.add(j);
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
      } catch (e) {
        stopped.add(j);
        j.message = `Checks paused: ${e instanceof Error ? e.message : "error"}`.slice(0, 500);
        j.lastRun = new Date().toISOString();
        await saveJob(j).catch(() => {});
        await log(j.site, "check", {}, j.message);
      }
    }
  }

  // Keep the dashboard's counts current: recount each property that got new results in this run.
  for (const j of touched) {
    if (Date.now() > deadline - 5_000) break;
    await refreshSummary(j).catch(() => {});
  }
  return { day, used, jobs: jobs.map((j) => ({ site: j.site, checkedToday: j.checkedToday, queued: j.queue.length })) };
}
