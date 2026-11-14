// lib/sheets.ts
// The Google Sheets the dashboard uses as its database, through the Sheets API, signed in as the service account.
// One control Sheet (INDEX_SHEET_ID) holds the shared bookkeeping (_Jobs, _Sheets, _Updates, _Log, _Meta, _Archive, _Parts)
// and each property has its own Sheet (see lib/sheetBooks.ts). Every function takes the spreadsheet ID ("book") first.
// Values are written as-is (RAW): dates stay as text such as 2026-11-12, numbers stay numbers.
// Tabs whose name starts with "_" (technical tabs) are created hidden. Server-only.
//
// Staying inside Google's limits. Google allows 60 read and 60 write requests per minute per account, and the whole
// dashboard (every screen, the saved-history updates and the index-check jobs) shares that. So this file:
//   - paces requests: at most 55 a minute per account from this server, so bursts wait briefly instead of failing;
//   - shares identical reads that run at the same moment, and reuses a property Sheet's reads for 10 seconds
//     (any write to that Sheet clears them; the control Sheet, which holds locks and job state, is never reused);
//   - spreads reads over extra read-only service accounts when GOOGLE_SHEETS_READER_JSON is set (each has its own 60);
//   - when Google still says "too many requests", waits 2, 4, 8, 15 and 20 seconds (or as long as Google asks) and retries;
//   - logs which tabs used the requests in that minute, so the cause shows up in Vercel's logs (search for "[sheets]").
import { readerCount, serviceAccountToken, sheetsReaderToken } from "./serviceAccount";

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

/* ---------------- Staying inside Google's per-minute limits ---------------- */

type Kind = "read" | "write";
const WINDOW_MS = 60_000;
/** Requests per minute per account sent from this server (Google's limit is 60). */
const PER_MINUTE = 55;
/** Longest a request waits for room before being sent anyway (Google then decides). */
const MAX_PACE_WAIT_MS = 30_000;
/** Pauses after Google says "too many requests". */
const QUOTA_WAITS = [2_000, 4_000, 8_000, 15_000, 20_000];
/** Pauses after a Google server error. */
const SERVER_WAITS = [1_500, 3_000, 6_000, 12_000];
/** How long a property Sheet's read is reused (writes to that Sheet clear it). */
const READ_CACHE_MS = 10_000;
const READ_CACHE_MAX = 300;

/** Send times per "kind:account", for pacing. */
const sent = new Map<string, number[]>();
function recentSent(key: string) {
  const now = Date.now();
  const list = (sent.get(key) || []).filter((t) => now - t < WINDOW_MS);
  sent.set(key, list);
  return list;
}

/** Waits until this account has room for one more request this minute. */
async function pace(key: string) {
  const start = Date.now();
  for (;;) {
    const list = recentSent(key);
    if (list.length < PER_MINUTE || Date.now() - start > MAX_PACE_WAIT_MS) {
      list.push(Date.now());
      return;
    }
    await sleep(Math.max(200, Math.min(5_000, WINDOW_MS - (Date.now() - list[0]) + 50)));
  }
}

/** After a "too many requests", treat this account as full so other requests on this server wait too. */
function markFull(key: string) {
  const list = recentSent(key);
  const now = Date.now();
  while (list.length < PER_MINUTE) list.push(now);
}

/** What used the requests in the last minute, for the log line written when Google says "too many". */
const usage: { at: number; kind: Kind; label: string }[] = [];
function noteUse(kind: Kind, label: string) {
  const now = Date.now();
  usage.push({ at: now, kind, label });
  while (usage.length && now - usage[0].at > WINDOW_MS) usage.shift();
  if (usage.length > 5000) usage.splice(0, usage.length - 5000);
}
function logBusy(kind: Kind) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const u of usage) {
    if (u.kind !== kind) continue;
    total++;
    counts.set(u.label, (counts.get(u.label) || 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l, n]) => `${l} ×${n}`)
    .join(", ");
  console.warn(`[sheets] Google said too many ${kind} requests. This server sent ${total} ${kind}s in the last minute. Most: ${top || "none recorded"}`);
}

/** Reader accounts that can't open a given Sheet (no access), so reads there go to the main account. */
const noAccess = new Set<string>();

/** The account with the most room for a read on this Sheet (0 = the main service account), or -1 if all were tried. */
function pickReader(book: Book, skip: Set<number>) {
  let best = -1;
  let bestN = Infinity;
  for (let i = 0; i < readerCount(); i++) {
    if (skip.has(i) || (i > 0 && noAccess.has(`${book}:${i}`))) continue;
    const n = recentSent(`read:${i}`).length;
    if (n < bestN) {
      best = i;
      bestN = n;
    }
  }
  return best;
}

/** JSON in/out, paced, retried on "too many requests" and server errors. */
async function call<T = any>(book: Book, path: string, init: RequestInit = {}, label = ""): Promise<T> {
  const kind: Kind = !init.method || init.method === "GET" ? "read" : "write";
  const tried = new Set<number>();
  let quotaTry = 0;
  let serverTry = 0;
  for (;;) {
    let acct = 0;
    if (kind === "read") {
      acct = pickReader(book, tried);
      if (acct < 0) {
        tried.clear();
        acct = Math.max(0, pickReader(book, tried));
      }
    }
    const key = `${kind}:${acct}`;
    await pace(key);
    noteUse(kind, label || path.slice(0, 40));
    const token = acct === 0 ? await serviceAccountToken() : await sheetsReaderToken(acct);
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

    if (res.status === 429) {
      markFull(key);
      tried.add(acct);
      // Another reader account may still have room this minute.
      if (kind === "read" && pickReader(book, tried) >= 0) continue;
      if (quotaTry === 0) logBusy(kind);
      if (quotaTry < QUOTA_WAITS.length) {
        const asked = Number(res.headers.get("retry-after"));
        await sleep(asked > 0 ? Math.min(asked * 1000, 30_000) : QUOTA_WAITS[quotaTry] + Math.random() * 1000);
        quotaTry++;
        tried.clear();
        continue;
      }
      throw new Error(`Google Sheets is busy: this minute's ${kind} allowance for the dashboard's service account is used up. Wait a minute and try again.`);
    }
    // A reader account without access to this Sheet: use another account for it from now on.
    if ((res.status === 403 || res.status === 404) && acct > 0) {
      noAccess.add(`${book}:${acct}`);
      tried.add(acct);
      continue;
    }
    if (res.status >= 500 && serverTry < SERVER_WAITS.length) {
      await sleep(SERVER_WAITS[serverTry++]);
      continue;
    }
    const hint =
      res.status === 403 || res.status === 404
        ? " (check that this Sheet still exists in the shared drive and the service account can edit it)"
        : "";
    throw new Error(`Google Sheets: ${data?.error?.message || `error ${res.status}`}${hint}`);
  }
}

/* ---------------- Shared and reused reads ---------------- */

const inflight = new Map<string, Promise<unknown>>();
const readCache = new Map<string, { at: number; data: unknown }>();
const short = (book: Book) => book.slice(0, 6);

/** A read: identical reads running at the same moment share one request; property Sheets reuse it for 10 seconds. */
function read<T>(book: Book, path: string, label: string): Promise<T> {
  const key = book + path;
  const reusable = book !== process.env.INDEX_SHEET_ID;
  if (reusable) {
    const hit = readCache.get(key);
    if (hit && Date.now() - hit.at < READ_CACHE_MS) return Promise.resolve(hit.data as T);
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = call<T>(book, path, {}, label)
    .then((d) => {
      if (reusable) {
        readCache.set(key, { at: Date.now(), data: d });
        if (readCache.size > READ_CACHE_MAX) {
          const first = readCache.keys().next().value;
          if (first !== undefined) readCache.delete(first);
        }
      }
      return d;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Forgets reused reads of a Sheet after it was written to. */
function changed(book: Book) {
  for (const k of [...readCache.keys()]) if (k.startsWith(book)) readCache.delete(k);
}

/* ---------------- Helpers ---------------- */

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

/* ---------------- Tabs ---------------- */

type TabMeta = { sheetId: number; title: string; rows: number; cols: number };
const metaCache = new Map<Book, { at: number; tabs: Map<string, TabMeta> }>();
const metaInflight = new Map<Book, Promise<Map<string, TabMeta>>>();

export async function tabs(book: Book, force = false): Promise<Map<string, TabMeta>> {
  const hit = metaCache.get(book);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit.tabs;
  if (!force) {
    const running = metaInflight.get(book);
    if (running) return running;
  }
  const p = (async () => {
    const d = await call<any>(
      book,
      `?fields=${enc("sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))")}`,
      {},
      `${short(book)}/(tab list)`
    );
    const m = new Map<string, TabMeta>();
    for (const s of d.sheets || []) {
      const p2 = s.properties;
      m.set(p2.title, { sheetId: p2.sheetId, title: p2.title, rows: p2.gridProperties?.rowCount ?? 0, cols: p2.gridProperties?.columnCount ?? 0 });
    }
    metaCache.set(book, { at: Date.now(), tabs: m });
    return m;
  })().finally(() => metaInflight.delete(book));
  metaInflight.set(book, p);
  return p;
}

/** Runs spreadsheet batchUpdate requests (add, rename, hide or delete tabs, formatting). Returns Google's replies. */
export async function batchUpdate(book: Book, requests: object[]): Promise<any> {
  if (!requests.length) return { replies: [] };
  const r = await call<any>(book, ":batchUpdate", { method: "POST", body: JSON.stringify({ requests }) }, `${short(book)}/(tab changes)`);
  metaCache.delete(book); // tab names or sizes may have changed
  changed(book);
  return r;
}

/** Copies a tab, with its formatting, into another spreadsheet. Google names the copy "Copy of …". */
export async function copyTab(book: Book, sheetId: number, dest: Book): Promise<{ sheetId: number; title: string }> {
  const r = await call<any>(
    book,
    `/sheets/${sheetId}:copyTo`,
    { method: "POST", body: JSON.stringify({ destinationSpreadsheetId: dest }) },
    `${short(book)}/(copy tab)`
  );
  metaCache.delete(dest);
  changed(dest);
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

/* ---------------- Reading ---------------- */

const RENDER = "valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";

export async function readRange(book: Book, title: string, range: string): Promise<Row[]> {
  const d = await read<{ values?: Row[] }>(book, `/values/${enc(a1(title, range))}?${RENDER}`, `${short(book)}/${title}`);
  return d.values || [];
}

export async function readRanges(book: Book, title: string, ranges: string[]): Promise<Row[][]> {
  if (!ranges.length) return [];
  const q = ranges.map((r) => `ranges=${enc(a1(title, r))}`).join("&");
  const d = await read<{ valueRanges?: { values?: Row[] }[] }>(book, `/values:batchGet?${q}&${RENDER}`, `${short(book)}/${title}`);
  return ranges.map((_, i) => d.valueRanges?.[i]?.values || []);
}

/** Reads several ranges of one spreadsheet in one request. Tabs that don't exist come back empty. */
export async function batchRead(book: Book, blocks: { title: string; range: string }[]): Promise<Row[][]> {
  const have = await tabs(book);
  const present = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.title && have.has(x.b.title));
  const out: Row[][] = blocks.map(() => []);
  if (!present.length) return out;
  const q = present.map((x) => `ranges=${enc(a1(x.b.title, x.b.range))}`).join("&");
  const titles = [...new Set(present.map((x) => x.b.title))];
  const label = `${short(book)}/${titles.slice(0, 3).join(" + ")}${titles.length > 3 ? ` +${titles.length - 3}` : ""}`;
  const d = await read<{ valueRanges?: { values?: Row[] }[] }>(book, `/values:batchGet?${q}&${RENDER}`, label);
  present.forEach((x, k) => {
    out[x.i] = d.valueRanges?.[k]?.values || [];
  });
  return out;
}

/* ---------------- Writing ---------------- */

export async function writeRange(book: Book, title: string, range: string, values: Row[]) {
  await call(
    book,
    `/values/${enc(a1(title, range))}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ range: a1(title, range), majorDimension: "ROWS", values }) },
    `${short(book)}/${title}`
  );
  changed(book);
}

export async function writeRanges(book: Book, title: string, data: { range: string; values: Row[] }[]) {
  if (!data.length) return;
  await call(
    book,
    "/values:batchUpdate",
    { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: data.map((d) => ({ range: a1(title, d.range), values: d.values })) }) },
    `${short(book)}/${title}`
  );
  changed(book);
}

export async function appendRows(book: Book, title: string, rows: Row[]) {
  if (!rows.length) return;
  await call(
    book,
    `/values/${enc(a1(title, "A1"))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) },
    `${short(book)}/${title}`
  );
  changed(book);
}

export async function clearRange(book: Book, title: string, range: string) {
  await call(book, `/values/${enc(a1(title, range))}:clear`, { method: "POST", body: "{}" }, `${short(book)}/${title}`);
  changed(book);
}
