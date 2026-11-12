// lib/sheetMigrate.ts
// One-time move to one Google Sheet per property. Until now every property had a tab inside the control Sheet
// (INDEX_SHEET_ID). Each such tab is copied, with its colours and formatting, into the property's own Sheet
// ("SEO Dashboard – <property>", created in the same shared-drive folder). The copy is checked row by row count,
// then the original is hidden in the control Sheet and renamed "<tab> (moved)". Nothing is deleted.
// Runs at the start of the hourly plan job. Server-only.
import { batchRead, batchUpdate, controlBook, copyTab, ensureTab, readRange, safeTitle, tabs, writeRange, type Row } from "./sheets";
import { FIRST_ROW, META_TAB, MOVED_SUFFIX, SEC, controlPropertyTabs, layoutReady, markLayoutReady, tabFor } from "./sheetLayout";
import { createBook, findSheet, removeBlankTabs } from "./sheetBooks";
import { writeOverview } from "./overview";

const s = (v: unknown) => (v == null ? "" : String(v).trim());
const README = "Read me";

/** Moves every property tab in the control Sheet into its own Sheet, if that hasn't happened yet. Returns a short note. */
export async function migrateIfNeeded(): Promise<string> {
  if (await layoutReady()) return "";
  const control = controlBook();
  await ensureTab(control, META_TAB, ["Key", "Value"]);
  const meta = await readRange(control, META_TAB, "A2:B3");
  const lockAt = Date.parse(s(meta[1]?.[1]));
  if (!isNaN(lockAt) && Date.now() - lockAt < 10 * 60_000) return "The Sheets are already being reorganised.";
  await writeRange(control, META_TAB, "A2:B3", [["layout", s(meta[0]?.[1])], ["migrating", new Date().toISOString()]]);

  try {
    // Keep one visible tab in the control Sheet (Google won't hide the last one).
    await ensureTab(control, README, [
      "This is the dashboard's control Sheet. Each property's data is in its own Sheet in this shared drive; the list is in the hidden _Sheets tab (View → Hidden sheets).",
    ]);

    const titles = await controlPropertyTabs();
    const [jobs, updates] = await batchRead(control, [
      { title: "_Jobs", range: "A2:A" },
      { title: "_Updates", range: "B2:B" },
    ]);
    const siteOf = new Map<string, string>();
    for (const r of [...jobs, ...updates]) {
      const site = s(r[0]);
      if (site && !siteOf.has(tabFor(site))) siteOf.set(tabFor(site), site);
    }

    const moved: string[] = [];
    const skipped: string[] = [];
    for (const t of titles) {
      const site = siteOf.get(t);
      if (!site) {
        skipped.push(t);
        continue;
      }
      await moveToOwnSheet(site, t);
      moved.push(site);
    }

    await markLayoutReady();
    for (const site of moved) await writeOverview(site).catch(() => {});
    const notes = [
      moved.length ? `Moved ${moved.length} propert${moved.length === 1 ? "y" : "ies"} into its own Google Sheet: ${moved.join(", ")}.` : "Sheet layout updated.",
      skipped.length ? `Left in the control Sheet (no matching property found): ${skipped.join(", ")}.` : "",
    ];
    return notes.filter(Boolean).join(" ");
  } catch (e) {
    await writeRange(control, META_TAB, "A3:B3", [["migrating", ""]]).catch(() => {});
    throw e;
  }
}

async function moveToOwnSheet(site: string, title: string) {
  const control = controlBook();
  const src = (await tabs(control, true)).get(title);
  if (!src) return;
  const ref = (await findSheet(site, true)) || (await createBook(site, "Moved from the control Sheet", false));
  const book = ref.book;

  // Copy the whole tab (values, colours, formats), then give it the property's tab name.
  const copy = await copyTab(control, src.sheetId, book);
  const dest = await tabs(book, true);
  const req: object[] = [];
  const stale = dest.get(title); // left over from an interrupted earlier attempt
  if (stale && stale.sheetId !== copy.sheetId) req.push({ deleteSheet: { sheetId: stale.sheetId } });
  req.push({
    updateSheetProperties: {
      properties: { sheetId: copy.sheetId, title, index: 0, gridProperties: { frozenRowCount: 2 } },
      fields: "title,index,gridProperties.frozenRowCount",
    },
  });
  await batchUpdate(book, req);
  await removeBlankTabs(book, title);

  // Check the URL list arrived complete before hiding the original.
  const range = `${SEC.urls.L}${FIRST_ROW}:${SEC.urls.L}`;
  const [before] = await batchRead(control, [{ title, range }]);
  const [after] = await batchRead(book, [{ title, range }]);
  const count = (rows: Row[]) => rows.filter((r) => s(r[0])).length;
  if (count(before) !== count(after)) {
    throw new Error(
      `Moving ${site}: expected ${count(before)} URL rows in its new Sheet, found ${count(after)}. The original tab was left in place; it retries with the next hourly run.`
    );
  }

  await batchUpdate(control, [
    {
      updateSheetProperties: {
        properties: { sheetId: src.sheetId, title: safeTitle(`${title.slice(0, 85)}${MOVED_SUFFIX}`), hidden: true },
        fields: "title,hidden",
      },
    },
  ]);
}
