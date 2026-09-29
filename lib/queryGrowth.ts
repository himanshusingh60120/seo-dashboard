// lib/queryGrowth.ts
/**
 * Consolidated query growth report: every query compared across two periods.
 * Pure functions with no server or browser dependencies, so the same code builds the report
 * from live Search Console data (API route) and from an imported Search Console export (browser).
 */
import type { Source } from "./provenance";

export type Range = { startDate: string; endDate: string };
/** One query's numbers for one period. Position is null when the export left it out. */
export type Period = { clicks: number; impressions: number; position: number | null };
export type QueryPair = { query: string; cur: Period | null; prev: Period | null };
export type Totals = { clicks: number; impressions: number; ctr: number; position: number | null };

export type GrowthInput = {
  origin: "live" | "import";
  /** Search Console property, or the imported file's name. */
  subject: string;
  currentLabel: string;
  previousLabel: string;
  currentRange?: Range;
  previousRange?: Range;
  /** Totals for the whole site, including queries Google doesn't list. Falls back to sums of the listed queries. */
  siteTotals?: { current: Totals; previous: Totals };
  brand: string;
  pairs: QueryPair[];
  /** Plain-language note on which queries the data covers. */
  coverage: string;
  warnings?: string[];
  minImpr?: number;
};

/** Compact row: [query, clicks, impressions, position, prevClicks, prevImpressions, prevPosition]. Keeps large reports small. */
export type Tuple = [string, number, number, number | null, number, number, number | null];

export type Status = "new" | "lost" | "growing" | "declining" | "steady";

export type GrowthRow = {
  query: string;
  status: Status;
  clicks: number;
  prevClicks: number;
  clickChange: number;
  clickPct: number | null;
  impressions: number;
  prevImpressions: number;
  impressionChange: number;
  ctr: number | null;
  prevCtr: number | null;
  position: number | null;
  prevPosition: number | null;
  /** Position now minus position before: negative is an improvement. */
  positionChange: number | null;
};

/** How the total moved from one period to the next. start + fromNew + growing − declining − lost + unlisted = end. */
export type Bridge = { start: number; fromNew: number; growing: number; declining: number; lost: number; unlisted: number; end: number };

export type SegStats = { queries: number; clicks: number; impressions: number; position: number | null };
export type Segment = { id: string; label: string; cur: SegStats; prev: SegStats };

export type ListId = "gainers" | "losers" | "new" | "lost" | "reachedPageOne" | "droppedPageOne" | "impressionGainers";

export type GrowthReport = {
  version: 1;
  origin: "live" | "import";
  subject: string;
  currentLabel: string;
  previousLabel: string;
  currentRange?: Range;
  previousRange?: Range;
  brand: string;
  coverage: string;
  warnings: string[];
  minImpr: number;
  generatedAt: string;
  totals: { current: Totals; previous: Totals; from: "site" | "queries" };
  counts: {
    current: number; previous: number; withClicksCur: number; withClicksPrev: number;
    new: number; lost: number; retained: number; growing: number; declining: number; steady: number;
    reachedPageOne: number; droppedPageOne: number; reachedTop3: number; droppedTop3: number;
  };
  clicksBridge: Bridge;
  impressionsBridge: Bridge;
  hasPositions: boolean;
  bands: { id: string; label: string; cur: number; prev: number }[];
  segments: Segment[];
  narrative: string[];
  lists: Record<ListId, Tuple[]>;
  /** Every query, most clicks (either period) first. Capped at tableLimit; rowCount is the full number. */
  rows: Tuple[];
  rowCount: number;
  truncated: boolean;
};

/* ---------- Helpers ---------- */

export const QUESTION = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will)\b/i;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const present = (c: number, i: number, p: number | null) => i > 0 || c > 0 || p != null;
const words = (q: string) => q.trim().split(/\s+/).length;

export const normalizeBrand = (b: string) => b.trim().toLowerCase().replace(/\s+/g, "");
/** "Previous 6 months" → "previous 6 months", for use mid-sentence. Leaves dates and names alone. */
export const lc = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function toTuple(p: QueryPair): Tuple {
  const c = p.cur, v = p.prev;
  const pos = (x: number | null | undefined) => (x == null || !isFinite(x) || x <= 0 ? null : round(x, 2));
  return [p.query, c?.clicks || 0, c?.impressions || 0, pos(c?.position), v?.clicks || 0, v?.impressions || 0, pos(v?.position)];
}

export function expand(t: Tuple): GrowthRow {
  const [query, c, i, p, pc, pi, pp] = t;
  const now = present(c, i, p), before = present(pc, pi, pp);
  const status: Status =
    now && !before ? "new"
    : before && !now ? "lost"
    : c !== pc ? (c > pc ? "growing" : "declining")
    : i !== pi ? (i > pi ? "growing" : "declining")
    : "steady";
  return {
    query, status,
    clicks: c, prevClicks: pc, clickChange: c - pc, clickPct: pc ? (c - pc) / pc : null,
    impressions: i, prevImpressions: pi, impressionChange: i - pi,
    ctr: i ? c / i : null, prevCtr: pi ? pc / pi : null,
    position: p, prevPosition: pp, positionChange: p != null && pp != null ? round(p - pp) : null,
  };
}

export const STATUS_LABEL: Record<Status, string> = { new: "New", lost: "Lost", growing: "Growing", declining: "Declining", steady: "Steady" };

const BANDS = [
  { id: "top3", label: "1–3", max: 3 },
  { id: "top10", label: "4–10", max: 10 },
  { id: "top20", label: "11–20", max: 20 },
  { id: "top30", label: "21–30", max: 30 },
  { id: "beyond", label: "Beyond 30", max: Infinity },
];

type Acc = { queries: number; clicks: number; impressions: number; posW: number; posI: number };
const acc = (): Acc => ({ queries: 0, clicks: 0, impressions: 0, posW: 0, posI: 0 });
function add(a: Acc, c: number, i: number, p: number | null) {
  a.queries++;
  a.clicks += c;
  a.impressions += i;
  if (p != null && i > 0) { a.posW += p * i; a.posI += i; }
}
const stats = (a: Acc): SegStats => ({ queries: a.queries, clicks: a.clicks, impressions: a.impressions, position: a.posI ? a.posW / a.posI : null });

/* ---------- Plain-language formatting for the summary ---------- */

const n = (x: number) => Math.round(x).toLocaleString();
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${n(Math.abs(x))}`;
const pctOf = (a: number, b: number) => (b ? ((a - b) / b) * 100 : null);

function moved(cur: number, prev: number) {
  const p = pctOf(cur, prev);
  if (cur === prev) return `stayed at ${n(cur)}`;
  if (p == null) return `went from 0 to ${n(cur)}`;
  return `${cur > prev ? "grew" : "fell"} ${Math.abs(p).toFixed(1)}% (${n(prev)} → ${n(cur)})`;
}

/* ---------- The report ---------- */

export function buildGrowthReport(input: GrowthInput, opts: { tableLimit?: number; listLimit?: number } = {}): GrowthReport {
  const tableLimit = opts.tableLimit ?? 20000;
  const listLimit = opts.listLimit ?? 200;
  const minImpr = input.minImpr ?? 20;
  const brand = normalizeBrand(input.brand);
  const useBrand = brand.length >= 2;
  const isBranded = (q: string) => useBrand && q.toLowerCase().replace(/\s+/g, "").includes(brand);

  const tuples = input.pairs.filter((p) => p.query && (p.cur || p.prev)).map(toTuple);
  const rows = tuples.map(expand);

  const segDefs: { id: string; label: string; test: (q: string) => boolean }[] = [
    { id: "all", label: "All listed queries", test: () => true },
    ...(useBrand
      ? [
          { id: "nonbranded", label: "Non-branded", test: (q: string) => !isBranded(q) },
          { id: "branded", label: `Branded (contains “${brand}”)`, test: isBranded },
        ]
      : []),
    { id: "questions", label: "Questions (how, what, why…)", test: (q: string) => QUESTION.test(q.trim()) },
    { id: "short", label: "1–2 words", test: (q: string) => words(q) <= 2 },
    { id: "medium", label: "3–4 words", test: (q: string) => words(q) >= 3 && words(q) <= 4 },
    { id: "long", label: "5+ words (long tail)", test: (q: string) => words(q) >= 5 },
  ];
  const seg = segDefs.map(() => ({ cur: acc(), prev: acc() }));
  const bandCur = BANDS.map(() => 0), bandPrev = BANDS.map(() => 0);
  const band = (p: number) => BANDS.findIndex((b) => p <= b.max);

  const counts = {
    current: 0, previous: 0, withClicksCur: 0, withClicksPrev: 0, new: 0, lost: 0, retained: 0,
    growing: 0, declining: 0, steady: 0, reachedPageOne: 0, droppedPageOne: 0, reachedTop3: 0, droppedTop3: 0,
  };
  const br = { clicks: { fromNew: 0, growing: 0, declining: 0, lost: 0 }, impressions: { fromNew: 0, growing: 0, declining: 0, lost: 0 } };
  let hasPositions = false;

  rows.forEach((r) => {
    const now = r.status !== "lost", before = r.status !== "new";
    if (now) { counts.current++; if (r.clicks > 0) counts.withClicksCur++; }
    if (before) { counts.previous++; if (r.prevClicks > 0) counts.withClicksPrev++; }
    counts[r.status]++;
    if (now && before) counts.retained++;

    for (const k of ["clicks", "impressions"] as const) {
      const cur = k === "clicks" ? r.clicks : r.impressions;
      const prev = k === "clicks" ? r.prevClicks : r.prevImpressions;
      if (r.status === "new") br[k].fromNew += cur;
      else if (r.status === "lost") br[k].lost += prev;
      else if (cur > prev) br[k].growing += cur - prev;
      else br[k].declining += prev - cur;
    }

    if (r.position != null) { hasPositions = true; bandCur[band(r.position)]++; }
    if (r.prevPosition != null) { hasPositions = true; bandPrev[band(r.prevPosition)]++; }
    if (r.position != null && r.prevPosition != null) {
      if (r.prevPosition > 10 && r.position <= 10 && r.impressions >= minImpr) counts.reachedPageOne++;
      if (r.prevPosition <= 10 && r.position > 10 && r.prevImpressions >= minImpr) counts.droppedPageOne++;
      if (r.prevPosition > 3 && r.position <= 3 && r.impressions >= minImpr) counts.reachedTop3++;
      if (r.prevPosition <= 3 && r.position > 3 && r.prevImpressions >= minImpr) counts.droppedTop3++;
    }

    segDefs.forEach((d, i) => {
      if (!d.test(r.query)) return;
      if (now) add(seg[i].cur, r.clicks, r.impressions, r.position);
      if (before) add(seg[i].prev, r.prevClicks, r.prevImpressions, r.prevPosition);
    });
  });

  /* Totals: site-wide when available, else the listed queries */
  const all = seg[0];
  const fromQueries = (a: Acc): Totals => ({ clicks: a.clicks, impressions: a.impressions, ctr: a.impressions ? a.clicks / a.impressions : 0, position: stats(a).position });
  const totals = input.siteTotals
    ? { ...input.siteTotals, from: "site" as const }
    : { current: fromQueries(all.cur), previous: fromQueries(all.prev), from: "queries" as const };

  const bridge = (k: "clicks" | "impressions"): Bridge => {
    const start = totals.previous[k], end = totals.current[k], b = br[k];
    return { start, ...b, unlisted: end - start - (b.fromNew + b.growing - b.declining - b.lost), end };
  };
  const clicksBridge = bridge("clicks"), impressionsBridge = bridge("impressions");

  /* Lists */
  const idx = rows.map((_, i) => i);
  const pick = (filter: (r: GrowthRow) => boolean, sort: (a: GrowthRow, b: GrowthRow) => number) =>
    idx.filter((i) => filter(rows[i])).sort((a, b) => sort(rows[a], rows[b])).slice(0, listLimit).map((i) => tuples[i]);
  const lists: Record<ListId, Tuple[]> = {
    gainers: pick((r) => r.clickChange > 0, (a, b) => b.clickChange - a.clickChange || b.impressionChange - a.impressionChange),
    losers: pick((r) => r.clickChange < 0, (a, b) => a.clickChange - b.clickChange || a.impressionChange - b.impressionChange),
    impressionGainers: pick((r) => r.impressionChange > 0, (a, b) => b.impressionChange - a.impressionChange),
    new: pick((r) => r.status === "new", (a, b) => b.clicks - a.clicks || b.impressions - a.impressions),
    lost: pick((r) => r.status === "lost", (a, b) => b.prevClicks - a.prevClicks || b.prevImpressions - a.prevImpressions),
    reachedPageOne: pick(
      (r) => r.position != null && r.prevPosition != null && r.prevPosition > 10 && r.position <= 10 && r.impressions >= minImpr,
      (a, b) => b.impressions - a.impressions
    ),
    droppedPageOne: pick(
      (r) => r.position != null && r.prevPosition != null && r.prevPosition <= 10 && r.position > 10 && r.prevImpressions >= minImpr,
      (a, b) => b.prevImpressions - a.prevImpressions
    ),
  };

  const tableIdx = [...idx].sort(
    (a, b) =>
      Math.max(rows[b].clicks, rows[b].prevClicks) - Math.max(rows[a].clicks, rows[a].prevClicks) ||
      Math.max(rows[b].impressions, rows[b].prevImpressions) - Math.max(rows[a].impressions, rows[a].prevImpressions)
  );
  const table = tableIdx.slice(0, tableLimit).map((i) => tuples[i]);

  const segments: Segment[] = segDefs.map((d, i) => ({ id: d.id, label: d.label, cur: stats(seg[i].cur), prev: stats(seg[i].prev) }));
  const bands = BANDS.map((b, i) => ({ id: b.id, label: b.label, cur: bandCur[i], prev: bandPrev[i] }));

  /* Summary */
  const tc = totals.current, tp = totals.previous;
  const cb = clicksBridge;
  const narrative: string[] = [];
  narrative.push(
    `Comparing ${lc(input.currentLabel)} with ${lc(input.previousLabel)}: clicks ${moved(tc.clicks, tp.clicks)} and impressions ${moved(tc.impressions, tp.impressions)}. ` +
      `CTR moved from ${(tp.ctr * 100).toFixed(2)}% to ${(tc.ctr * 100).toFixed(2)}%` +
      (tc.position != null && tp.position != null ? ` and average position from ${tp.position.toFixed(1)} to ${tc.position.toFixed(1)}.` : ".")
  );
  narrative.push(
    `The site appeared for ${n(counts.current)} queries versus ${n(counts.previous)} before (${signed(counts.current - counts.previous)}). ` +
      `${n(counts.new)} are new, ${n(counts.lost)} no longer appear and ${n(counts.retained)} showed up in both periods; ` +
      `of those, ${n(counts.growing)} are growing and ${n(counts.declining)} declining.`
  );
  narrative.push(
    `Of the ${signed(cb.end - cb.start)} change in clicks, new queries brought ${signed(cb.fromNew)}, growing queries ${signed(cb.growing)}, ` +
      `declining queries ${signed(-cb.declining)} and queries that disappeared ${signed(-cb.lost)}` +
      (Math.round(cb.unlisted) !== 0 ? `; the remaining ${signed(cb.unlisted)} sits in queries Search Console doesn't list individually.` : ".")
  );
  const gains = cb.fromNew + cb.growing;
  if (gains > 0 && lists.gainers.length) {
    const top = lists.gainers.slice(0, 10).reduce((s, t) => s + (t[1] - t[4]), 0);
    narrative.push(`The 10 biggest gainers account for ${((top / gains) * 100).toFixed(0)}% of all click gains, so growth is ${top / gains > 0.6 ? "concentrated in a few queries" : "spread across many queries"}.`);
  }
  if (hasPositions) {
    const p1 = (b: number[]) => b[0] + b[1];
    narrative.push(
      `${n(p1(bandCur))} queries rank on page one now versus ${n(p1(bandPrev))} before (${n(bandCur[0])} vs ${n(bandPrev[0])} in the top 3). ` +
        `${n(counts.reachedPageOne)} queries with ${minImpr}+ impressions moved up onto page one and ${n(counts.droppedPageOne)} fell off it.`
    );
  }
  const segBy = (id: string) => segments.find((s) => s.id === id);
  const nb = segBy("nonbranded"), b = segBy("branded");
  if (nb && b) {
    narrative.push(
      b.cur.queries || b.prev.queries
        ? `Non-branded clicks ${moved(nb.cur.clicks, nb.prev.clicks)}; branded clicks (queries containing “${brand}”) ${moved(b.cur.clicks, b.prev.clicks)}.`
        : `No listed query contains “${brand}”, so all listed clicks are non-branded.`
    );
  }
  const lt = segBy("long"), qs = segBy("questions");
  if (lt && qs) {
    narrative.push(
      `Long-tail queries (5+ words) went from ${n(lt.prev.queries)} to ${n(lt.cur.queries)} and their clicks ${moved(lt.cur.clicks, lt.prev.clicks)}; ` +
        `question queries went from ${n(qs.prev.queries)} to ${n(qs.cur.queries)}.`
    );
  }
  const g = lists.gainers[0] ? expand(lists.gainers[0]) : null;
  const l = lists.losers[0] ? expand(lists.losers[0]) : null;
  if (g || l) {
    const posTxt = (r: GrowthRow) => (r.prevPosition != null && r.position != null ? `, position ${r.prevPosition.toFixed(1)} → ${r.position.toFixed(1)}` : r.status === "new" ? ", new this period" : r.status === "lost" ? ", no longer showing" : "");
    narrative.push(
      [g && `The biggest gain was “${g.query}” (${signed(g.clickChange)} clicks${posTxt(g)})`, l && `the biggest drop was “${l.query}” (${signed(l.clickChange)} clicks${posTxt(l)})`]
        .filter(Boolean)
        .join("; ") + "."
    );
  }

  return {
    version: 1,
    origin: input.origin,
    subject: input.subject,
    currentLabel: input.currentLabel,
    previousLabel: input.previousLabel,
    currentRange: input.currentRange,
    previousRange: input.previousRange,
    brand,
    coverage: input.coverage,
    warnings: input.warnings || [],
    minImpr,
    generatedAt: new Date().toISOString(),
    totals,
    counts,
    clicksBridge,
    impressionsBridge,
    hasPositions,
    bands,
    segments,
    narrative,
    lists,
    rows: table,
    rowCount: tuples.length,
    truncated: tuples.length > table.length,
  };
}

/* ---------- Provenance for the calculated parts ---------- */

/** Describes every calculated figure in the report, pointing back to the data it came from. */
export function growthCalcSources(from: string[], minImpr: number, brand: string): Source[] {
  const at = new Date().toISOString();
  const c = (id: string, label: string, formula: string): Source => ({ id, label, system: "Calculated by this dashboard", fetchedAt: at, formula, derivedFrom: from });
  return [
    c("growth.calc.status", "Query status", "Each query is matched by its exact text across the two periods. New = shown now but not before. Lost = shown before but not now. Growing / declining = more / fewer clicks than before; when clicks are equal, impressions decide. Steady = identical clicks and impressions."),
    c("growth.calc.bridge", "Where the change came from", "Previous total + clicks of new queries + increases of growing queries − decreases of declining queries − previous clicks of lost queries + the change in queries Google doesn't list individually (site total minus the sum of listed queries) = this period's total. Impressions are split the same way."),
    c("growth.calc.bands", "Queries by position, before and now", `Each query is placed by its average position in each period: 1–3, 4–10, 11–20, 21–30 or beyond 30. “Moved onto page one” = position above 10 before and 10 or better now, with at least ${minImpr} impressions now. “Fell off page one” = 10 or better before and worse than 10 now, with at least ${minImpr} impressions before.`),
    c("growth.calc.segments", "Growth by segment", `Queries grouped by type.${brand ? ` Branded = query contains “${brand}” once spaces are removed.` : ""} Questions start with how, what, why, when, where, who, which, can, does, do, is, are, should or will. Length is the word count. Average position is weighted by impressions.`),
    c("growth.calc.lists", "Query lists", `Biggest gainers / losers are sorted by the change in clicks. New queries by clicks now, lost queries by clicks before. Page-one movers use the ${minImpr}-impression threshold above.`),
    c("growth.calc.narrative", "Summary", "Sentences written from the totals, counts, splits and lists above; every number in them comes from those figures."),
  ];
}
