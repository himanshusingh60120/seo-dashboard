// lib/sheetBooks.ts
// One Google Sheet per property, in the same shared-drive folder as the control Sheet (or SHEETS_FOLDER_ID).
// The control Sheet's hidden _Sheets tab records which Sheet belongs to which property. A property's Sheet is created
// the first time something is saved for it (daily checks started, a weekly capture, or the first daily plan), named
// "SEO Dashboard – <property>", with one tab laid out as in lib/sheetLayout.ts. Server-only.
import { appendRows, batchUpdate, bookUrl, controlBook, ensureTab, readRange, tabs, type Book } from "./sheets";
import { assertLayout, createPropertyTab, tabFor } from "./sheetLayout";
import { createSheetFile, findSheetFile, sheetsFolder } from "./drive";

export const SHEETS_TAB = "_Sheets";
const HEADERS = ["Property", "Spreadsheet ID", "Name", "Link", "Created", "Created by"];

export type PropertySheet = { book: Book; title: string };

/** "SEO Dashboard – www.kingsresearch.com", "SEO Dashboard – martech360.com (domain)" */
export const bookName = (site: string) => `SEO Dashboard – ${tabFor(site)}`;

const s = (v: unknown) => (v == null ? "" : String(v).trim());

let reg: { at: number; map: Map<string, Book> } | null = null;

/** Property → spreadsheet ID, from the control Sheet's _Sheets tab (read at most once a minute per server instance). */
async function registry(force = false): Promise<Map<string, Book>> {
  if (!force && reg && Date.now() - reg.at < 60_000) return reg.map;
  const control = controlBook();
  const map = new Map<string, Book>();
  if ((await tabs(control, force)).has(SHEETS_TAB)) {
    for (const r of await readRange(control, SHEETS_TAB, "A2:B")) {
      const site = s(r[0]);
      const id = s(r[1]);
      if (site && id && !map.has(site)) map.set(site, id);
    }
  }
  reg = { at: Date.now(), map };
  return map;
}

/** The property's Sheet, or null if it doesn't have one yet. */
export async function findSheet(site: string, fresh = false): Promise<PropertySheet | null> {
  const id = (await registry(fresh)).get(site);
  return id ? { book: id, title: tabFor(site) } : null;
}

/** Every property that has its own Sheet. */
export async function allSheets(): Promise<{ site: string; book: Book; url: string }[]> {
  return [...(await registry())].map(([site, book]) => ({ site, book, url: bookUrl(book) }));
}

/** Removes Google's blank "Sheet1" from a new spreadsheet once the property tab is there. */
export async function removeBlankTabs(book: Book, keep: string) {
  const t = await tabs(book, true);
  if (!t.has(keep)) return;
  const extra = [...t.values()].filter((x) => x.title !== keep && /^Sheet\d+$/.test(x.title));
  if (extra.length) await batchUpdate(book, extra.map((x) => ({ deleteSheet: { sheetId: x.sheetId } })));
}

/**
 * Creates the property's Sheet in the shared drive (or reuses one with the same name already there) and records it in
 * _Sheets. With withTab, also adds the property tab and removes the blank "Sheet1".
 */
export async function createBook(site: string, by: string, withTab: boolean): Promise<PropertySheet> {
  const control = controlBook();
  const title = tabFor(site);
  const already = (await registry(true)).get(site); // another server instance may have just created it
  if (already) return { book: already, title };
  const name = bookName(site);
  const folder = await sheetsFolder(control);
  const book = (await findSheetFile(folder, name)) || (await createSheetFile(folder, name));
  if (withTab) {
    await createPropertyTab(book, title);
    await removeBlankTabs(book, title);
  }
  await ensureTab(control, SHEETS_TAB, HEADERS);
  await appendRows(control, SHEETS_TAB, [[site, book, name, bookUrl(book), new Date().toISOString(), by]]);
  reg = null;
  return { book, title };
}

const creating = new Map<string, Promise<PropertySheet>>();

/** The property's Sheet and tab, created if they don't exist yet. */
export async function propertySheet(site: string, by = ""): Promise<PropertySheet> {
  await assertLayout();
  const have = await findSheet(site);
  if (have) {
    if (!(await tabs(have.book)).has(have.title)) await createPropertyTab(have.book, have.title); // tab was deleted by hand
    return have;
  }
  let p = creating.get(site);
  if (!p) {
    p = createBook(site, by, true).finally(() => creating.delete(site));
    creating.set(site, p);
  }
  return p;
}
