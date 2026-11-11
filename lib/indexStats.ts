// lib/indexStats.ts
// Shared by the browser and the server. Exact Page indexing numbers from Search Console (Google has no API for that report):
// daily Indexed / Not indexed counts for each view, merged by date, plus the latest "Why pages aren't indexed" table
// for each view and a history of those reason counts, one entry per update.
export const IDX_VIEWS = ["ALL_URLS", "ALL_SUBMITTED_URLS", "ALL_NON_SUBMITTED_URLS"] as const;
export type IdxView = (typeof IDX_VIEWS)[number];
export const IDX_LABEL: Record<IdxView, string> = {
  ALL_URLS: "All known pages",
  ALL_SUBMITTED_URLS: "All submitted pages",
  ALL_NON_SUBMITTED_URLS: "Unsubmitted pages only",
};

export type IdxDay = { indexed: number; notIndexed: number; impressions?: number };
export type IdxReason = { reason: string; source: string; validation: string; pages: number };
export type IdxViewData = {
  days: Record<string, IdxDay>;
  reasons: IdxReason[];
  /** Chart date the reasons table belongs to. */
  reasonsAsOf?: string;
  /** reasonsAsOf → { reason → pages }, one entry per update. */
  reasonsHistory: Record<string, Record<string, number>>;
};
export type IdxImport = { at: string; by?: string; from: string; to: string; views: IdxView[] };
export type IdxStore = { views: Partial<Record<IdxView, IdxViewData>>; imports: IdxImport[] };
export type IdxParsedView = { days: Record<string, IdxDay>; reasons: IdxReason[]; asOf: string };
export type IdxParsed = Partial<Record<IdxView, IdxParsedView>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 1100;
const MAX_HISTORY = 200;
const MAX_REASONS = 60;

export const emptyIdxStore = (): IdxStore => ({ views: {}, imports: [] });

const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** Cleans untrusted input (the API route runs it on every save). Null when nothing usable is left. */
export function sanitizeIdxParsed(v: any): IdxParsed | null {
  if (!v || typeof v !== "object") return null;
  const out: IdxParsed = {};
  for (const view of IDX_VIEWS) {
    const src = v[view];
    if (!src || typeof src !== "object") continue;
    const days: Record<string, IdxDay> = {};
    let n = 0;
    for (const [d, x] of Object.entries((src.days || {}) as Record<string, any>)) {
      if (n >= 500 || !DATE.test(d) || !x || typeof x !== "object") continue;
      const a = int(x.indexed), b = int(x.notIndexed);
      if (a == null || b == null) continue;
      const imp = int(x.impressions);
      days[d] = { indexed: a, notIndexed: b, ...(imp != null ? { impressions: imp } : {}) };
      n++;
    }
    const reasons: IdxReason[] = (Array.isArray(src.reasons) ? src.reasons : [])
      .slice(0, MAX_REASONS)
      .map((r: any) => ({
        reason: String(r?.reason || "").slice(0, 120),
        source: String(r?.source || "").slice(0, 60),
        validation: String(r?.validation || "").slice(0, 60),
        pages: int(r?.pages) ?? -1,
      }))
      .filter((r: IdxReason) => r.reason && r.pages >= 0);
    const dates = Object.keys(days).sort();
    if (!dates.length && !reasons.length) continue;
    const asOf = DATE.test(String(src.asOf)) ? String(src.asOf) : dates[dates.length - 1] || "";
    out[view] = { days, reasons, asOf };
  }
  return Object.keys(out).length ? out : null;
}

/** Adds one update: days merged by date (newer wins); each view's reasons table replaced and added to its history. */
export function mergeIdx(store: IdxStore, p: IdxParsed, by?: string): IdxStore {
  const views = { ...store.views };
  const touched: IdxView[] = [];
  let from = "", to = "";
  for (const view of IDX_VIEWS) {
    const pv = p[view];
    if (!pv) continue;
    touched.push(view);
    const old: IdxViewData = views[view] || { days: {}, reasons: [], reasonsHistory: {} };
    const merged = { ...old.days, ...pv.days };
    const keep = Object.keys(merged).sort().slice(-MAX_DAYS);
    const next: IdxViewData = {
      days: Object.fromEntries(keep.map((d) => [d, merged[d]])),
      reasons: old.reasons,
      reasonsAsOf: old.reasonsAsOf,
      reasonsHistory: { ...old.reasonsHistory },
    };
    if (pv.reasons.length && pv.asOf) {
      next.reasons = pv.reasons;
      next.reasonsAsOf = pv.asOf;
      next.reasonsHistory[pv.asOf] = Object.fromEntries(pv.reasons.map((r) => [r.reason, r.pages]));
      const hk = Object.keys(next.reasonsHistory).sort();
      for (const k of hk.slice(0, Math.max(0, hk.length - MAX_HISTORY))) delete next.reasonsHistory[k];
    }
    views[view] = next;
    const ds = Object.keys(pv.days).sort();
    if (ds.length) {
      if (!from || ds[0] < from) from = ds[0];
      if (!to || ds[ds.length - 1] > to) to = ds[ds.length - 1];
    }
  }
  const entry: IdxImport = { at: new Date().toISOString(), ...(by ? { by } : {}), from, to, views: touched };
  return { views, imports: [...store.imports, entry].slice(-100) };
}

/** The latest saved day of a view. */
export function latestIdxDay(view?: IdxViewData | null): (IdxDay & { date: string }) | null {
  const ds = Object.keys(view?.days || {}).sort();
  const d = ds[ds.length - 1];
  return d ? { date: d, ...view!.days[d] } : null;
}
