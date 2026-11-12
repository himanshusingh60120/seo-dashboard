// lib/sheets.ts
// The Google Sheet the dashboard uses as its database (INDEX_SHEET_ID), through the Sheets API, signed in as the
// service account. Values are written as-is (RAW): dates stay as text such as 2026-11-12, numbers stay numbers.
// Server-only.
import { serviceAccountToken } from "./serviceAccount";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export type Cell = string | number | boolean;
export type Row = Cell[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

export const sheetUrl = () => `https://docs.google.com/spreadsheets/d/${process.env.INDEX_SHEET_ID || ""}/edit`;

function spreadsheetId() {
  const id = process.env.INDEX_SHEET_ID;
  if (!id) throw new Error("INDEX_SHEET_ID isn't set.");
  return id;
}

/** JSON in/out. Retries "too many requests" and server errors with growing pauses. */
async function call<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await serviceAccountToken();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${spreadsheetId()}${path}`, {
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
    const hint = res.status === 403 || res.status === 404 ? " (check INDEX_SHEET_ID and that the Sheet is shared with the service account as Editor)" : "";
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
let metaCache: { at: number; tabs: Map<string, TabMeta> } | null = null;

export async function tabs(force = false): Promise<Map<string, TabMeta>> {
  if (!force && metaCache && Date.now() - metaCache.at < 30_000) return metaCache.tabs;
  const d = await call<any>(`?fields=${enc("sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))")}`);
  const m = new Map<string, TabMeta>();
  for (const s of d.sheets || []) {
    const p = s.properties;
    m.set(p.title, { sheetId: p.sheetId, title: p.title, rows: p.gridProperties?.rowCount ?? 0, cols: p.gridProperties?.columnCount ?? 0 });
  }
  metaCache = { at: Date.now(), tabs: m };
  return m;
}

/** Creates the tab (bold, frozen header row) if it doesn't exist. With checkHeaders, rewrites row 1 on an existing tab. */
export async function ensureTab(title: string, headers: string[], checkHeaders = false) {
  const t = (await tabs()).get(title);
  if (!t) {
    try {
      const r = await call<any>(":batchUpdate", {
        method: "POST",
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: headers.length, frozenRowCount: 1 } } } }],
        }),
      });
      const sheetId = r?.replies?.[0]?.addSheet?.properties?.sheetId;
      if (sheetId != null) {
        await call(":batchUpdate", {
          method: "POST",
          body: JSON.stringify({
            requests: [
              {
                repeatCell: {
                  range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                  cell: { userEnteredFormat: { textFormat: { bold: true } } },
                  fields: "userEnteredFormat.textFormat.bold",
                },
              },
            ],
          }),
        });
      }
    } catch (e) {
      if (!/already exists/i.test(e instanceof Error ? e.message : "")) throw e;
    }
    await tabs(true);
    await writeRange(title, `A1:${colLetter(headers.length)}1`, [headers]);
    return;
  }
  if (checkHeaders) {
    await ensureSize(title, 1, headers.length);
    await writeRange(title, `A1:${colLetter(headers.length)}1`, [headers]);
  }
}

/** Grows the tab's grid when needed (writes outside the grid are rejected by Google). */
export async function ensureSize(title: string, rows: number, cols: number) {
  const t = (await tabs()).get(title) ?? (await tabs(true)).get(title);
  if (!t) throw new Error(`The tab "${title}" is missing from the Sheet.`);
  if (t.rows >= rows && t.cols >= cols) return;
  const rowCount = Math.max(t.rows, rows + 500);
  const columnCount = Math.max(t.cols, cols);
  await call(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: t.sheetId, gridProperties: { rowCount, columnCount } },
            fields: "gridProperties.rowCount,gridProperties.columnCount",
          },
        },
      ],
    }),
  });
  t.rows = rowCount;
  t.cols = columnCount;
}

export async function readRange(title: string, range: string): Promise<Row[]> {
  const d = await call<{ values?: Row[] }>(`/values/${enc(a1(title, range))}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
  return d.values || [];
}

export async function readRanges(title: string, ranges: string[]): Promise<Row[][]> {
  if (!ranges.length) return [];
  const q = ranges.map((r) => `ranges=${enc(a1(title, r))}`).join("&");
  const d = await call<{ valueRanges?: { values?: Row[] }[] }>(
    `/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
  return ranges.map((_, i) => d.valueRanges?.[i]?.values || []);
}

export async function writeRange(title: string, range: string, values: Row[]) {
  await call(`/values/${enc(a1(title, range))}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range: a1(title, range), majorDimension: "ROWS", values }),
  });
}

export async function writeRanges(title: string, data: { range: string; values: Row[] }[]) {
  if (!data.length) return;
  await call("/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data: data.map((d) => ({ range: a1(title, d.range), values: d.values })) }),
  });
}

export async function appendRows(title: string, rows: Row[]) {
  if (!rows.length) return;
  await call(`/values/${enc(a1(title, "A1"))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: rows }),
  });
}

export async function clearRange(title: string, range: string) {
  await call(`/values/${enc(a1(title, range))}:clear`, { method: "POST", body: "{}" });
}



/** Reads several ranges in one request. Tabs that don't exist yet come back empty. */
export async function batchRead(blocks: { title: string; range: string }[]): Promise<Row[][]> {
  const have = await tabs();
  const present = blocks.map((b, i) => ({ b, i })).filter((x) => have.has(x.b.title));
  const out: Row[][] = blocks.map(() => []);
  if (!present.length) return out;
  const q = present.map((x) => `ranges=${enc(a1(x.b.title, x.b.range))}`).join("&");
  const d = await call<{ valueRanges?: { values?: Row[] }[] }>(
    `/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
  present.forEach((x, k) => {
    out[x.i] = d.valueRanges?.[k]?.values || [];
  });
  return out;
}
