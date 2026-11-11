// lib/aiStore.ts
// Shared by the browser and the server. Saved data from Search Console's Generative AI report (AI Overviews + AI Mode):
// daily site-wide AI impressions merged by date, plus page / country / device totals kept per import,
// because the export only gives those for its whole date range.
import { addDays } from "./dates";

export type AiSnapshot = {
  file: string;
  from: string;
  to: string;
  importedAt: string;
  by?: string;
  pages: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
};
export type AiImport = { file: string; at: string; by?: string; from: string; to: string; days: number; pages: number };
export type AiStore = { days: Record<string, number>; snapshots: AiSnapshot[]; imports: AiImport[] };
/** What one parsed export contains. */
export type AiParsed = {
  file: string;
  from: string;
  to: string;
  days: Record<string, number>;
  pages: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
};

/** Kept small enough for one Upstash Redis value. */
export const AI_MAX_SNAPSHOTS = 6;
export const AI_MAX_PAGES = 1000;
export const AI_MAX_DAYS = 1100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const emptyAiStore = (): AiStore => ({ days: {}, snapshots: [], imports: [] });

function counts(v: unknown, keep: (k: string) => boolean, max: number) {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  let n = 0;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (n >= max) break;
    const x = Number(raw);
    if (keep(k) && Number.isFinite(x) && x >= 0) {
      out[k.slice(0, 2000)] = x;
      n++;
    }
  }
  return out;
}

/** Cleans untrusted input (the API route runs it on every save). Null when no daily data is left. */
export function sanitizeAiParsed(v: any): AiParsed | null {
  const days = counts(v?.days, (k) => DATE.test(k), 500);
  const dates = Object.keys(days).sort();
  if (!dates.length) return null;
  return {
    file: String(v?.file || "Generative AI export").slice(0, 200),
    from: dates[0],
    to: dates[dates.length - 1],
    days,
    pages: counts(v?.pages, (k) => /^https?:\/\//i.test(k), AI_MAX_PAGES),
    countries: counts(v?.countries, (k) => k.length > 0 && k.length <= 80, 300),
    devices: counts(v?.devices, (k) => k.length > 0 && k.length <= 40, 10),
  };
}

/** Adds one export. Newer imports replace the same dates; an export with the same date range replaces its older split. */
export function mergeAi(store: AiStore, p: AiParsed, by?: string): AiStore {
  const at = new Date().toISOString();
  const days = { ...store.days, ...p.days };
  const keep = Object.keys(days).sort().slice(-AI_MAX_DAYS);
  const hasSplit = Object.keys(p.pages).length > 0 || Object.keys(p.countries).length > 0 || Object.keys(p.devices).length > 0;
  const snap: AiSnapshot = {
    file: p.file, from: p.from, to: p.to, importedAt: at, ...(by ? { by } : {}),
    pages: p.pages, countries: p.countries, devices: p.devices,
  };
  const snapshots = hasSplit
    ? [...store.snapshots.filter((s) => !(s.from === p.from && s.to === p.to)), snap]
        .sort((a, b) => a.to.localeCompare(b.to) || b.from.localeCompare(a.from))
        .slice(-AI_MAX_SNAPSHOTS)
    : store.snapshots;
  const entry: AiImport = {
    file: p.file, at, ...(by ? { by } : {}), from: p.from, to: p.to,
    days: Object.keys(p.days).length, pages: Object.keys(p.pages).length,
  };
  return {
    days: Object.fromEntries(keep.map((d) => [d, days[d]])),
    snapshots,
    imports: [...store.imports, entry].slice(-100),
  };
}

/** The most recent export's page / country / device split (latest end date; the longer range if two end together). */
export function latestAiSnapshot(store: AiStore | null): AiSnapshot | null {
  if (!store?.snapshots.length) return null;
  return store.snapshots.reduce((best, s) => (s.to > best.to || (s.to === best.to && s.from < best.from) ? s : best));
}

/** AI impressions between two dates (inclusive), and how many of those days have imported data. */
export function aiSum(store: AiStore | null, from: string, to: string) {
  let total = 0, covered = 0, expected = 0;
  for (let d = from; d <= to && expected < 1000; d = addDays(d, 1)) {
    expected++;
    const v = store?.days[d];
    if (v != null) {
      total += v;
      covered++;
    }
  }
  return { total, covered, expected, complete: expected > 0 && covered === expected };
}
