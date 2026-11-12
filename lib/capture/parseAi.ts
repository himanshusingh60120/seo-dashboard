// lib/capture/parseAi.ts
// Reads what the "Copy AI impressions" bookmark or the Chrome extension copied from the Generative AI report: the daily
// impressions that add up to the report's Total impressions, and the page, country and device lists.
// No "use client": it runs in the browser (bookmark) and on the server (extension).
import type { AiParsed } from "../aiStore";
import { AI_MAX_PAGES } from "../aiStore";
import { normalizeUrl, urlInProperty } from "../url";

type Shown = { value: number; tol: number };
type Rows = { path: string; rows: (string | number)[][] };
type Capture = {
  v: number;
  src: string;
  site: string;
  url?: string;
  capturedAt: string;
  tiles?: { impressions?: string };
  series?: Rows[];
  pages?: Rows[];
  table?: [string, number][];
  tableComplete?: boolean;
  countries?: [string, number][];
  devices?: [string, number][];
  debug?: { countriesTab?: string; devicesTab?: string; devicesSeen?: string[]; pagedRows?: number };
};

export type AiCaptureResult = { item: AiParsed; verified: boolean; summary: string; notes: string[]; problem?: string };

function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** (m[2]?.length ?? 0) };
}
const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;

/** "smartphone Mobile" → "Mobile". */
function deviceOf(label: string): string | null {
  const m = label.match(/\b(desktop|mobile|tablet)\b/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

const BAD = "That doesn't look like data from the “Copy AI impressions” bookmark. Click the bookmark on the Generative AI features report in Search Console.";

export function parseAiCapture(text: string, site: string): AiCaptureResult {
  let cap: Capture;
  try {
    cap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!cap || cap.src !== "gsc-ai-impressions" || !Array.isArray(cap.series)) throw new Error(BAD);
  if (cap.v !== 1 && cap.v !== 2) {
    throw new Error("This came from a different version of the “Copy AI impressions” bookmark. Drag the current one from the Overview tab.");
  }
  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (cap.site && site && norm(cap.site) !== norm(site)) {
    throw new Error(`This was copied from ${cap.site}, but the dashboard is showing ${site}, and your account can't open ${cap.site} here.`);
  }

  // Daily columns: whole-number values on at least 80% of the dates.
  type DayCol = { map: Map<string, number>; sum: number };
  const cols: DayCol[] = [];
  for (const s of cap.series || []) {
    const rows = (s.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r[0] as string));
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    for (let j = 1; j < width; j++) {
      const map = new Map<string, number>();
      let sum = 0;
      for (const r of rows) {
        const v = Number(r[j]);
        if (Number.isInteger(v) && v >= 0) {
          map.set(String(r[0]), v);
          sum += v;
        }
      }
      if (map.size >= rows.length * 0.8) cols.push({ map, sum });
    }
  }
  if (!cols.length) {
    throw new Error("No daily AI impressions were found. Reload the report (F5), wait for the chart, and click the bookmark again, or import an export instead.");
  }
  const tile = shown(cap.tiles?.impressions);
  const matching = tile ? cols.filter((c) => near(c.sum, tile, 0.003)) : [];
  const verified = matching.length > 0;
  const pick = (verified ? matching : cols).slice().sort((a, b) => b.map.size - a.map.size || b.sum - a.sum)[0];
  const dates = Array.from(pick.map.keys()).sort();
  const days: Record<string, number> = {};
  for (const d of dates) days[d] = pick.map.get(d)!;
  const total = dates.reduce((n, d) => n + days[d], 0);

  // Pages: the hidden list whose numbers agree with the table; otherwise the table rows that were read.
  const notes: string[] = [];
  const inProp = (u: string) => {
    try {
      return urlInProperty(site, u);
    } catch {
      return false;
    }
  };
  const table = new Map<string, number>();
  for (const r of cap.table || []) {
    if (Array.isArray(r) && typeof r[0] === "string" && inProp(r[0]) && Number.isInteger(Number(r[1]))) table.set(normalizeUrl(r[0]), Number(r[1]));
  }
  let best: { rows: Record<string, number>; agree: number; n: number } | null = null;
  for (const cand of cap.pages || []) {
    const rows = (cand.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && inProp(r[0] as string));
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    for (let j = 1; j < width; j++) {
      const out: Record<string, number> = {};
      let agree = 0, n = 0;
      for (const r of rows) {
        const v = Number(r[j]);
        if (!Number.isInteger(v) || v < 0) continue;
        const u = normalizeUrl(String(r[0]));
        out[u] = v;
        n++;
        if (table.get(u) === v) agree++;
      }
      if (n < rows.length * 0.8) continue;
      if (!best || agree > best.agree || (agree === best.agree && n > best.n)) best = { rows: out, agree, n };
    }
  }
  let pages: Record<string, number> = {};
  const b = best as { rows: Record<string, number>; agree: number; n: number } | null;
  if (b && (b.agree > 0 || !table.size) && b.n >= table.size) {
    pages = b.rows;
  } else if (table.size) {
    pages = Object.fromEntries(table);
    if (!cap.tableComplete) {
      notes.push(`Only ${table.size} pages could be read from the table; reload the report (F5) and click the bookmark again for the full list.`);
    }
  } else {
    notes.push("No page list was found.");
  }
  pages = Object.fromEntries(Object.entries(pages).sort((a, b2) => b2[1] - a[1]).slice(0, AI_MAX_PAGES));

  // Countries and devices: read from their tabs (rows visible in each table).
  const countries: Record<string, number> = {};
  for (const r of cap.countries || []) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    const k = r[0].trim(), v = Number(r[1]);
    if (k && k.length <= 80 && !/^https?:\/\//i.test(k) && !deviceOf(k) && Number.isInteger(v) && v >= 0) countries[k] = v;
  }
  const devices: Record<string, number> = {};
  for (const r of cap.devices || []) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    const k = deviceOf(r[0]), v = Number(r[1]);
    if (k && Number.isInteger(v) && v >= 0) devices[k] = v;
  }
  const nP = Object.keys(pages).length, nC = Object.keys(countries).length, nD = Object.keys(devices).length;
  if (cap.v === 1) notes.push("Countries and devices need the updated bookmark: drag it from this page again.");
  else {
    if (!nC) notes.push(cap.debug?.countriesTab === "not found" ? "The Countries tab wasn't found." : "No countries were read.");
    if (!nD) {
      const seen = cap.debug?.devicesSeen?.filter(Boolean) || [];
      notes.push(
        cap.debug?.devicesTab === "not found"
          ? "The Devices tab wasn't found."
          : `No devices were read${seen.length ? ` (the Devices tab showed: ${seen.join(", ")})` : ""}.`
      );
    }
  }

  const summary = `${total.toLocaleString()} AI impressions, ${dates[0]} to ${dates[dates.length - 1]} · ${nP.toLocaleString()} pages · ${nC} countries · ${nD} devices`;
  const problem = verified
    ? undefined
    : tile
      ? `The days add up to ${total.toLocaleString()}, not the report's Total impressions (${cap.tiles?.impressions}), so nothing was saved. Check the date range on the report and click the bookmark again, or save anyway.`
      : "The report's Total impressions couldn't be read, so the numbers couldn't be checked and nothing was saved. Click the bookmark again, or save anyway.";

  return {
    item: {
      file: `Bookmark, ${new Date(cap.capturedAt).toLocaleString()}`,
      from: dates[0],
      to: dates[dates.length - 1],
      days,
      pages,
      countries,
      devices,
    },
    verified,
    summary,
    notes,
    problem,
  };
}
