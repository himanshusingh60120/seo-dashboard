// lib/capture/parseIdx.ts
// Reads what the "Copy page indexing" bookmark or the Chrome extension copied from Search Console's Page indexing
// report: picks the daily Indexed / Not indexed numbers and checks them against the report's tiles.
// No "use client": it runs in the browser (bookmark) and on the server (extension).
import { IDX_LABEL, IDX_VIEWS, latestIdxDay, type IdxDay, type IdxParsed, type IdxReason, type IdxView } from "../indexStats";

type Shown = { value: number; tol: number };
type CapView = {
  tiles?: { ni?: string; idx?: string };
  series?: (string | number | null)[][][];
  reasons?: [string, string, string, number][];
  from?: string;
};
type Capture = { v: number; src: string; site: string; current?: string; capturedAt: string; views?: Record<string, CapView> };

export type IdxCaptureResult = { parsed: IdxParsed; verified: boolean; summary: string; notes: string[]; problem?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BAD = "That doesn't look like data from the “Copy page indexing” bookmark. Click the bookmark on the Page indexing report in Search Console.";

/** "16.9k" → 16,900 ± 50 (half of the last digit shown). */
function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** (m[2]?.length ?? 0) };
}
const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;

type Order = [number, number]; // [Not indexed column, Indexed column] in each row: [date, a, b, c]
const ORDERS: Order[] = [[1, 2], [2, 1]];

const lastRow = (s: (string | number | null)[][], o: Order) =>
  [...s].reverse().find((r) => typeof r[o[0]] === "number" && typeof r[o[1]] === "number");

const nonZero = (s: (string | number | null)[][]) => s.some((r) => (Number(r[1]) || 0) + (Number(r[2]) || 0) > 0);

function build(s: (string | number | null)[][], o: Order): Record<string, IdxDay> {
  const days: Record<string, IdxDay> = {};
  const impCol = [1, 2, 3].find((c) => c !== o[0] && c !== o[1]) ?? 3;
  for (const r of s) {
    const d = r[0], a = r[o[0]], b = r[o[1]];
    if (typeof d !== "string" || !DATE.test(d) || typeof a !== "number" || typeof b !== "number") continue;
    const imp = r[impCol];
    days[d] = { notIndexed: Math.round(a), indexed: Math.round(b), ...(typeof imp === "number" ? { impressions: Math.round(imp) } : {}) };
  }
  return days;
}

export function parseIdxCapture(text: string, site: string): IdxCaptureResult {
  let cap: Capture;
  try {
    cap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!cap || cap.src !== "gsc-page-indexing" || !cap.views || typeof cap.views !== "object") throw new Error(BAD);
  if (cap.v !== 1) throw new Error("This came from a different version of the “Copy page indexing” bookmark. Drag the current one from the Indexing tab.");
  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (cap.site && site && norm(cap.site) !== norm(site)) {
    throw new Error(`This was copied from ${cap.site}, but the dashboard is showing ${site}, and your account can't open ${cap.site} here.`);
  }

  // First, views whose tiles can be matched: this also tells us which column is Indexed.
  const picks: Partial<Record<IdxView, { s: (string | number | null)[][]; o: Order; ok: boolean }>> = {};
  let learned: Order | null = null;
  for (const v of IDX_VIEWS) {
    const cv = cap.views[v];
    if (!cv) continue;
    const ni = shown(cv.tiles?.ni), ix = shown(cv.tiles?.idx);
    const cands = (cv.series || []).filter((s) => Array.isArray(s) && s.length && nonZero(s));
    if (!ni || !ix) continue;
    for (const s of cands) {
      for (const o of ORDERS) {
        const r = lastRow(s, o);
        if (r && near(r[o[0]] as number, ni, 0.002) && near(r[o[1]] as number, ix, 0.002)) {
          picks[v] = { s, o, ok: true };
          learned = learned || o;
          break;
        }
      }
      if (picks[v]) break;
    }
  }
  // Then the rest: the busiest series, read with the column order learned above.
  for (const v of IDX_VIEWS) {
    if (picks[v]) continue;
    const cands = (cap.views[v]?.series || []).filter((s) => Array.isArray(s) && s.length && nonZero(s));
    if (!cands.length) continue;
    const o = learned || ORDERS[0];
    const s = cands.slice().sort((a, b) => {
      const ra = lastRow(a, o), rb = lastRow(b, o);
      return ((rb ? (rb[1] as number) + (rb[2] as number) : 0) - (ra ? (ra[1] as number) + (ra[2] as number) : 0)) || b.length - a.length;
    })[0];
    picks[v] = { s, o, ok: false };
  }

  const parsed: IdxParsed = {};
  const notes: string[] = [];
  const parts: string[] = [];
  for (const v of IDX_VIEWS) {
    const pk = picks[v];
    const cv = cap.views[v];
    if (!pk) {
      notes.push(`${IDX_LABEL[v]} couldn't be read.`);
      continue;
    }
    const days = build(pk.s, pk.o);
    const dates = Object.keys(days).sort();
    if (!dates.length) {
      notes.push(`${IDX_LABEL[v]} had no daily numbers.`);
      continue;
    }
    const reasons: IdxReason[] = (cv?.reasons || [])
      .filter((r) => Array.isArray(r) && typeof r[0] === "string" && Number.isInteger(Number(r[3])))
      .map((r) => ({
        reason: String(r[0]).replace(/\s+/g, " ").trim(),
        source: String(r[1] || "").replace(/\s+/g, " ").trim(),
        validation: String(r[2] || "").replace(/\s+/g, " ").trim(),
        pages: Number(r[3]),
      }));
    const asOf = dates[dates.length - 1];
    parsed[v] = { days, reasons, asOf };
    const L = latestIdxDay({ days, reasons, reasonsHistory: {} })!;
    parts.push(`${IDX_LABEL[v]}: ${L.indexed.toLocaleString()} indexed · ${L.notIndexed.toLocaleString()} not indexed`);
    if (!reasons.length) notes.push(`The reasons for ${IDX_LABEL[v]} weren't read; choose that view on the report and click the bookmark there.`);
    if (!pk.ok) notes.push(`${IDX_LABEL[v]} couldn't be checked against its tiles.`);
  }
  if (!Object.keys(parsed).length) throw new Error("No daily Indexed / Not indexed numbers were found. Reload the report (F5) and click the bookmark again.");

  const cur = IDX_VIEWS.includes(cap.current as IdxView) ? (cap.current as IdxView) : null;
  const verified = cur ? !!picks[cur]?.ok : IDX_VIEWS.some((v) => picks[v]?.ok);
  const asOf = Object.values(parsed).map((p) => p!.asOf).sort().pop();
  return {
    parsed,
    verified,
    summary: `${parts.join("; ")} (as of ${asOf})`,
    notes,
    problem: verified
      ? undefined
      : "The daily numbers didn't match the report's Indexed / Not indexed tiles, so nothing was saved. Reload the report (F5) and click the bookmark again, or save anyway.",
  };
}
