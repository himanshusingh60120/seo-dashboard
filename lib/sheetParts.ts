// lib/sheetParts.ts
// Room to grow for the saved history. Google Sheets allows 10 million cells per spreadsheet, so big monthly lists
// (Search Console pages and queries, GA4 breakdowns, AI pages) each get a tab of their own, e.g. "Search · 2026-11".
// New tabs go into the property's own Sheet until it nears the limit; then a continuation Sheet is created
// automatically ("SEO Dashboard – <property> · part 2", then part 3, …) in the same shared-drive folder and recorded in
// the control Sheet's hidden _Parts tab. Everything that reads the history looks through every part, so data in older
// Sheets keeps being used. Server-only.
import {
  appendRows, batchRead, batchUpdate, bookUrl, clearRange, colLetter, controlBook, ensureTab, readRange, tabs, writeRange,
  type Book, type Row,
} from "./sheets";
import { bookName, findSheet, propertySheet, removeBlankTabs } from "./sheetBooks";
import { createSheetFile, findSheetFile, sheetsFolder } from "./drive";

export const PARTS_TAB = "_Parts";
/** Monthly AI page lists (written by lib/reportStore.ts). */
export const AI_PAGES_PREFIX = "AI pages · ";
const HEADERS = ["Property", "Part", "Spreadsheet ID", "Name", "Link", "Created"];
/** Google's limit is 10,000,000 cells. The property's own Sheet keeps room for its URL list to grow. */
const MAIN_LIMIT = 6_000_000;
const PART_LIMIT = 9_500_000;
const HARD_LIMIT = 9_900_000;
const CHUNK = 5000;

const s = (v: unknown) => (v == null ? "" : String(v).trim());

export type Part = { part: number; book: Book; url: string };

let reg: { at: number; rows: Row[] } | null = null;

async function partRows(fresh: boolean): Promise<Row[]> {
  if (!fresh && reg && Date.now() - reg.at < 60_000) return reg.rows;
  const control = controlBook();
  await ensureTab(control, PARTS_TAB, HEADERS);
  const rows = await readRange(control, PARTS_TAB, "A2:C");
  reg = { at: Date.now(), rows };
  return rows;
}

/**
 * The property's Sheets in order: its own Sheet (part 1), then continuation Sheets. With create, the property's own
 * Sheet is created if it doesn't exist yet; without, a property with no Sheet has no parts.
 */
export async function partsOf(site: string, fresh = false, create = false): Promise<Part[]> {
  const main = create ? await propertySheet(site, "Saved history") : await findSheet(site, fresh);
  if (!main) return [];
  const out: Part[] = [{ part: 1, book: main.book, url: bookUrl(main.book) }];
  const extra = (await partRows(fresh))
    .filter((r) => s(r[0]) === site && s(r[2]) && Number(r[1]) >= 2)
    .map((r) => ({ part: Number(r[1]), book: s(r[2]), url: bookUrl(s(r[2])) }))
    .sort((a, b) => a.part - b.part);
  for (const p of extra) if (!out.some((x) => x.book === p.book)) out.push(p);
  return out;
}

/** Cells a spreadsheet has allocated (rows × columns of every tab): what Google's limit counts. */
async function usedCells(book: Book): Promise<number> {
  let total = 0;
  for (const t of (await tabs(book, true)).values()) total += t.rows * t.cols;
  return total;
}

async function createPart(site: string, part: number): Promise<Part> {
  const control = controlBook();
  const name = `${bookName(site)} · part ${part}`;
  const folder = await sheetsFolder(control);
  const book = (await findSheetFile(folder, name)) || (await createSheetFile(folder, name));
  await ensureTab(control, PARTS_TAB, HEADERS);
  await appendRows(control, PARTS_TAB, [[site, part, book, name, bookUrl(book), new Date().toISOString()]]);
  reg = null;
  return { part, book, url: bookUrl(book) };
}

const creating = new Map<string, Promise<Part>>();

/** The newest part with room for this many cells, or a new part. */
async function placeFor(site: string, cells: number): Promise<Part> {
  const parts = await partsOf(site, true, true);
  const last = parts[parts.length - 1];
  const limit = last.part === 1 ? MAIN_LIMIT : PART_LIMIT;
  if ((await usedCells(last.book)) + cells <= limit) return last;
  const key = `${site}|${last.part + 1}`;
  let p = creating.get(key);
  if (!p) {
    p = createPart(site, last.part + 1).finally(() => creating.delete(key));
    creating.set(key, p);
  }
  return p;
}

/** The part a tab is in, if any part has it. */
export async function findTab(site: string, name: string, create = false): Promise<Part | null> {
  for (const p of await partsOf(site, false, create)) if ((await tabs(p.book)).has(name)) return p;
  return null;
}

/**
 * Writes a whole tab (header row + data), replacing what was there. A tab stays in the part it's already in; a new
 * tab goes to the newest part with room. The grid is sized to the data, so no cells are wasted.
 */
export async function writeTab(site: string, name: string, header: Row, rows: Row[]): Promise<Part> {
  let cols = Math.max(1, header.length);
  for (const r of rows) if (r.length > cols) cols = r.length;
  const rowCount = rows.length + 2; // header, data, one spare row
  const cells = rowCount * cols;

  let part = await findTab(site, name, true);
  if (part) {
    const old = (await tabs(part.book, true)).get(name);
    if (old && (await usedCells(part.book)) - old.rows * old.cols + cells > HARD_LIMIT) {
      // Grown too big for the Sheet it's in: move it to a part with room.
      await batchUpdate(part.book, [{ deleteSheet: { sheetId: old.sheetId } }]);
      part = null;
    }
  }
  if (!part) part = await placeFor(site, cells);
  const book = part.book;

  const t = (await tabs(book, true)).get(name);
  const grid = { rowCount, columnCount: cols, frozenRowCount: 1 };
  if (!t) {
    const r = await batchUpdate(book, [{ addSheet: { properties: { title: name, gridProperties: grid } } }]);
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
  } else {
    await clearRange(book, name, `A1:${colLetter(t.cols)}${t.rows}`);
    await batchUpdate(book, [
      {
        updateSheetProperties: {
          properties: { sheetId: t.sheetId, gridProperties: grid },
          fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
        },
      },
    ]);
  }
  const L = colLetter(cols);
  await writeRange(book, name, `A1:${L}1`, [header]);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await writeRange(book, name, `A${2 + i}:${L}${1 + i + chunk.length}`, chunk);
  }
  if (part.part > 1) await removeBlankTabs(book, name);
  return part;
}

/** Reads a range of a tab, in whichever part it is; null if no part has it. */
export async function readTab(site: string, name: string, range = "A1:Z"): Promise<Row[] | null> {
  const p = await findTab(site, name);
  return p ? readRange(p.book, name, range) : null;
}

/** Every tab whose name starts with prefix, across all parts, sorted by name. */
export async function listTabs(site: string, prefix: string): Promise<{ name: string; part: Part }[]> {
  const out: { name: string; part: Part }[] = [];
  for (const p of await partsOf(site)) {
    for (const name of (await tabs(p.book)).keys()) if (name.startsWith(prefix)) out.push({ name, part: p });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The same range from many tabs, a few requests per Sheet. */
export async function readTabs(items: { name: string; part: Part }[], range: string): Promise<Map<string, Row[]>> {
  const byBook = new Map<Book, string[]>();
  for (const it of items) byBook.set(it.part.book, [...(byBook.get(it.part.book) || []), it.name]);
  const out = new Map<string, Row[]>();
  for (const [book, names] of byBook) {
    for (let i = 0; i < names.length; i += 40) {
      const some = names.slice(i, i + 40);
      const got = await batchRead(book, some.map((title) => ({ title, range })));
      some.forEach((name, k) => out.set(name, got[k] || []));
    }
  }
  return out;
}
