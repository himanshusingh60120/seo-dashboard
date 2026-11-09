// lib/crawlStats.ts
"use client";
/**
 * Search Console's Crawl stats report has no API and keeps only 90 days. This reads its exports
 * (Crawl stats → By purpose → Refresh / Discovery → Export → Download CSV) and keeps them in this
 * browser, merged by date, so history builds up beyond 90 days when you import regularly.
 */
import { parseCsv, readPicked } from "./gscImport";
import { kvDel, kvGet, kvSet } from "./idb";

export type CrawlDay = { requests: number; bytes?: number; ms?: number };
export type CrawlUrl = { url: string; when: string };
export type SeriesKind = "total" | "refresh" | "discovery" | "other";
export type CrawlSeries = { key: string; kind: SeriesKind; label: string; days: Record<string, CrawlDay>; urls: CrawlUrl[] };
export type CrawlImport = { file: string; at: string; series: string; label: string; from: string; to: string; days: number };
export type CrawlStore = { series: Record<string, CrawlSeries>; imports: CrawlImport[] };
export type ParsedCrawl = {
  file: string; kind: SeriesKind; label: string; days: Record<string, CrawlDay>; urls: CrawlUrl[];
  from: string; to: string; total: number; note: string;
};

export const KIND_LABEL: Record<SeriesKind, string> = {
  total: "All crawl requests",
  refresh: "Refresh",
  discovery: "Discovery",
  other: "Other breakdown",
};

export const HOW_TO_EXPORT =
  "In Search Console open Settings → Crawl stats → Open report. Under “By purpose” click Refresh, then Export (top right) → Download CSV. " +
  "Go back and do the same for Discovery. Import both files here (ZIP or CSV, several at once is fine).";

export const crawlStatsUrl = (site: string) =>
  `https://search.google.com/search-console/settings/crawl-stats?resource_id=${encodeURIComponent(site)}`;

const storeKey = (site: string) => `dash:crawl:${site}`;
const empty = (): CrawlStore => ({ series: {}, imports: [] });

/* ---------- Dates and numbers ---------- */

const pad = (n: number) => String(n).padStart(2, "0");
const SLASH = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/;

const looksDate = (c: string) =>
  /^\d{4}-\d{1,2}-\d{1,2}/.test(c) || SLASH.test(c) || (/[a-z]{3}/i.test(c) && /\d{4}/.test(c) && !isNaN(Date.parse(c)));

/** Day-first or month-first, decided from the whole column (Search Console follows the account's locale). */
function dateOrder(cells: string[]): "dmy" | "mdy" {
  for (const c of cells) {
    const m = c.trim().match(SLASH);
    if (!m) continue;
    if (+m[1] > 12) return "dmy";
    if (+m[2] > 12) return "mdy";
  }
  return "dmy";
}

export function toIsoDate(raw: string, order: "dmy" | "mdy" = "dmy"): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(SLASH);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const d = order === "dmy" ? +m[1] : +m[2];
    const mo = order === "dmy" ? +m[2] : +m[1];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return null;
}

function numOf(s: string | undefined) {
  const t = (s ?? "").trim().toLowerCase().replace(/[,\s]/g, "");
  if (!t || t === "-" || t === "—") return NaN;
  const m = t.match(/^(-?\d+(?:\.\d+)?)(k|m|bn|b)?$/);
  if (!m) return NaN;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "bn" || m[2] === "b" ? 1e9 : 1;
  return Number(m[1]) * mult;
}

/* ---------- Reading an export ---------- */

function dateCol(rows: string[][]) {
  const header = rows[0].map((h) => h.trim());
  const sample = rows.slice(1, 40);
  for (let i = 0; i < header.length; i++) {
    const cells = sample.map((r) => (r[i] || "").trim()).filter(Boolean);
    if (!cells.length) continue;
    const share = cells.filter(looksDate).length / cells.length;
    if (share >= 0.8 || (/date|day/i.test(header[i]) && share >= 0.5)) return i;
  }
  return -1;
}

function urlCol(rows: string[][]) {
  const header = rows[0].map((h) => h.trim());
  const sample = rows.slice(1, 20);
  for (let i = 0; i < header.length; i++) {
    const cells = sample.map((r) => (r[i] || "").trim()).filter(Boolean);
    if (cells.length && cells.filter((c) => /^https?:\/\//i.test(c)).length / cells.length >= 0.8) return i;
  }
  return -1;
}

function readChart(rows: string[][], dc: number): Record<string, CrawlDay> {
  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1);
  const order = dateOrder(body.map((r) => r[dc] || ""));
  const find = (re: RegExp) => header.findIndex((h, i) => i !== dc && re.test(h));
  let rq = find(/request/i);
  if (rq < 0) rq = header.findIndex((_, i) => i !== dc && body.slice(0, 20).every((r) => isFinite(numOf(r[i]))));
  const by = find(/download|size|byte/i);
  const ms = find(/response|\bms\b/i);
  const out: Record<string, CrawlDay> = {};
  if (rq < 0) return out;
  for (const r of body) {
    const d = toIsoDate(r[dc] || "", order);
    const n = numOf(r[rq]);
    if (!d || !isFinite(n)) continue;
    const b = by >= 0 ? numOf(r[by]) : NaN;
    const t = ms >= 0 ? numOf(r[ms]) : NaN;
    out[d] = { requests: n, ...(isFinite(b) ? { bytes: b } : {}), ...(isFinite(t) ? { ms: t } : {}) };
  }
  return out;
}

function readUrls(rows: string[][], uc: number): CrawlUrl[] {
  const header = rows[0].map((h) => h.trim());
  const wc = header.findIndex((h, i) => i !== uc && /crawl|date|time|last/i.test(h));
  return rows
    .slice(1)
    .filter((r) => /^https?:\/\//i.test((r[uc] || "").trim()))
    .slice(0, 1000)
    .map((r) => ({ url: r[uc].trim(), when: wc >= 0 ? (r[wc] || "").trim() : "" }));
}

const OTHER_RE =
  /(OK \(200\)|Not found \(404\)|Moved permanently \(301\)|Moved temporarily \(302\)|Not modified \(304\)|Server error \(5xx\)|Smartphone|Desktop|Page resource load|AdsBot|StoreBot|JavaScript|Syndication)/i;

function guessKind(text: string): { kind: SeriesKind; label: string } {
  if (/refresh/i.test(text)) return { kind: "refresh", label: KIND_LABEL.refresh };
  if (/discover/i.test(text)) return { kind: "discovery", label: KIND_LABEL.discovery };
  const m = text.match(OTHER_RE);
  if (m) return { kind: "other", label: m[1] };
  return { kind: "total", label: KIND_LABEL.total };
}

/** Reads picked ZIP/CSV files. Each ZIP (or the set of loose CSVs) becomes one parsed export. */
export async function parseCrawlFiles(files: File[]): Promise<{ parsed: ParsedCrawl[]; skipped: string[] }> {
  const { groups, skipped } = await readPicked(files);
  const parsed: ParsedCrawl[] = [];
  for (const g of groups) {
    const tables = g.csv.map((f) => ({ f, rows: parseCsv(f.text) })).filter((t) => t.rows.length > 1);
    let days: Record<string, CrawlDay> = {};
    let urls: CrawlUrl[] = [];
    const meta: string[] = [];
    for (const t of tables) {
      const dc = dateCol(t.rows);
      const uc = urlCol(t.rows);
      if (dc >= 0 && !Object.keys(days).length) days = readChart(t.rows, dc);
      else if (uc >= 0 && !urls.length) urls = readUrls(t.rows, uc);
      else meta.push(t.f.name, ...t.rows.flat());
    }
    const byName = guessKind(`${g.label} ${g.csv.map((f) => f.name).join(" ")}`);
    const guess = byName.kind !== "total" ? byName : guessKind(meta.join(" "));
    const dates = Object.keys(days).sort();
    parsed.push({
      file: g.label,
      ...guess,
      days,
      urls,
      from: dates[0] || "",
      to: dates[dates.length - 1] || "",
      total: dates.reduce((s, d) => s + days[d].requests, 0),
      note: dates.length ? "" : "No daily crawl chart was found in this file.",
    });
  }
  return { parsed, skipped };
}

/* ---------- Saved data ---------- */

export async function loadCrawl(site: string): Promise<CrawlStore> {
  try {
    return (await kvGet<CrawlStore>(storeKey(site))) || empty();
  } catch {
    return empty();
  }
}

export const saveCrawl = (site: string, s: CrawlStore) => kvSet(storeKey(site), s);
export const clearCrawl = (site: string) => kvDel(storeKey(site));

/** Merges one parsed export into the saved data. Newer files overwrite the same dates. */
export function applyImport(store: CrawlStore, p: ParsedCrawl, kind: SeriesKind, label: string): CrawlStore {
  const key = kind === "other" ? `other:${label.toLowerCase()}` : kind;
  const prev = store.series[key];
  const series: CrawlSeries = {
    key,
    kind,
    label: kind === "other" ? label : KIND_LABEL[kind],
    days: { ...(prev?.days || {}), ...p.days },
    urls: p.urls.length ? p.urls : prev?.urls || [],
  };
  const entry: CrawlImport = {
    file: p.file, at: new Date().toISOString(), series: key, label: series.label,
    from: p.from, to: p.to, days: Object.keys(p.days).length,
  };
  return { series: { ...store.series, [key]: series }, imports: [...store.imports, entry].slice(-200) };
}

export type DayRow = {
  date: string;
  total: number | null;
  refresh: number | null;
  discovery: number | null;
  bytes: number | null;
  ms: number | null;
  /** "reported" = from an All-crawl-requests export; "refresh + discovery" = calculated. */
  totalFrom: string;
};

/** One row per date. The total is the reported one, or Refresh + Discovery when both exist (every crawl is one or the other). */
export function dailyRows(store: CrawlStore): DayRow[] {
  const t = store.series.total, r = store.series.refresh, d = store.series.discovery;
  const dates = new Set<string>([...Object.keys(t?.days || {}), ...Object.keys(r?.days || {}), ...Object.keys(d?.days || {})]);
  return Array.from(dates)
    .sort()
    .map((date) => {
      const td = t?.days[date], rd = r?.days[date], dd = d?.days[date];
      const both = rd && dd;
      const total = td ? td.requests : both ? rd!.requests + dd!.requests : null;
      const bytes = td?.bytes ?? (both && rd!.bytes != null && dd!.bytes != null ? rd!.bytes + dd!.bytes : null);
      const ms =
        td?.ms ??
        (both && rd!.ms != null && dd!.ms != null && rd!.requests + dd!.requests > 0
          ? (rd!.ms * rd!.requests + dd!.ms * dd!.requests) / (rd!.requests + dd!.requests)
          : null);
      return {
        date,
        total,
        refresh: rd ? rd.requests : null,
        discovery: dd ? dd.requests : null,
        bytes,
        ms,
        totalFrom: td ? "reported" : both ? "refresh + discovery" : "",
      };
    });
}
