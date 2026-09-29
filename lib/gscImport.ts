// lib/gscImport.ts
/**
 * Reads a Search Console Performance export (Export → Download CSV) so it can be turned into a growth report.
 * The export is a ZIP with one CSV per tab (Queries.csv, Pages.csv, Chart.csv, Filters.csv…).
 * In Compare mode every metric appears twice, e.g. "Last 6 months Clicks" and "Previous 6 months Clicks".
 * No dependencies: ZIP entries are inflated with the browser's built-in DecompressionStream.
 */
import type { GrowthInput, QueryPair, Totals } from "./queryGrowth";

export type TextFile = { name: string; text: string };

/* ---------- ZIP ---------- */

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ZIP reader (stored and deflated entries, which is what Search Console produces). */
export async function unzip(buf: ArrayBuffer): Promise<{ name: string; data: Uint8Array }[]> {
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file isn't a valid ZIP archive.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder("utf-8");
  const out: { name: string; data: Uint8Array }[] = [];
  for (let e = 0; e < count; e++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) });
  }
  return out;
}

const decode = (d: Uint8Array | ArrayBuffer) => new TextDecoder("utf-8").decode(d).replace(/^\uFEFF/, "");

/**
 * Sorts picked files: each ZIP becomes its own group of CSVs, loose CSVs picked together form one group,
 * and JSON files are returned parsed (saved reports).
 */
export async function readPicked(files: File[]) {
  const groups: { label: string; csv: TextFile[] }[] = [];
  const loose: TextFile[] = [], json: { name: string; data: unknown }[] = [], skipped: string[] = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      const csv: TextFile[] = [];
      for (const e of await unzip(await f.arrayBuffer())) {
        if (e.name.toLowerCase().endsWith(".csv")) csv.push({ name: e.name.split("/").pop() || e.name, text: decode(e.data) });
      }
      groups.push({ label: f.name, csv });
    } else if (lower.endsWith(".csv")) loose.push({ name: f.name, text: decode(await f.arrayBuffer()) });
    else if (lower.endsWith(".json")) {
      try { json.push({ name: f.name, data: JSON.parse(decode(await f.arrayBuffer())) }); } catch { skipped.push(f.name); }
    } else skipped.push(f.name);
  }
  if (loose.length) groups.push({ label: loose.map((f) => f.name).join(", "), csv: loose });
  return { groups, json, skipped };
}

/* ---------- CSV ---------- */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/* ---------- Search Console columns ---------- */

type Metric = "clicks" | "impressions" | "ctr" | "position";
type Col = { idx: number; metric: Metric; group: string };
const METRIC_RE = /(clicks|impressions|ctr|position)\s*$/i;
const PREVIOUS_RE = /previous|prior|earlier|last year|year ago|same period|before/i;

function metricColumns(header: string[]): Col[] {
  const cols: Col[] = [];
  header.forEach((h, i) => {
    if (i === 0) return;
    const m = h.trim().match(METRIC_RE);
    if (m) cols.push({ idx: i, metric: m[1].toLowerCase() as Metric, group: h.trim().slice(0, m.index).trim() });
  });
  // Unrecognised (e.g. translated) headers: Search Console orders compare columns as
  // clicks, clicks, impressions, impressions, CTR, CTR, position, position.
  if (!cols.length && header.length === 9) {
    const order: Metric[] = ["clicks", "impressions", "ctr", "position"];
    order.forEach((metric, k) => {
      cols.push({ idx: 1 + k * 2, metric, group: "Current period" }, { idx: 2 + k * 2, metric, group: "Previous period" });
    });
  }
  return cols;
}

const firstDate = (s: string) => {
  const m = s.match(/(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})/);
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]].map(Number);
  const d = m[1].length === 4 ? new Date(a, b - 1, c) : new Date(c < 100 ? 2000 + c : c, a - 1, b);
  return isNaN(d.getTime()) ? null : d.getTime();
};

/** Works out which of the two column groups is the current period. */
function resolveGroups(groups: string[]): { current: string; previous: string } {
  const [a, b] = groups;
  const pa = PREVIOUS_RE.test(a), pb = PREVIOUS_RE.test(b);
  if (pa !== pb) return pa ? { current: b, previous: a } : { current: a, previous: b };
  const da = firstDate(a), db = firstDate(b);
  if (da != null && db != null && da !== db) return da > db ? { current: a, previous: b } : { current: b, previous: a };
  return { current: a, previous: b };
}

const numOf = (s: string | undefined) => {
  const t = (s ?? "").replace(/[,\s%]/g, "");
  if (!t || t === "-" || t === "—") return NaN;
  return Number(t);
};

const isQueries = (f: TextFile, header: string[]) => /quer/i.test(f.name) || /quer/i.test(header[0] || "");
const isChart = (f: TextFile, header: string[]) => /chart/i.test(f.name) || /^date$/i.test((header[0] || "").trim());
const isFilters = (f: TextFile, header: string[]) => /filter/i.test(f.name) || /^filter$/i.test((header[0] || "").trim());

export const HOW_TO_EXPORT =
  "In Search Console open Performance → Search results, click the date filter, open the Compare tab, choose a comparison (for example “Compare last 6 months to previous period”) and click Apply. Then Export → Download CSV and import the ZIP here as it is.";

/** Guesses the property from the export's file name, e.g. "https___www.example.com_-Performance-on-Search-2026-09-29.zip". */
export function guessSite(fileName: string) {
  const m = fileName.match(/((?:[a-z0-9-]+\.)+[a-z]{2,})/i);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/^www\./, "");
  return /\.(csv|zip|json)$/.test(host) ? null : host;
}

/** Turns the CSVs of one Search Console compare-mode export into report input. */
export function parseGscExport(files: TextFile[], fileLabel: string): GrowthInput {
  const tables = files.map((f) => ({ f, rows: parseCsv(f.text) })).filter((t) => t.rows.length);
  const queries = tables.find((t) => isQueries(t.f, t.rows[0]));
  if (!queries) {
    throw new Error(`No Queries table was found in ${fileLabel}. Export from the Performance report with the Queries tab available. ${HOW_TO_EXPORT}`);
  }
  const header = queries.rows[0];
  const cols = metricColumns(header);
  const groups = Array.from(new Set(cols.map((c) => c.group)));
  if (groups.length < 2) {
    throw new Error(`This export covers a single period, so there's nothing to compare. ${HOW_TO_EXPORT}`);
  }
  if (groups.length > 2) throw new Error("This export has more than two periods of columns, which Search Console doesn't produce. Re-export it from Search Console.");
  const { current, previous } = resolveGroups(groups);
  const col = (g: string, m: Metric) => cols.find((c) => c.group === g && c.metric === m)?.idx;
  const ci = { c: col(current, "clicks"), i: col(current, "impressions"), p: col(current, "position") };
  const pi = { c: col(previous, "clicks"), i: col(previous, "impressions"), p: col(previous, "position") };
  if (ci.c == null && ci.i == null) throw new Error("The export has no Clicks or Impressions columns. Turn on Total clicks and Total impressions in Search Console before exporting.");

  const warnings: string[] = [];
  if (ci.i == null) warnings.push("The export has no impressions: turn on “Total impressions” in Search Console before exporting to see them.");
  if (ci.p == null) warnings.push("The export has no positions: turn on “Average position” in Search Console before exporting to see ranking changes.");

  const period = (row: string[], ix: typeof ci) => {
    const clicks = ix.c != null ? numOf(row[ix.c]) || 0 : 0;
    const impressions = ix.i != null ? numOf(row[ix.i]) || 0 : 0;
    const pos = ix.p != null ? numOf(row[ix.p]) : NaN;
    const shown = ix.i != null ? impressions > 0 : clicks > 0;
    return shown ? { clicks, impressions, position: isFinite(pos) && pos > 0 ? pos : null } : null;
  };
  const pairs: QueryPair[] = queries.rows.slice(1).map((r) => ({ query: (r[0] || "").trim(), cur: period(r, ci), prev: period(r, pi) }));

  /* Site totals from the chart (daily totals for the whole site) */
  let siteTotals: GrowthInput["siteTotals"];
  const chart = tables.find((t) => t !== queries && isChart(t.f, t.rows[0]));
  if (chart) {
    const ccols = metricColumns(chart.rows[0]);
    const cgroups = Array.from(new Set(ccols.map((c) => c.group)));
    if (cgroups.length === 2) {
      const map = cgroups.includes(current) && cgroups.includes(previous) ? { current, previous } : resolveGroups(cgroups);
      const sum = (g: string): Totals | null => {
        const c = ccols.find((x) => x.group === g && x.metric === "clicks")?.idx;
        const i = ccols.find((x) => x.group === g && x.metric === "impressions")?.idx;
        const p = ccols.find((x) => x.group === g && x.metric === "position")?.idx;
        if (c == null || i == null) return null;
        let clicks = 0, impressions = 0, posW = 0, posI = 0;
        for (const r of chart.rows.slice(1)) {
          const cc = numOf(r[c]), ii = numOf(r[i]), pp = p != null ? numOf(r[p]) : NaN;
          if (isFinite(cc)) clicks += cc;
          if (isFinite(ii)) impressions += ii;
          if (isFinite(pp) && pp > 0 && isFinite(ii) && ii > 0) { posW += pp * ii; posI += ii; }
        }
        return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: posI ? posW / posI : null };
      };
      const a = sum(map.current), b = sum(map.previous);
      if (a && b && (a.impressions || b.impressions)) siteTotals = { current: a, previous: b };
    }
  }

  /* The comparison chosen in Search Console, from Filters.csv */
  let compared = "";
  let searchType = "";
  const filters = tables.find((t) => isFilters(t.f, t.rows[0]));
  if (filters) {
    for (const r of filters.rows.slice(1)) {
      if (/date/i.test(r[0] || "")) compared = (r[1] || "").trim();
      if (/search type/i.test(r[0] || "")) searchType = (r[1] || "").trim();
    }
  }

  const listed = pairs.filter((p) => p.query).length;
  return {
    origin: "import",
    subject: guessSite(fileLabel) || fileLabel,
    currentLabel: current,
    previousLabel: previous,
    siteTotals,
    brand: "",
    pairs,
    coverage:
      `Imported from ${fileLabel}${compared ? ` (${compared}` : ""}${searchType ? `${compared ? ", " : " ("}${searchType} search` : ""}${compared || searchType ? ")" : ""}. ` +
      `Search Console exports hold at most 1,000 queries; this file has ${listed.toLocaleString()}. ` +
      (siteTotals
        ? "Totals come from the export's chart data and cover the whole site, so they include queries outside the file."
        : "The export had no chart data, so totals are sums of the listed queries only."),
    warnings,
  };
}
