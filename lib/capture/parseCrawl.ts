// lib/capture/parseCrawl.ts
// Reads what the "Copy crawl stats" bookmark or the Chrome extension copied, picks the right numbers
// (Refresh + Discovery must equal All crawl requests) and says whether it checked out.
// No "use client": it runs in the browser (bookmark) and on the server (extension).
import type { CrawlDay, ParsedCrawl, SeriesKind } from "../crawlStats";

const KIND_LABEL: Record<SeriesKind, string> = { total: "All crawl requests", refresh: "Refresh", discovery: "Discovery", other: "Other breakdown" };

type Tiles = { requests?: string; bytes?: string; ms?: string };
type CapturePage = { kind: SeriesKind; label: string; url: string; tiles?: Tiles; series: { path: string; rows: (string | number)[][] }[] };
type Capture = { v: number; src: string; site: string; capturedAt: string; pages: CapturePage[]; missing?: string[] };
type Shown = { value: number; tol: number };
type Col = { map: Map<string, number>; sum: number; n: number };
type Cand = { col: Col; tile: boolean };

export type CaptureResult = { items: ParsedCrawl[]; verified: boolean; summary: string };

/** "166k" → 166,000 ± 500 (half of the last digit shown). */
function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** (m[2]?.length ?? 0) };
}
const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;

const BAD = "That doesn't look like data from the “Copy crawl stats” bookmark. Click the bookmark on the Crawl stats page in Search Console.";

export function parseCapture(text: string, site: string): CaptureResult {
  let cap: Capture;
  try {
    cap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!cap || cap.src !== "gsc-crawl-stats" || !Array.isArray(cap.pages)) throw new Error(BAD);
  if (cap.v !== 2) throw new Error("This came from an older “Copy crawl stats” bookmark. Delete it and drag the new one from the Crawl activity tab.");
  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (cap.site && site && norm(cap.site) !== norm(site)) {
    throw new Error(`This was copied from ${cap.site}, but the dashboard is showing ${site}, and your account can't open ${cap.site} here.`);
  }

  const colCache = new Map<CapturePage, Col[]>();
  const colsOf = (p: CapturePage): Col[] => {
    const hit = colCache.get(p);
    if (hit) return hit;
    const out: Col[] = [];
    for (const s of p.series || []) {
      const rows = (s.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r[0] as string));
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      for (let j = 1; j < width; j++) {
        const map = new Map<string, number>();
        let sum = 0;
        for (const r of rows) {
          const v = Number(r[j]);
          if (Number.isFinite(v)) {
            map.set(String(r[0]), v);
            sum += v;
          }
        }
        if (map.size >= rows.length * 0.8) out.push({ map, sum, n: map.size });
      }
    }
    out.sort((a, b) => b.n - a.n);
    colCache.set(p, out);
    return out;
  };
  const candidates = (p?: CapturePage): Cand[] => {
    if (!p) return [];
    const cols = colsOf(p);
    const t = shown(p.tiles?.requests);
    if (t) {
      const m = cols.filter((c) => near(c.sum, t, 0.002));
      if (m.length) return m.map((col) => ({ col, tile: true }));
    }
    return cols.map((col) => ({ col, tile: false }));
  };
  const extras = (p: CapturePage, req: Col) => {
    const cols = colsOf(p);
    const by = shown(p.tiles?.bytes), mt = shown(p.tiles?.ms);
    const bytes = by ? cols.find((c) => c !== req && near(c.sum, by, 0.002))?.map ?? null : null;
    let ms: Map<string, number> | null = null;
    if (mt) {
      for (const c of cols) {
        if (c === req || c.map === bytes) continue;
        let s = 0, w = 0;
        req.map.forEach((q, d) => {
          const v = c.map.get(d);
          if (v != null) {
            s += v * q;
            w += q;
          }
        });
        if (w && near(s / w, mt, 0.03)) {
          ms = c.map;
          break;
        }
      }
    }
    return { bytes, ms: ms as Map<string, number> | null };
  };

  const find = (k: SeriesKind) => cap.pages.find((p) => p.kind === k);
  const T = find("total"), R = find("refresh"), D = find("discovery");
  const ct = candidates(T), cr = candidates(R), cd = candidates(D);

  let pick: { t?: Cand; r?: Cand; d?: Cand } = { t: ct[0], r: cr[0], d: cd[0] };
  let check: { ok: number; overlap: number } | null = null;
  if (ct.length && cr.length && cd.length) {
    let bestRatio = -1, bestOverlap = 0;
    for (const t of ct)
      for (const r of cr)
        for (const d of cd) {
          let ok = 0, overlap = 0;
          t.col.map.forEach((tv, date) => {
            const rv = r.col.map.get(date), dv = d.col.map.get(date);
            if (rv == null || dv == null) return;
            overlap++;
            if (Math.abs(rv + dv - tv) <= Math.max(1, tv * 0.002)) ok++;
          });
          const ratio = overlap ? ok / overlap : 0;
          if (ratio > bestRatio || (ratio === bestRatio && overlap > bestOverlap)) {
            bestRatio = ratio;
            bestOverlap = overlap;
            pick = { t, r, d };
            check = { ok, overlap };
          }
        }
  }
  const chk = check as { ok: number; overlap: number } | null;
  const sumOk = !!chk && chk.overlap >= 7 && chk.ok >= chk.overlap * 0.95;
  const present = [T ? pick.t : undefined, R ? pick.r : undefined, D ? pick.d : undefined].filter(Boolean) as Cand[];
  const verified = chk ? sumOk : present.length > 0 && present.every((x) => x.tile);

  const when = new Date(cap.capturedAt).toLocaleString();
  const items: ParsedCrawl[] = [];
  const make = (p: CapturePage, c: Cand | undefined, kind: SeriesKind, label: string) => {
    if (!c) return;
    const ex = extras(p, c.col);
    const days: Record<string, CrawlDay> = {};
    c.col.map.forEach((q, d) => {
      const b = ex.bytes?.get(d), t = ex.ms?.get(d);
      days[d] = { requests: q, ...(b != null && Number.isFinite(b) ? { bytes: b } : {}), ...(t != null && Number.isFinite(t) ? { ms: t } : {}) };
    });
    const dates = Object.keys(days).sort();
    items.push({
      file: `Crawl stats page (${label}), copied ${when}`,
      kind,
      label,
      days,
      urls: [],
      from: dates[0] || "",
      to: dates[dates.length - 1] || "",
      total: dates.reduce((n, d) => n + days[d].requests, 0),
      note: c.tile ? `Matches the page total (${p.tiles?.requests}).` : "",
    });
  };
  if (T) make(T, pick.t, "total", KIND_LABEL.total);
  if (R) make(R, pick.r, "refresh", KIND_LABEL.refresh);
  if (D) make(D, pick.d, "discovery", KIND_LABEL.discovery);
  for (const p of cap.pages.filter((x) => x.kind === "other")) make(p, candidates(p)[0], "other", p.label || "Other");
  if (!items.length) throw new Error("No daily crawl data was found. Reload the Crawl stats page (F5), wait for the chart, and click the bookmark again.");

  let summary = `Copied ${when}: ${items.map((i) => `${i.label} ${i.total.toLocaleString()}`).join(", ")} (${items[0].from} to ${items[0].to}).`;
  if (chk) {
    summary += sumOk
      ? ` Checked: Refresh + Discovery = All crawl requests on ${chk.ok} of ${chk.overlap} days.`
      : ` Refresh + Discovery matched the total on only ${chk.ok} of ${chk.overlap} days, so it wasn't saved automatically.`;
  }
  const miss = (cap.missing || []).map((m) => (m === "refresh" ? "Refresh" : "Discovery"));
  if (miss.length) {
    summary += ` ${miss.join(" and ")} ${miss.length > 1 ? "weren't" : "wasn't"} included yet: in Search Console open Crawl stats → By purpose → ${miss.join(", then ")} and click the bookmark on ${miss.length > 1 ? "each" : "that"} page once. After that it's included automatically.`;
  }
  return { items, verified, summary };
}
