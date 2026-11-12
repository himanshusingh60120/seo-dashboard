// lib/reportStore.ts
// Search Console reports that have no API (Page indexing, Crawl stats, the Generative AI report), kept with their full
// history in sections of the property's own Google Sheet (see lib/sheetBooks.ts and lib/sheetLayout.ts):
//   Page indexing · Google's report   one row per view and day: Indexed, Not indexed, Impressions
//   Why pages aren't indexed          the reasons table, one block per update
//   Crawl stats                       one row per series (All / Refresh / Discovery / other) and day
//   Crawled URLs                      example crawled URLs (from Crawl stats exports)
//   AI impressions                    one row per day
//   AI pages, countries, devices      one block per update
// plus the hidden _Updates tab in the control Sheet (who saved what, and when, for all properties).
// The dashboard still receives the same shapes (IdxStore, CrawlStore, AiStore), so its screens don't change.
// Server-only.
import { appendRows, batchRead, controlBook, ensureTab, tabs, type Row } from "./sheets";
import { assertLayout, sectionRange, writeSection, type SectionKey } from "./sheetLayout";
import { findSheet, propertySheet } from "./sheetBooks";
import { writeOverview } from "./overview";
import { IDX_LABEL, IDX_VIEWS, emptyIdxStore, mergeIdx, type IdxImport, type IdxParsed, type IdxStore, type IdxView, type IdxViewData } from "./indexStats";
import { emptyAiStore, mergeAi, type AiImport, type AiParsed, type AiSnapshot, type AiStore } from "./aiStore";
import type { CrawlDay, CrawlImport, CrawlSeries, CrawlStore, CrawlUrl, SeriesKind } from "./crawlStats";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const s = (v: unknown) => (v == null ? "" : String(v).trim());
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const opt = (v: unknown): number | undefined => {
  if (v === "" || v == null) return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
};
const now = () => new Date().toISOString();

export const UPDATES_TAB = "_Updates";
const UPDATE_HEADERS = ["Time", "Property", "Report", "By", "Source", "From", "To", "Days", "Detail"];
const REPORT = { idx: "Page indexing", crawl: "Crawl stats", ai: "AI impressions" } as const;
const DELETED = "Deleted";
const FROM_UPSTASH = "Copied from Upstash Redis";

/* ---------- Shared helpers ---------- */

const cache = new Map<string, { at: number; v: unknown }>();
/** Saved reports are read at most once a minute per server instance; a save clears its entry. */
async function memo<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.v as T;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const forget = (key: string) => cache.delete(key);
const overview = (site: string) => writeOverview(site).catch(() => {});

async function logUpdates(rows: Row[]) {
  if (!rows.length) return;
  const control = controlBook();
  await ensureTab(control, UPDATES_TAB, UPDATE_HEADERS);
  await appendRows(control, UPDATES_TAB, rows);
}

/** Sections of the property's Sheet (empty when it has no Sheet yet), plus the update log from the control Sheet. */
async function readProperty(site: string, keys: SectionKey[], fresh: boolean): Promise<{ parts: Row[][]; log: Row[] }> {
  await assertLayout();
  const control = controlBook();
  const ref = await findSheet(site, fresh);
  if (fresh) await Promise.all([tabs(control, true), ref ? tabs(ref.book, true) : null]);
  const [parts, logs] = await Promise.all([
    ref
      ? batchRead(ref.book, keys.map((k) => ({ title: ref.title, range: sectionRange(k) })))
      : Promise.resolve(keys.map((): Row[] => [])),
    batchRead(control, [{ title: UPDATES_TAB, range: "A2:I" }]),
  ]);
  return { parts, log: logs[0] };
}

/** This property's log rows for one report, after its most recent "Deleted". */
function mine(log: Row[], site: string, report: string) {
  const rows = log.filter((r) => s(r[1]) === site && s(r[2]) === report);
  let cut = -1;
  rows.forEach((r, i) => {
    if (s(r[4]) === DELETED) cut = i;
  });
  return rows.slice(cut + 1);
}

/* ---------- Page indexing ---------- */

const VIEW_BY_LABEL = new Map<string, IdxView>(IDX_VIEWS.map((v) => [IDX_LABEL[v], v] as [string, IdxView]));
function viewOf(x: unknown): IdxView | null {
  const t = s(x);
  if ((IDX_VIEWS as readonly string[]).includes(t)) return t as IdxView;
  return VIEW_BY_LABEL.get(t) ?? null;
}
const viewOrder = (x: unknown) => {
  const v = viewOf(x);
  return v ? IDX_VIEWS.indexOf(v) : 9;
};
const sortReasons = (rows: Row[]) => rows.sort((a, b) => viewOrder(a[0]) - viewOrder(b[0]) || s(a[1]).localeCompare(s(b[1])));

function pageRowsOf(store: IdxStore): Row[] {
  const out: Row[] = [];
  for (const v of IDX_VIEWS) {
    const view = store.views[v];
    if (!view) continue;
    for (const d of Object.keys(view.days).sort()) {
      const x = view.days[d];
      out.push([IDX_LABEL[v], d, x.indexed, x.notIndexed, x.impressions ?? ""]);
    }
  }
  return out;
}

export function loadIdx(site: string, fresh = false): Promise<IdxStore> {
  return memo(`idx:${site}`, fresh, async () => {
    const {
      parts: [pages, reasons],
      log,
    } = await readProperty(site, ["pages", "reasons"], fresh);
    const store = emptyIdxStore();
    const viewData = (v: IdxView): IdxViewData => (store.views[v] ||= { days: {}, reasons: [], reasonsHistory: {} });
    for (const r of pages) {
      const v = viewOf(r[0]), d = s(r[1]);
      if (!v || !DATE.test(d)) continue;
      const imp = opt(r[4]);
      viewData(v).days[d] = { indexed: n(r[2]), notIndexed: n(r[3]), ...(imp != null ? { impressions: imp } : {}) };
    }
    for (const r of reasons) {
      const v = viewOf(r[0]), asOf = s(r[1]), reason = s(r[2]);
      if (!v || !DATE.test(asOf) || !reason) continue;
      const view = viewData(v);
      (view.reasonsHistory[asOf] ||= {})[reason] = n(r[5]);
      if (!view.reasonsAsOf || asOf > view.reasonsAsOf) {
        view.reasonsAsOf = asOf;
        view.reasons = [];
      }
      if (asOf === view.reasonsAsOf) view.reasons.push({ reason, source: s(r[3]), validation: s(r[4]), pages: n(r[5]) });
    }
    store.imports = mine(log, site, REPORT.idx)
      .slice(-100)
      .map(
        (r): IdxImport => ({
          at: s(r[0]),
          ...(s(r[3]) ? { by: s(r[3]) } : {}),
          from: s(r[5]),
          to: s(r[6]),
          views: s(r[8]).split(",").map(viewOf).filter((v): v is IdxView => !!v),
        })
      );
    return store;
  });
}

export async function saveIdx(site: string, parsed: IdxParsed, by: string, source: string): Promise<IdxStore> {
  const { book, title } = await propertySheet(site, by);
  const store = mergeIdx(await loadIdx(site, true), parsed, by);
  // Reasons: earlier updates stay as they are; a new copy for the same view and date replaces that block.
  const [old] = await batchRead(book, [{ title, range: sectionRange("reasons") }]);
  const replaced = new Set<string>();
  const added: Row[] = [];
  for (const v of IDX_VIEWS) {
    const pv = parsed[v];
    if (!pv || !pv.reasons.length || !pv.asOf) continue;
    replaced.add(`${v}|${pv.asOf}`);
    for (const r of pv.reasons) added.push([IDX_LABEL[v], pv.asOf, r.reason, r.source, r.validation, r.pages]);
  }
  const reasonRows = sortReasons([...old.filter((r) => s(r[0]) && !replaced.has(`${viewOf(r[0])}|${s(r[1])}`)), ...added]);
  await writeSection(book, title, "pages", pageRowsOf(store));
  await writeSection(book, title, "reasons", reasonRows);
  const last = store.imports[store.imports.length - 1];
  const days = Math.max(0, ...IDX_VIEWS.map((v) => Object.keys(parsed[v]?.days || {}).length));
  await logUpdates([[last.at, site, REPORT.idx, by, source, last.from, last.to, days, last.views.join(",")]]);
  forget(`idx:${site}`);
  await overview(site);
  return store;
}

/** One-time copy of data saved before the Sheets existed. */
export async function restoreIdx(site: string, old: IdxStore) {
  const { book, title } = await propertySheet(site, FROM_UPSTASH);
  const reasons: Row[] = [];
  for (const v of IDX_VIEWS) {
    const view = old.views?.[v];
    if (!view) continue;
    const meta = new Map((view.reasons || []).map((r) => [r.reason, r] as const));
    for (const [asOf, m] of Object.entries(view.reasonsHistory || {})) {
      for (const [reason, pages] of Object.entries(m)) {
        const x = asOf === view.reasonsAsOf ? meta.get(reason) : undefined;
        reasons.push([IDX_LABEL[v], asOf, reason, x?.source ?? "", x?.validation ?? "", pages]);
      }
    }
  }
  await writeSection(book, title, "pages", pageRowsOf(old));
  await writeSection(book, title, "reasons", sortReasons(reasons));
  await logUpdates((old.imports || []).map((i) => [i.at, site, REPORT.idx, i.by || "", FROM_UPSTASH, i.from, i.to, "", (i.views || []).join(",")]));
  forget(`idx:${site}`);
  await overview(site);
}

export async function clearIdx(site: string, by: string) {
  const { book, title } = await propertySheet(site, by);
  await writeSection(book, title, "pages", []);
  await writeSection(book, title, "reasons", []);
  await logUpdates([[now(), site, REPORT.idx, by, DELETED, "", "", 0, ""]]);
  forget(`idx:${site}`);
  await overview(site);
}

/* ---------- Crawl stats ---------- */

const KINDS: SeriesKind[] = ["total", "refresh", "discovery", "other"];
const CRAWL_LABEL: Record<SeriesKind, string> = { total: "All crawl requests", refresh: "Refresh", discovery: "Discovery", other: "Other breakdown" };
const kindOfKey = (key: string): SeriesKind => (key === "total" || key === "refresh" || key === "discovery" ? key : "other");
const MAX_DAYS = 1100;

async function writeCrawl(site: string, series: Record<string, CrawlSeries>, by: string) {
  const { book, title } = await propertySheet(site, by);
  const list = Object.values(series).sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.key.localeCompare(b.key));
  const rows: Row[] = [];
  const urls: Row[] = [];
  for (const x of list) {
    for (const d of Object.keys(x.days).sort()) {
      const v = x.days[d];
      rows.push([x.key, x.label, d, v.requests, v.bytes ?? "", v.ms ?? ""]);
    }
    for (const u of x.urls || []) urls.push([x.key, u.url, u.when]);
  }
  await writeSection(book, title, "crawl", rows);
  await writeSection(book, title, "crawlUrls", urls);
}

export function loadCrawl(site: string, fresh = false): Promise<CrawlStore> {
  return memo(`crawl:${site}`, fresh, async () => {
    const {
      parts: [rows, urlRows],
      log,
    } = await readProperty(site, ["crawl", "crawlUrls"], fresh);
    const series: Record<string, CrawlSeries> = {};
    const get = (key: string, label: string) =>
      (series[key] ||= { key, kind: kindOfKey(key), label: label || CRAWL_LABEL[kindOfKey(key)], days: {}, urls: [] });
    for (const r of rows) {
      const key = s(r[0]), d = s(r[2]);
      if (!key || !DATE.test(d)) continue;
      const day: CrawlDay = { requests: n(r[3]) };
      const b = opt(r[4]), m = opt(r[5]);
      if (b != null) day.bytes = b;
      if (m != null) day.ms = m;
      get(key, s(r[1])).days[d] = day;
    }
    for (const r of urlRows) {
      const key = s(r[0]), url = s(r[1]);
      if (key && /^https?:\/\//i.test(url)) get(key, "").urls.push({ url, when: s(r[2]) });
    }
    const imports = mine(log, site, REPORT.crawl)
      .slice(-200)
      .map((r) => ({
        file: s(r[4]),
        at: s(r[0]),
        series: s(r[8]),
        label: series[s(r[8])]?.label || s(r[8]),
        from: s(r[5]),
        to: s(r[6]),
        days: n(r[7]),
        ...(s(r[3]) ? { by: s(r[3]) } : {}),
      })) as CrawlImport[];
    return { series, imports };
  });
}

export type CrawlIncoming = { kind?: unknown; label?: unknown; days?: unknown; urls?: unknown; source?: unknown };

/** Merges up to 10 series by date (newer numbers win) and saves them. */
export async function saveCrawl(site: string, incoming: CrawlIncoming[], by: string, source: string) {
  const store = await loadCrawl(site, true);
  const series: Record<string, CrawlSeries> = { ...store.series };
  const at = now();
  const log: Row[] = [];
  const imports: CrawlImport[] = [];
  for (const raw of incoming.slice(0, 10)) {
    const o = (raw || {}) as Record<string, any>;
    const kind: SeriesKind = KINDS.includes(o.kind) ? o.kind : "other";
    const label = kind === "other" ? String(o.label || "Other").slice(0, 60) : CRAWL_LABEL[kind];
    const key = kind === "other" ? `other:${label.toLowerCase()}` : kind;
    const days: Record<string, CrawlDay> = {};
    for (const [d, v] of Object.entries<any>(o.days && typeof o.days === "object" ? o.days : {}).slice(0, 2000)) {
      if (!DATE.test(d)) continue;
      const r = Number(v?.requests);
      if (!Number.isFinite(r) || r < 0) continue;
      const b = Number(v?.bytes), m = Number(v?.ms);
      days[d] = { requests: r, ...(Number.isFinite(b) && b >= 0 ? { bytes: b } : {}), ...(Number.isFinite(m) && m >= 0 ? { ms: m } : {}) };
    }
    const dates = Object.keys(days).sort();
    if (!dates.length) continue;
    const urls: CrawlUrl[] = Array.isArray(o.urls)
      ? o.urls
          .filter((u: any) => typeof u?.url === "string" && /^https?:\/\//i.test(u.url))
          .slice(0, 1000)
          .map((u: any) => ({ url: String(u.url).slice(0, 2000), when: String(u.when || "").slice(0, 40) }))
      : [];
    const prev = series[key];
    const merged = { ...(prev?.days || {}), ...days };
    const keep = Object.keys(merged).sort().slice(-MAX_DAYS);
    series[key] = { key, kind, label, days: Object.fromEntries(keep.map((d) => [d, merged[d]])), urls: urls.length ? urls : prev?.urls || [] };
    const file = String(o.source || source).slice(0, 200);
    log.push([at, site, REPORT.crawl, by, file, dates[0], dates[dates.length - 1], dates.length, key]);
    imports.push({ file, at, series: key, label, from: dates[0], to: dates[dates.length - 1], days: dates.length });
  }
  if (!imports.length) return { store, saved: 0 };
  await writeCrawl(site, series, by);
  await logUpdates(log);
  forget(`crawl:${site}`);
  await overview(site);
  return { store: { series, imports: [...store.imports, ...imports].slice(-200) } as CrawlStore, saved: imports.length };
}

export async function restoreCrawl(site: string, old: CrawlStore) {
  await writeCrawl(site, old.series || {}, FROM_UPSTASH);
  await logUpdates((old.imports || []).map((i) => [i.at, site, REPORT.crawl, "", FROM_UPSTASH, i.from, i.to, i.days, i.series]));
  forget(`crawl:${site}`);
  await overview(site);
}

export async function clearCrawl(site: string, by: string) {
  const { book, title } = await propertySheet(site, by);
  await writeSection(book, title, "crawl", []);
  await writeSection(book, title, "crawlUrls", []);
  await logUpdates([[now(), site, REPORT.crawl, by, DELETED, "", "", 0, ""]]);
  forget(`crawl:${site}`);
  await overview(site);
}

/* ---------- AI impressions (Generative AI report) ---------- */

async function writeAi(site: string, store: AiStore, by: string) {
  const { book, title } = await propertySheet(site, by);
  const days: Row[] = Object.keys(store.days).sort().map((d) => [d, store.days[d]]);
  const split: Row[] = [];
  for (const x of store.snapshots) {
    const head: Row = [x.from, x.to, x.importedAt, x.by || "", x.file];
    for (const [k, v] of Object.entries(x.pages)) split.push([...head, "Page", k, v]);
    for (const [k, v] of Object.entries(x.countries)) split.push([...head, "Country", k, v]);
    for (const [k, v] of Object.entries(x.devices)) split.push([...head, "Device", k, v]);
  }
  await writeSection(book, title, "ai", days);
  await writeSection(book, title, "aiSplit", split);
}

export function loadAi(site: string, fresh = false): Promise<AiStore> {
  return memo(`ai:${site}`, fresh, async () => {
    const {
      parts: [rows, split],
      log,
    } = await readProperty(site, ["ai", "aiSplit"], fresh);
    const store = emptyAiStore();
    for (const r of rows) {
      const d = s(r[0]);
      if (DATE.test(d)) store.days[d] = n(r[1]);
    }
    const snaps = new Map<string, AiSnapshot>();
    for (const r of split) {
      const from = s(r[0]), to = s(r[1]), at = s(r[2]), name = s(r[6]);
      if (!DATE.test(from) || !DATE.test(to) || !name) continue;
      const k = `${from}|${to}|${at}`;
      let snap = snaps.get(k);
      if (!snap) {
        snap = { file: s(r[4]), from, to, importedAt: at, ...(s(r[3]) ? { by: s(r[3]) } : {}), pages: {}, countries: {}, devices: {} };
        snaps.set(k, snap);
      }
      const type = s(r[5]).toLowerCase(), v = n(r[7]);
      if (type === "page") snap.pages[name] = v;
      else if (type === "country") snap.countries[name] = v;
      else if (type === "device") snap.devices[name] = v;
    }
    store.snapshots = [...snaps.values()].sort((a, b) => a.to.localeCompare(b.to) || b.from.localeCompare(a.from));
    store.imports = mine(log, site, REPORT.ai)
      .slice(-100)
      .map(
        (r): AiImport => ({
          file: s(r[4]),
          at: s(r[0]),
          ...(s(r[3]) ? { by: s(r[3]) } : {}),
          from: s(r[5]),
          to: s(r[6]),
          days: n(r[7]),
          pages: n(r[8]),
        })
      );
    return store;
  });
}

export async function saveAi(site: string, items: AiParsed[], by: string): Promise<AiStore> {
  let store = await loadAi(site, true);
  for (const p of items) store = mergeAi(store, p, by);
  await writeAi(site, store, by);
  await logUpdates(items.map((p) => [now(), site, REPORT.ai, by, p.file, p.from, p.to, Object.keys(p.days).length, Object.keys(p.pages).length]));
  forget(`ai:${site}`);
  await overview(site);
  return store;
}

export async function restoreAi(site: string, old: AiStore) {
  await writeAi(site, { days: old.days || {}, snapshots: old.snapshots || [], imports: [] }, FROM_UPSTASH);
  await logUpdates((old.imports || []).map((i) => [i.at, site, REPORT.ai, i.by || "", FROM_UPSTASH, i.from, i.to, i.days, i.pages]));
  forget(`ai:${site}`);
  await overview(site);
}

export async function clearAi(site: string, by: string) {
  const { book, title } = await propertySheet(site, by);
  await writeSection(book, title, "ai", []);
  await writeSection(book, title, "aiSplit", []);
  await logUpdates([[now(), site, REPORT.ai, by, DELETED, "", "", 0, 0]]);
  forget(`ai:${site}`);
  await overview(site);
}
