// lib/sheetLayout.ts
// Layout of a property's Google Sheet: one tab holding every kind of data in its own colour-coded section, side by
// side from left to right. Row 1 is each section's coloured title bar, row 2 its column headers (both frozen), and
// data starts on row 3. The long URL list is the last section, so the tab opens on the overview and the reports.
// Each property has its own Sheet (lib/sheetBooks.ts); the control Sheet (INDEX_SHEET_ID) keeps the shared, hidden
// tabs (_Jobs, _Sheets, _Updates, _Log, _Meta). Server-only.
import { HttpError } from "./token";
import {
  batchRead, batchUpdate, clearRange, colLetter, controlBook, ensureSize, ensureTab, readRange, safeTitle, tabs, writeRange,
  writeRanges, type Book, type Row,
} from "./sheets";

export const META_TAB = "_Meta";
/** v3: one Google Sheet per property. */
export const LAYOUT_VERSION = "v3";
/** Added to a property tab left (hidden) in the control Sheet once it has moved to its own Sheet. */
export const MOVED_SUFFIX = " (moved)";
/** First data row of every section (row 1 = title bar, row 2 = headers). */
export const FIRST_ROW = 3;

export type SectionKey = "overview" | "pages" | "reasons" | "crawl" | "crawlUrls" | "ai" | "aiSplit" | "sitemaps" | "changes" | "urls";

export const URL_HEADERS = [
  "URL", "Sitemap", "Source", "Sitemap lastmod", "Status", "Verified by", "Google's reason", "Page fetch",
  "Last crawled by Google", "Google canonical", "Last inspected", "Impressions (28 days)", "Last seen in search",
  "Next check", "Flag", "Inspection link",
];

type SectionDef = {
  key: SectionKey; title: string; color: string; light: string; headers: string[];
  numeric?: number[]; widths?: Record<number, number>;
};

const DEFS: SectionDef[] = [
  { key: "overview", title: "Overview", color: "#1A3A6B", light: "#DCE6F5", headers: ["Metric", "Value", "Notes"], numeric: [1], widths: { 0: 260, 1: 150, 2: 320 } },
  { key: "pages", title: "Page indexing · Google's report", color: "#5E35B1", light: "#EDE7F6", headers: ["View", "Date", "Indexed", "Not indexed", "Impressions"], numeric: [2, 3, 4], widths: { 0: 180 } },
  { key: "reasons", title: "Why pages aren't indexed", color: "#8E6CC8", light: "#F3EEFA", headers: ["View", "As of", "Reason", "Source", "Validation", "Pages"], numeric: [5], widths: { 0: 180, 2: 320 } },
  { key: "crawl", title: "Crawl stats", color: "#E8710A", light: "#FDEBD9", headers: ["Series key", "Series", "Date", "Requests", "Bytes", "Avg response (ms)"], numeric: [3, 4, 5], widths: { 1: 160 } },
  { key: "crawlUrls", title: "Crawled URLs (from exports)", color: "#F29B4C", light: "#FEF3E8", headers: ["Series key", "URL", "Crawled"], widths: { 1: 320 } },
  { key: "ai", title: "AI impressions", color: "#00897B", light: "#DFF3F1", headers: ["Date", "AI impressions"], numeric: [1] },
  { key: "aiSplit", title: "AI pages, countries, devices", color: "#4DB6AC", light: "#EAF7F6", headers: ["From", "To", "Saved at", "By", "Source", "Type", "Name", "AI impressions"], numeric: [7], widths: { 3: 200, 4: 220, 6: 320 } },
  { key: "sitemaps", title: "By sitemap", color: "#5F6B7A", light: "#ECEFF3", headers: ["Sitemap", "URLs", "Verified", "Indexed", "Not indexed", "Errors", "Not checked yet", "% verified", "Updated"], numeric: [1, 2, 3, 4, 5, 6], widths: { 0: 340 } },
  { key: "changes", title: "Status changes", color: "#C5221F", light: "#FBE3E2", headers: ["Time", "URL", "Change", "Before", "After", "Inspection link"], widths: { 0: 170, 1: 340, 2: 220, 3: 240, 4: 240 } },
  { key: "urls", title: "URL checks · Google's URL Inspection", color: "#1E8E3E", light: "#E3F2E7", headers: URL_HEADERS, numeric: [11], widths: { 0: 380, 1: 280, 6: 280, 9: 280, 14: 260 } },
];

export type Section = SectionDef & { start: number; end: number; width: number; L: string; R: string };
export const SEC = {} as Record<SectionKey, Section>;
const SECTIONS: Section[] = [];
let col = 1;
for (const d of DEFS) {
  const width = d.headers.length;
  const sec: Section = { ...d, start: col, end: col + width - 1, width, L: colLetter(col), R: colLetter(col + width - 1) };
  SEC[d.key] = sec;
  SECTIONS.push(sec);
  col += width + 1; // one empty column between sections
}
/** Columns used by a property tab. */
export const TOTAL_COLS = col - 2;

/** All data rows of a section, e.g. "E3:I". */
export const sectionRange = (key: SectionKey) => `${SEC[key].L}${FIRST_ROW}:${SEC[key].R}`;

/** "sc-domain:example.com" → "example.com (domain)"; "https://www.example.com/" → "www.example.com". */
export function tabFor(site: string) {
  const t = site.startsWith("sc-domain:") ? `${site.slice(10)} (domain)` : site.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return safeTitle(t);
}

const s = (v: unknown) => (v == null ? "" : String(v).trim());

/* ---------------- Layout version (one-time move to one Sheet per property) ---------------- */

let ready = false;
let lastCheck = 0;
let checking: Promise<boolean> | null = null;

export async function markLayoutReady() {
  const control = controlBook();
  await ensureTab(control, META_TAB, ["Key", "Value"]);
  await writeRange(control, META_TAB, "A2:B3", [["layout", LAYOUT_VERSION], ["migrating", ""]]);
  ready = true;
}

/** Property tabs still inside the control Sheet (from the one-tab-per-property layout), waiting to move to their own Sheet. */
export async function controlPropertyTabs(): Promise<string[]> {
  const control = controlBook();
  const have = await tabs(control, true);
  const titles = [...have.keys()].filter((t) => !t.startsWith("_") && !t.endsWith(MOVED_SUFFIX) && !/ \(old( \d+)?\)$/.test(t));
  if (!titles.length) return [];
  const firstCells = await batchRead(control, titles.map((t) => ({ title: t, range: "A1:A1" })));
  return titles.filter((_, i) => s(firstCells[i]?.[0]?.[0]) === SEC.overview.title);
}

async function checkLayout(): Promise<boolean> {
  const control = controlBook();
  const have = await tabs(control, true);
  if (have.has(META_TAB)) {
    const rows = await readRange(control, META_TAB, "A2:B2");
    if (s(rows[0]?.[0]) === "layout" && s(rows[0]?.[1]) === LAYOUT_VERSION) {
      ready = true;
      return true;
    }
  }
  if (!(await controlPropertyTabs()).length) {
    await markLayoutReady(); // nothing to move
    return true;
  }
  lastCheck = Date.now();
  return false;
}

/**
 * True once every property has its own Sheet. A control Sheet with no property tabs inside it is marked ready at once.
 * Calls made at the same moment share one check, so they always get the same answer.
 */
export function layoutReady(): Promise<boolean> {
  if (ready) return Promise.resolve(true);
  if (checking) return checking;
  if (Date.now() - lastCheck < 20_000) return Promise.resolve(false);
  checking = checkLayout().finally(() => {
    checking = null;
  });
  return checking;
}

export async function assertLayout() {
  if (await layoutReady()) return;
  throw new HttpError(
    503,
    "The Google Sheets are being reorganised into one Sheet per property. It happens with the next hourly run (or click Run on /api/cron/index-plan in Vercel → Settings → Cron Jobs). Try again in a few minutes."
  );
}

/* ---------------- Creating and formatting a property tab ---------------- */

const rgb = (hex: string) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});

function formatRequests(sheetId: number): object[] {
  const req: object[] = [];
  const cols = (a: number, b: number) => ({ sheetId, startColumnIndex: a, endColumnIndex: b });
  const width = (a: number, b: number, px: number) => ({
    updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: a, endIndex: b }, properties: { pixelSize: px }, fields: "pixelSize" },
  });
  req.push(width(0, TOTAL_COLS, 120));
  req.push({
    updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 32 }, fields: "pixelSize" },
  });
  for (const sec of SECTIONS) {
    const a = sec.start - 1;
    const b = sec.end;
    req.push({ mergeCells: { range: { ...cols(a, b), startRowIndex: 0, endRowIndex: 1 }, mergeType: "MERGE_ALL" } });
    req.push({
      repeatCell: {
        range: { ...cols(a, b), startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: rgb(sec.color), textFormat: { bold: true, fontSize: 12, foregroundColor: rgb("#FFFFFF") }, verticalAlignment: "MIDDLE" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)",
      },
    });
    req.push({
      repeatCell: {
        range: { ...cols(a, b), startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { backgroundColor: rgb(sec.light), textFormat: { bold: true, foregroundColor: rgb("#1F2933") }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)",
      },
    });
    for (const k of sec.numeric || []) {
      req.push({
        repeatCell: {
          range: { ...cols(a + k, a + k + 1), startRowIndex: 2 },
          cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }
    for (const [k, px] of Object.entries(sec.widths || {})) req.push(width(a + Number(k), a + Number(k) + 1, px));
    if (sec.end < TOTAL_COLS) req.push(width(sec.end, sec.end + 1, 24)); // narrow gap column
  }

  // Coloured values: URL status, and the kind of status change.
  const rule = (c: number, type: string, value: string, bg: string, fg: string) => ({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [{ ...cols(c, c + 1), startRowIndex: 2 }],
        booleanRule: {
          condition: { type, values: [{ userEnteredValue: value }] },
          format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg), bold: true } },
        },
      },
    },
  });
  const status = SEC.urls.start - 1 + 4;
  const change = SEC.changes.start - 1 + 2;
  req.push(
    rule(status, "TEXT_EQ", "Indexed", "#D4EDDA", "#137333"),
    rule(status, "TEXT_EQ", "Not indexed", "#FBE3E2", "#B3261E"),
    rule(status, "TEXT_EQ", "Not checked yet", "#ECEFF3", "#5F6B7A"),
    rule(status, "TEXT_EQ", "Error", "#FDEBD9", "#B06000"),
    rule(change, "TEXT_CONTAINS", "Dropped", "#FBE3E2", "#B3261E"),
    rule(change, "TEXT_CONTAINS", "Impressions stopped", "#FEF3D6", "#8A5A00"),
    rule(change, "TEXT_CONTAINS", "Newly indexed", "#D4EDDA", "#137333"),
    rule(change, "TEXT_CONTAINS", "Back in search", "#D4EDDA", "#137333"),
    rule(change, "TEXT_CONTAINS", "still indexed", "#E3F2E7", "#137333")
  );
  return req;
}

/** Creates a property tab with every section's title bar, headers, colours and formats. */
export async function createPropertyTab(book: Book, title: string, rows = 1000) {
  try {
    await batchUpdate(book, [
      {
        addSheet: {
          properties: { title, index: 0, gridProperties: { rowCount: Math.max(1000, rows + 500), columnCount: TOTAL_COLS, frozenRowCount: 2 } },
        },
      },
    ]);
  } catch (e) {
    if (/already exists/i.test(e instanceof Error ? e.message : "")) return;
    throw e;
  }
  const t = (await tabs(book, true)).get(title);
  if (!t) throw new Error(`Couldn't create the tab "${title}".`);
  await writeRanges(
    book,
    title,
    SECTIONS.flatMap((sec) => [
      { range: `${sec.L}1`, values: [[sec.title]] },
      { range: `${sec.L}2:${sec.R}2`, values: [sec.headers] },
    ])
  );
  await batchUpdate(book, formatRequests(t.sheetId));
}

/* ---------------- Reading and writing sections ---------------- */

const fit = (sec: Section) => (r: Row): Row => {
  const o = r.slice(0, sec.width);
  while (o.length < sec.width) o.push("");
  return o;
};

/** Replaces all data rows of a section (and clears anything left below them in that section only). */
export async function writeSection(book: Book, title: string, key: SectionKey, rows: Row[]) {
  const sec = SEC[key];
  const data = rows.map(fit(sec));
  await ensureSize(book, title, data.length + FIRST_ROW, TOTAL_COLS);
  for (let i = 0; i < data.length; i += 5000) {
    const part = data.slice(i, i + 5000);
    await writeRange(book, title, `${sec.L}${FIRST_ROW + i}:${sec.R}${FIRST_ROW + i + part.length - 1}`, part);
  }
  const t = (await tabs(book)).get(title);
  const from = FIRST_ROW + data.length;
  if (t && t.rows >= from) await clearRange(book, title, `${sec.L}${from}:${sec.R}${t.rows}`);
}

/** Adds rows below the last row of a section. */
export async function appendSection(book: Book, title: string, key: SectionKey, rows: Row[]) {
  if (!rows.length) return;
  const sec = SEC[key];
  const firstCol = await readRange(book, title, `${sec.L}${FIRST_ROW}:${sec.L}`);
  const start = FIRST_ROW + firstCol.length;
  await ensureSize(book, title, start + rows.length, TOTAL_COLS);
  await writeRange(book, title, `${sec.L}${start}:${sec.R}${start + rows.length - 1}`, rows.map(fit(sec)));
}
