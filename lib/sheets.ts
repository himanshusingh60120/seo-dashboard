// lib/sheets.ts
// The Google Sheets the dashboard uses as its database, through the Sheets API, signed in as the service account.
// One control Sheet (INDEX_SHEET_ID) holds the shared bookkeeping (_Jobs, _Sheets, _Updates, _Log, _Meta) and each
// property has its own Sheet (see lib/sheetBooks.ts). Every function takes the spreadsheet ID ("book") first.
// Values are written as-is (RAW): dates stay as text such as 2026-11-12, numbers stay numbers.
// Tabs whose name starts with "_" (technical tabs) are created hidden. Server-only.
import { serviceAccountToken } from "./serviceAccount";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export type Cell = string | number | boolean;
export type Row = Cell[];
/** A spreadsheet ID. */
export type Book = string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

/** The control Sheet (INDEX_SHEET_ID). */
export function controlBook(): Book {
  const id = process.env.INDEX_SHEET_ID;
  if (!id) throw new Error("INDEX_SHEET_ID isn't set.");
  return id;
}

export const bookUrl = (book: Book) => `https://docs.google.com/spreadsheets/d/${book}/edit`;
/** Link to the control Sheet. */
export const sheetUrl = () => bookUrl(process.env.INDEX_SHEET_ID || "");

/** JSON in/out. Retries "too many requests" and server errors with growing pauses. */
async function call<T = any>(book: Book, path: string, init: RequestInit = {}): Promise<T> {
  const token = await serviceAccountToken();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${book}${path}`, {
      ...init,
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: { message: text.slice(0, 300) } };
    }
    if (res.ok) return data as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    const hint =
      res.status === 403 || res.status === 404
        ? " (check that this Sheet still exists in the shared drive and the service account can edit it)"
        : "";
    throw new Error(`Google Sheets: ${data?.error?.message || `error ${res.status}`}${hint}`);
  }
}

/** Tab names can't contain : \ / ? * [ ] and are limited to 100 characters. */
export const safeTitle = (s: string) => s.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 95);
const a1 = (title: string, range = "") => `'${title.replace(/'/g, "''")}'${range ? `!${range}` : ""}`;

/** 1 → A, 16 → P, 27 → AA */
export function colLetter(n: number) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type TabMeta = { sheetId: number; title: string; rows: number; cols: number };
const metaCache = new Map<Book, { at: number; tabs: Map<string, TabMeta> }>();

export async function tabs(book: Book, force = false): Promise<Map<string, TabMeta>> {
  const hit = metaCache.get(book);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit.tabs;
  const d = await call<any>(book, `?fields=${enc("sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))")}`);
  const m = new Map<string, TabMeta>();
  for (const s of d.sheets || []) {
    const p = s.properties;
    m.set(p.title, { sheetId: p.sheetId, title: p.title, rows: p.gridProperties?.rowCount ?? 0, cols: p.gridProperties?.columnCount ?? 0 });
  }
  metaCache.set(book, { at: Date.now(), tabs: m });
  return m;
}

/** Runs spreadsheet batchUpdate requests (add, rename, hide or delete tabs, formatting). Returns Google's replies. */
export async function batchUpdate(book: Book, requests: object[]): Promise<any> {
  if (!requests.length) return { replies: [] };
  const r = await call<any>(book, ":batchUpdate", { method: "POST", body: JSON.stringify({ requests }) });
  metaCache.delete(book); // tab names or sizes may have changed
  return r;
}

/** Copies a tab, with its formatting, into another spreadsheet. Google names the copy "Copy of …". */
export async function copyTab(book: Book, sheetId: number, dest: Book): Promise<{ sheetId: number; title: string }> {
  const r = await call<any>(book, `/sheets/${sheetId}:copyTo`, {
    method: "POST",
    body: JSON.stringify({ destinationSpreadsheetId: dest }),
  });
  metaCache.delete(dest);
  return { sheetId: Number(r.sheetId), title: String(r.title || "") };
}

/**
 * Creates a simple tab (bold, frozen header row) if it doesn't exist. Tabs whose name starts with "_" are created
 * hidden. With checkHeaders, rewrites row 1 on an existing tab.
 */
export async function ensureTab(book: Book, title: string, headers: string[], checkHeaders = false) {
  const t = (await tabs(book)).get(title);
  if (!t) {
    try {
      const r = await batchUpdate(book, [
        {
          addSheet: {
            properties: {
              title,
              hidden: title.startsWith("_"),
              gridProperties: { rowCount: 1000, columnCount: headers.length, frozenRowCount: 1 },
            },
          },
        },
      ]);
      const sheetId = r?.replies?.[0]?.addSheet?.properties?.sheetId;
      if (sheetId != null) {
        await batchUpdate(book, [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true } } },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
        ]);
      }
    } catch (e) {
      if (!/already exists/i.test(e instanceof Error ? e.message : "")) throw e;
    }
    await tabs(book, true);
    await writeRange(book, title, `A1:${colLetter(headers.length)}1`, [headers]);
    return;
  }
  if (checkHeaders) {
    await ensureSize(book, title, 1, headers.length);
    await writeRange(book, title, `A1:${colLetter(headers.length)}1`, [headers]);
  }
}

/** Grows the tab's grid when needed (writes outside the grid are rejected by Google). */
export async function ensureSize(book: Book, title: string, rows: number, cols: number) {
  const t = (await tabs(book)).get(title) ?? (await tabs(book, true)).get(title);
  if (!t) throw new Error(`The tab "${title}" is missing from the Sheet.`);
  if (t.rows >= rows && t.cols >= cols) return;
  const rowCount = Math.max(t.rows, rows + 500);
  const columnCount = Math.max(t.cols, cols);
  await batchUpdate(book, [
    {
      updateSheetProperties: {
        properties: { sheetId: t.sheetId, gridProperties: { rowCount, columnCount } },
        fields: "gridProperties.rowCount,gridProperties.columnCount",
      },
    },
  ]);
}

export async function readRange(book: Book, title: string, range: string): Promise<Row[]> {
  const d = await call<{ values?: Row[] }>(
    book,
    `/values/${enc(a1(title, range))}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
  return d.values || [];
}

export async function readRanges(book: Book, title: string, ranges: string[]): Promise<Row[][]> {
  if (!ranges.length) return [];
  const q = ranges.map((r) => `ranges=${enc(a1(title, r))}`).join("&");
  const d = await call<{ valueRanges?: { values?: Row[] }[] }>(
    book,
    `/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
  return ranges.map((_, i) => d.valueRanges?.[i]?.values || []);
}

export async function writeRange(book: Book, title: string, range: string, values: Row[]) {
  await call(book, `/values/${enc(a1(title, range))}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range: a1(title, range), majorDimension: "ROWS", values }),
  });
}

export async function writeRanges(book: Book, title: string, data: { range: string; values: Row[] }[]) {
  if (!data.length) return;
  await call(book, "/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data: data.map((d) => ({ range: a1(title, d.range), values: d.values })) }),
  });
}

export async function appendRows(book: Book, title: string, rows: Row[]) {
  if (!rows.length) return;
  await call(book, `/values/${enc(a1(title, "A1"))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: rows }),
  });
}

export async function clearRange(book: Book, title: string, range: string) {
  await call(book, `/values/${enc(a1(title, range))}:clear`, { method: "POST", body: "{}" });
}

/** Reads several ranges of one spreadsheet in one request. Tabs that don't exist come back empty. */
export async function batchRead(book: Book, blocks: { title: string; range: string }[]): Promise<Row[][]> {
  const have = await tabs(book);
  const present = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.title && have.has(x.b.title));
  const out: Row[][] = blocks.map(() => []);
  if (!present.length) return out;
  const q = present.map((x) => `ranges=${enc(a1(x.b.title, x.b.range))}`).join("&");
  const d = await call<{ valueRanges?: { values?: Row[] }[] }>(
    book,
    `/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
  present.forEach((x, k) => {
    out[x.i] = d.valueRanges?.[k]?.values || [];
  });
  return out;
}
