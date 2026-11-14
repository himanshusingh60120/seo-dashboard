// lib/archive.ts
// Saved history: Search Console and GA4 numbers copied into the Google Sheets, so the dashboard still has them after
// Google stops showing them (Search Console keeps about 16 months). There's no scheduled job: when someone opens a
// property in the dashboard, it calls /api/archive/refresh, which brings that property's history up to date using the
// signed-in person's own Google access. The first open of a Pacific day does the work; later opens return at once.
// The saved history feeds the dashboard's Compare months mode (lib/compare.ts).
//
// Daily totals are two sections (columns) at the far right of each property's tab:
//   "Search daily"  – clicks, impressions, CTR and position for every day
//   "Traffic daily" – GA4 active users, new users, sessions, views, engagement and organic sessions for every day
// Monthly lists each get a tab of their own, placed by lib/sheetParts.ts (which adds continuation Sheets when one fills up):
//   "Search · 2026-11" – the month's top pages and queries, all countries and devices
//   "GA4 · 2026-11"    – the month's totals (GA4's own monthly active users), channels, devices, countries, landing pages
// Each monthly tab's header row records where each block of rows starts and ends, so readers fetch only what they need.
//
// Numbers keep settling after the fact (GA4 goes on processing for a few days), so every update fetches the last 14
// days again and overwrites them, together with every day missed since the last update. Saving this week therefore
// refreshes last week too, and a property nobody opened for a while catches up on its next open (as long as Google
// still has those days: about 16 months for Search Console). The first opens also fill in the 16 months Google still
// has, a few months per request, until the history is complete.
//
// The control Sheet's hidden _Archive tab has one row per property: its GA4 property and how far the history goes.
// Server-only.
import { appendRows, batchRead, controlBook, ensureTab, readRange, tabs, writeRange, type Book, type Row } from "./sheets";
import { SEC, ensureSections, sectionRange, writeSection } from "./sheetLayout";
import { findSheet, propertySheet } from "./sheetBooks";
import { AI_PAGES_PREFIX, partsOf, writeTab } from "./sheetParts";
import { ga4TimeZone, latestFinalDate, runReport, searchAnalyticsAll } from "./google";
import { GSC_TZ, addDays, todayIn } from "./dates";

export const ARCHIVE_TAB = "_Archive";
const HEADERS = [
  "Property", "GA4 property", "Linked by", "Linked at",
  "Search daily through", "Search lists through", "Search months from", "Search updated (day)",
  "GA4 daily through", "GA4 lists through", "GA4 months from", "GA4 updated (day)",
  "Last update", "Updated by", "Last message", "Busy since",
];
export const SEARCH_PREFIX = "Search · ";
export const GA4_PREFIX = "GA4 · ";

/** Days fetched again on every update, so late changes from Google are picked up. */
const RESTATE_DAYS = 14;
/** How far back Google still has data: a little under Search Console's 16 months. */
const HISTORY_DAYS = 480;
/** Roughly where Search Console's own history ends today. */
const GOOGLE_KEEPS_DAYS = 486;
/** Top pages and top queries kept per month (each). */
const ROWS_PER_MONTH = Math.max(1000, Math.min(25_000, Math.floor(Number(process.env.ARCHIVE_ROWS_PER_MONTH) || 10_000)));
const GA_DAILY_METRICS = ["activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration"];
const GA_MONTH_METRICS = ["sessions", "activeUsers", "newUsers", "screenPageViews", "engagementRate", "averageSessionDuration", "keyEvents"];
const PROBE = { dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }], metrics: [{ name: "sessions" }], limit: 1 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const s = (v: unknown) => (v == null ? "" : String(v).trim());
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const minD = (a: string, b: string) => (a < b ? a : b);
const maxD = (a: string, b: string) => (a > b ? a : b);
const monthOf = (d: string) => d.slice(0, 7);
const shiftMonth = (m: string, k: number) => {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const monthEnd = (m: string) => addDays(`${shiftMonth(m, 1)}-01`, -1);
const gaDate = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
/** The earliest full month Google still has, counting back from `end`. */
const firstMonth = (end: string) => shiftMonth(monthOf(addDays(end, -HISTORY_DAYS)), 1);

/** Months whose lists need fetching again: from 14 days before the last update (or ~6 weeks back the first time) to now. */
function monthsToRefresh(listsThrough: string, end: string) {
  const base = listsThrough ? minD(listsThrough, end) : addDays(end, -31);
  const start = maxD(addDays(end, -HISTORY_DAYS), addDays(base, -(RESTATE_DAYS - 1)));
  const out: string[] = [];
  for (let m = monthOf(start); m <= monthOf(end); m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/** Rows grouped into blocks by type, plus the index of where each block sits ({ Page: [2, 10001], … }, 1-based rows). */
function blocked(groups: [string, Row[]][]) {
  const rows: Row[] = [];
  const blocks: Record<string, [number, number]> = {};
  for (const [type, list] of groups) {
    if (!list.length) continue;
    const start = rows.length + 2;
    rows.push(...list);
    blocks[type] = [start, rows.length + 1];
  }
  return { rows, index: JSON.stringify({ v: 2, blocks }) };
}

/* ---------------- _Archive (control Sheet): one row per property ---------------- */

type ArchiveRow = {
  row: number; site: string; ga4: string; linkedBy: string; linkedAt: string;
  sDaily: string; sLists: string; sFrom: string; sDay: string;
  gDaily: string; gLists: string; gFrom: string; gDay: string;
  lastRun: string; lastBy: string; message: string; busy: string;
};

export async function readArchive(): Promise<ArchiveRow[]> {
  const control = controlBook();
  await ensureTab(control, ARCHIVE_TAB, HEADERS);
  const rows = await readRange(control, ARCHIVE_TAB, "A2:P");
  return rows
    .map((r, i) => ({
      row: i + 2, site: s(r[0]), ga4: s(r[1]), linkedBy: s(r[2]), linkedAt: s(r[3]),
      sDaily: s(r[4]), sLists: s(r[5]), sFrom: s(r[6]), sDay: s(r[7]),
      gDaily: s(r[8]), gLists: s(r[9]), gFrom: s(r[10]), gDay: s(r[11]),
      lastRun: s(r[12]), lastBy: s(r[13]), message: s(r[14]), busy: s(r[15]),
    }))
    .filter((a) => a.site);
}

async function saveRow(a: ArchiveRow) {
  await writeRange(controlBook(), ARCHIVE_TAB, `A${a.row}:P${a.row}`, [
    [
      a.site, a.ga4, a.linkedBy, a.linkedAt, a.sDaily, a.sLists, a.sFrom, a.sDay,
      a.gDaily, a.gLists, a.gFrom, a.gDay, a.lastRun, a.lastBy, a.message.slice(0, 500), a.busy,
    ],
  ]);
}

/** The property's row, created on first use. A GA4 property is linked the first time one is known. */
async function ensureRow(site: string, ga4: string, by: string): Promise<ArchiveRow> {
  const now = new Date().toISOString();
  let a = (await readArchive()).find((r) => r.site === site);
  if (!a) {
    await appendRows(controlBook(), ARCHIVE_TAB, [[site, ga4, ga4 ? by : "", ga4 ? now : "", "", "", "", "", "", "", "", "", "", "", "", ""]]);
    a = (await readArchive()).find((r) => r.site === site);
    if (!a) throw new Error("Couldn't add this property to the saved history.");
  } else if (!a.ga4 && ga4) {
    a.ga4 = ga4;
    a.linkedBy = by;
    a.linkedAt = now;
    await saveRow(a);
  }
  return a;
}

/** Changes a property's GA4 property. Its saved GA4 daily totals start again for the new property. */
export async function linkArchive(site: string, ga4: string, by: string) {
  const a = await ensureRow(site, "", by);
  if (a.ga4 === ga4) return;
  if (a.ga4) {
    const ref = await findSheet(site);
    if (ref) {
      await ensureSections(ref.book, ref.title);
      await writeSection(ref.book, ref.title, "gaDaily", []);
    }
  }
  Object.assign(a, { ga4, linkedBy: by, linkedAt: new Date().toISOString(), gDaily: "", gLists: "", gFrom: "", gDay: "" });
  a.message = `GA4 property ${ga4} linked. Its history is saved the next time this property is opened.`;
  await saveRow(a);
}

/* ---------------- Writing ---------------- */

/** Merges rows into a daily section by date (newer values replace older ones) and keeps it sorted. */
async function upsertDaily(book: Book, title: string, key: "searchDaily" | "gaDaily", fresh: Row[]) {
  if (!fresh.length) return;
  const by = new Map<string, Row>();
  for (const r of await readRange(book, title, sectionRange(key))) if (DATE.test(s(r[0]))) by.set(s(r[0]), r);
  for (const r of fresh) by.set(String(r[0]), r);
  await writeSection(book, title, key, [...by.keys()].sort().map((d) => by.get(d)!));
}

async function searchDaily(a: ArchiveRow, token: string, book: Book, title: string, end: string) {
  const earliest = addDays(end, -HISTORY_DAYS);
  const from = a.sDaily ? maxD(earliest, addDays(minD(a.sDaily, end), -(RESTATE_DAYS - 1))) : earliest;
  const rows = await searchAnalyticsAll(token, a.site, { startDate: from, endDate: end, dimensions: ["date"] }, 1000);
  const now = new Date().toISOString();
  await upsertDaily(book, title, "searchDaily", rows.map((r) => [r.keys[0], r.clicks, r.impressions, round(r.ctr), round(r.position, 2), now]));
  a.sDaily = end;
}

async function searchMonth(site: string, token: string, m: string, end: string) {
  const from = `${m}-01`;
  const to = minD(monthEnd(m), end);
  if (from > to) return;
  const body = { startDate: from, endDate: to };
  const [pages, queries, countries, devices] = await Promise.all([
    searchAnalyticsAll(token, site, { ...body, dimensions: ["page"] }, ROWS_PER_MONTH),
    searchAnalyticsAll(token, site, { ...body, dimensions: ["query"] }, ROWS_PER_MONTH),
    searchAnalyticsAll(token, site, { ...body, dimensions: ["country"] }, 300),
    searchAnalyticsAll(token, site, { ...body, dimensions: ["device"] }, 10),
  ]);
  const row = (type: string) => (r: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }): Row =>
    [type, r.keys[0], r.clicks, r.impressions, round(r.ctr), round(r.position, 2)];
  const { rows, index } = blocked([
    ["Page", pages.map(row("Page"))],
    ["Query", queries.map(row("Query"))],
    ["Country", countries.map(row("Country"))],
    ["Device", devices.map(row("Device"))],
  ]);
  await writeTab(
    site,
    SEARCH_PREFIX + m,
    ["Type", "Name", "Clicks", "Impressions", "CTR", "Position", `${from} to ${to} · saved ${new Date().toISOString()} · top ${ROWS_PER_MONTH.toLocaleString("en-US")} pages and queries`, index],
    rows
  );
}

async function gaDaily(a: ArchiveRow, token: string, book: Book, title: string, yesterday: string) {
  const earliest = addDays(yesterday, -HISTORY_DAYS);
  const from = a.gDaily ? maxD(earliest, addDays(minD(a.gDaily, yesterday), -(RESTATE_DAYS - 1))) : earliest;
  const range = { startDate: from, endDate: yesterday };
  const [main, organic] = await Promise.all([
    runReport(token, a.ga4, { dateRanges: [range], dimensions: [{ name: "date" }], metrics: GA_DAILY_METRICS.map((name) => ({ name })), limit: 1000 }),
    runReport(token, a.ga4, {
      dateRanges: [range], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }],
      dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } },
      limit: 1000,
    }),
  ]);
  const org = new Map(organic.rows.map((r) => [r.dims[0], r.mets[0]]));
  const now = new Date().toISOString();
  await upsertDaily(
    book,
    title,
    "gaDaily",
    main.rows.map((r) => [
      gaDate(r.dims[0]), r.mets[0] ?? 0, r.mets[1] ?? 0, r.mets[2] ?? 0, r.mets[3] ?? 0, round(r.mets[4] ?? 0), round(r.mets[5] ?? 0, 1),
      org.get(r.dims[0]) ?? 0, now,
    ])
  );
  a.gDaily = yesterday;
}

async function gaMonth(a: ArchiveRow, token: string, m: string, yesterday: string) {
  const from = `${m}-01`;
  const to = minD(monthEnd(m), yesterday);
  if (from > to) return;
  const q = (dim: string | null, limit: number) =>
    runReport(token, a.ga4, {
      dateRanges: [{ startDate: from, endDate: to }],
      ...(dim ? { dimensions: [{ name: dim }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }] } : {}),
      metrics: GA_MONTH_METRICS.map((name) => ({ name })),
      limit,
    });
  const [total, channels, devices, countries, landing] = await Promise.all([
    q(null, 1), q("sessionDefaultChannelGroup", 50), q("deviceCategory", 10), q("country", 250), q("landingPage", 5000),
  ]);
  const row = (type: string, name: string, m2: number[]): Row => [
    type, name, m2[0] ?? 0, m2[1] ?? 0, m2[2] ?? 0, m2[3] ?? 0, round(m2[4] ?? 0), round(m2[5] ?? 0, 1), m2[6] ?? 0,
  ];
  const list = (type: string, r: { rows: { dims: string[]; mets: number[] }[] }) => r.rows.map((x) => row(type, x.dims[0], x.mets));
  const { rows, index } = blocked([
    ["Total", total.rows.length ? [row("Total", "All traffic", total.rows[0].mets)] : []],
    ["Channel", list("Channel", channels)],
    ["Device", list("Device", devices)],
    ["Country", list("Country", countries)],
    ["Landing page", list("Landing page", landing)],
  ]);
  await writeTab(
    a.site,
    GA4_PREFIX + m,
    ["Type", "Name", "Sessions", "Active users", "New users", "Views", "Engagement rate", "Avg session (s)", "Key events", `GA4 property ${a.ga4} · ${from} to ${to} · saved ${new Date().toISOString()}`, index],
    rows
  );
}

/** Search Console part of an update. Returns false if it ran out of time (the dashboard then asks again). */
async function searchPart(a: ArchiveRow, token: string, book: Book, title: string, end: string, day: string, timeLeft: () => boolean) {
  if (a.sDay !== day || !a.sDaily) {
    await searchDaily(a, token, book, title, end);
    await saveRow(a);
    for (const m of monthsToRefresh(a.sLists, end)) {
      if (!timeLeft()) return false;
      await searchMonth(a.site, token, m, end);
      a.sLists = minD(monthEnd(m), end);
      if (!a.sFrom || m < a.sFrom) a.sFrom = m;
      await saveRow(a);
    }
    a.sDay = day;
  }
  const target = firstMonth(end);
  while (a.sFrom && a.sFrom > target) {
    if (!timeLeft()) return false;
    const m = shiftMonth(a.sFrom, -1);
    await searchMonth(a.site, token, m, end);
    a.sFrom = m;
    await saveRow(a);
  }
  return true;
}

/** GA4 part of an update. Returns false if it ran out of time. */
async function gaPart(a: ArchiveRow, token: string, book: Book, title: string, day: string, timeLeft: () => boolean) {
  const tz = await ga4TimeZone(token, a.ga4);
  const yesterday = addDays(todayIn(tz), -1);
  if (a.gDay !== day || !a.gDaily) {
    await gaDaily(a, token, book, title, yesterday);
    await saveRow(a);
    for (const m of monthsToRefresh(a.gLists, yesterday)) {
      if (!timeLeft()) return false;
      await gaMonth(a, token, m, yesterday);
      a.gLists = minD(monthEnd(m), yesterday);
      if (!a.gFrom || m < a.gFrom) a.gFrom = m;
      await saveRow(a);
    }
    a.gDay = day;
  }
  const target = firstMonth(yesterday);
  while (a.gFrom && a.gFrom > target) {
    if (!timeLeft()) return false;
    const m = shiftMonth(a.gFrom, -1);
    await gaMonth(a, token, m, yesterday);
    a.gFrom = m;
    await saveRow(a);
  }
  return true;
}

/**
 * Brings one property's saved history up to date, with the signed-in person's access, until `deadline`.
 * done = nothing left to do for now; false means it ran out of time and the dashboard should ask again.
 */
export async function refreshArchive(o: { site: string; ga4: string; by: string; token: string; deadline: number }) {
  const day = todayIn(GSC_TZ);
  const target = firstMonth(addDays(day, -3));
  const a = await ensureRow(o.site, o.ga4, o.by);
  const upToDate =
    a.sDay === day && !!a.sFrom && a.sFrom <= target && (!a.ga4 || (a.gDay === day && !!a.gFrom && a.gFrom <= target));
  if (upToDate) return { done: true, message: a.message };
  if (a.busy && Date.now() - Date.parse(a.busy) < 90_000) {
    return { done: true, message: "Someone else is updating this property's history right now." };
  }
  a.busy = new Date().toISOString();
  await saveRow(a);

  const timeLeft = () => Date.now() < o.deadline;
  let done = true;
  const notes: string[] = [];
  try {
    const { book, title } = await propertySheet(o.site, "Saved history");
    await ensureSections(book, title);
    const end = await latestFinalDate(o.token, o.site);
    if (!(await searchPart(a, o.token, book, title, end, day, timeLeft))) done = false;
    notes.push(`Search Console saved through ${a.sDaily || "–"} (monthly lists from ${a.sFrom || "–"})`);

    if (!a.ga4) notes.push("No GA4 property linked yet");
    else if (!timeLeft()) done = false;
    else {
      let canRead = true;
      try {
        await runReport(o.token, a.ga4, PROBE);
      } catch {
        canRead = false;
      }
      if (!canRead) notes.push(`GA4 ${a.ga4} not updated: ${o.by} can't open it`);
      else {
        if (!(await gaPart(a, o.token, book, title, day, timeLeft))) done = false;
        notes.push(`GA4 ${a.ga4} saved through ${a.gDaily || "–"} (monthly lists from ${a.gFrom || "–"})`);
      }
    }
    a.message = notes.join(" · ");
  } catch (e) {
    a.message = `Stopped: ${e instanceof Error ? e.message : "error"}`;
    done = true; // don't keep asking on an error; the next open tries again
  } finally {
    a.busy = "";
    a.lastRun = new Date().toISOString();
    a.lastBy = o.by;
    await saveRow(a).catch(() => {});
  }
  return { done, message: a.message };
}

/* ---------------- Status ---------------- */

/** How far the saved history goes for a property, and which Sheets hold it. */
export async function archiveStatus(site: string) {
  const a = (await readArchive()).find((r) => r.site === site) || null;
  const ref = await findSheet(site);
  const parts = ref ? await partsOf(site) : [];
  const names: string[] = [];
  let searchDays = 0;
  let gaDays = 0;
  if (ref) {
    const t = (await tabs(ref.book)).get(ref.title);
    if (t && t.cols >= SEC.gaDaily.end) {
      const [sd, gd] = await batchRead(ref.book, [
        { title: ref.title, range: `${SEC.searchDaily.L}3:${SEC.searchDaily.L}` },
        { title: ref.title, range: `${SEC.gaDaily.L}3:${SEC.gaDaily.L}` },
      ]);
      searchDays = sd.filter((r) => DATE.test(s(r[0]))).length;
      gaDays = gd.filter((r) => DATE.test(s(r[0]))).length;
    }
    for (const p of parts) for (const name of (await tabs(p.book)).keys()) names.push(name);
  }
  const months = (prefix: string) => names.filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length)).sort();
  return {
    link: a && {
      ga4: a.ga4, linkedBy: a.linkedBy, linkedAt: a.linkedAt, searchThrough: a.sDaily, searchFrom: a.sFrom,
      gaThrough: a.gDaily, gaFrom: a.gFrom, lastRun: a.lastRun, lastBy: a.lastBy, message: a.message,
    },
    searchDays,
    gaDays,
    months: { search: months(SEARCH_PREFIX), ga4: months(GA4_PREFIX), ai: months(AI_PAGES_PREFIX) },
    parts: parts.map((p) => ({ part: p.part, url: p.url })),
    googleKeepsFrom: addDays(todayIn(GSC_TZ), -GOOGLE_KEEPS_DAYS),
  };
}
