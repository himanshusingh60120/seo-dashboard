// lib/sheetMigrate.ts
// One-time move from the old layout (one tab per data type: "<property>" URL list, "<property> · Pages report",
// "· Crawl stats", "· AI impressions"…, plus _Sitemaps and _Changes) to ONE tab per property with colour-coded sections.
// Runs at the start of the hourly plan job. For each property it builds the new tab under a temporary name, copies
// every section, checks the URL list arrived complete, then swaps the names. Old tabs are hidden, never deleted.
// Server-only.
import { batchRead, batchUpdate, ensureTab, readRange, safeTitle, tabs, writeRange, type Row } from "./sheets";
import { META_TAB, SEC, FIRST_ROW, createPropertyTab, layoutReady, markLayoutReady, tabFor, writeSection } from "./sheetLayout";
import { writeOverview } from "./overview";

const OLD_SUFFIX = {
  pages: " · Pages report",
  reasons: " · Not-indexed reasons",
  crawl: " · Crawl stats",
  crawlUrls: " · Crawled URLs",
  ai: " · AI impressions",
  aiSplit: " · AI breakdowns",
} as const;
const TECH_TABS = ["_Jobs", "_Log", "_Updates", "_Sitemaps", "_Changes", META_TAB];

const s = (v: unknown) => (v == null ? "" : String(v).trim());

/** Moves every property to the one-tab layout if that hasn't happened yet. Returns a short note. */
export async function migrateIfNeeded(): Promise<string> {
  if (await layoutReady()) return "";
  await ensureTab(META_TAB, ["Key", "Value"]);
  const meta = await readRange(META_TAB, "A2:B3");
  const lockAt = Date.parse(s(meta[1]?.[1]));
  if (!isNaN(lockAt) && Date.now() - lockAt < 10 * 60_000) return "The Sheet is already being reorganised.";
  await writeRange(META_TAB, "A2:B3", [["layout", ""], ["migrating", new Date().toISOString()]]);

  try {
    const have = await tabs(true);
    const [jobRows, updRows, smRows, chRows] = await batchRead([
      { title: "_Jobs", range: "A2:J" },
      { title: "_Updates", range: "B2:B" },
      { title: "_Sitemaps", range: "A2:J" },
      { title: "_Changes", range: "A2:G" },
    ]);
    const sites = new Set<string>();
    for (const r of jobRows) if (s(r[0])) sites.add(s(r[0]));
    for (const r of updRows) if (s(r[0])) sites.add(s(r[0]));

    const moved: string[] = [];
    for (const site of sites) {
      if (await migrateSite(site, have, jobRows, smRows, chRows)) moved.push(site);
    }

    // Hide the technical tabs and the old tabs (nothing is deleted).
    const now = await tabs(true);
    const hide = [...now.values()].filter(
      (t) => TECH_TABS.includes(t.title) || t.title.endsWith(" (old)") || Object.values(OLD_SUFFIX).some((suf) => t.title.endsWith(suf))
    );
    const keepOneVisible = hide.length >= now.size ? hide.filter((t) => t.title !== "_Jobs") : hide;
    if (keepOneVisible.length) {
      await batchUpdate(keepOneVisible.map((t) => ({ updateSheetProperties: { properties: { sheetId: t.sheetId, hidden: true }, fields: "hidden" } })));
    }

    await markLayoutReady();
    for (const site of moved) await writeOverview(site).catch(() => {});
    return moved.length ? `Moved ${moved.length} propert${moved.length === 1 ? "y" : "ies"} into the one-tab layout.` : "Sheet layout updated.";
  } catch (e) {
    await writeRange(META_TAB, "A3:B3", [["migrating", ""]]).catch(() => {});
    throw e;
  }
}

async function migrateSite(
  site: string,
  have: Map<string, { sheetId: number; title: string }>,
  jobRows: Row[],
  smRows: Row[],
  chRows: Row[]
): Promise<boolean> {
  const name = tabFor(site);
  const base = name.slice(0, 70);
  let oldUrl = have.has(name) ? name : "";
  if (oldUrl) {
    const a1 = s((await readRange(name, "A1:A1"))[0]?.[0]);
    if (a1 === SEC.overview.title) return false; // already in the new layout
    if (a1 !== "URL") oldUrl = ""; // not one of ours
  }
  const old = Object.fromEntries(
    Object.entries(OLD_SUFFIX).map(([k, suf]) => [k, have.has(base + suf) ? base + suf : ""])
  ) as Record<keyof typeof OLD_SUFFIX, string>;
  const mySitemaps = smRows.filter((r) => s(r[0]) === site).map((r) => r.slice(1));
  const myChanges = chRows.filter((r) => s(r[1]) === site).map((r) => [r[0], r[2], r[3], r[4], r[5], r[6]]);
  if (!oldUrl && !Object.values(old).some(Boolean) && !mySitemaps.length && !myChanges.length) return false;

  const [urls, pages, reasons, crawl, crawlUrls, ai, aiSplit] = await batchRead([
    { title: oldUrl, range: "A2:P" },
    { title: old.pages, range: "A2:E" },
    { title: old.reasons, range: "A2:F" },
    { title: old.crawl, range: "A2:F" },
    { title: old.crawlUrls, range: "A2:C" },
    { title: old.ai, range: "A2:B" },
    { title: old.aiSplit, range: "A2:H" },
  ]);

  // Build the new tab under a temporary name.
  const tmp = safeTitle(`${name.slice(0, 85)} (new)`);
  let cur = await tabs(true);
  if (cur.has(tmp)) await batchUpdate([{ deleteSheet: { sheetId: cur.get(tmp)!.sheetId } }]); // left over from an interrupted move
  await createPropertyTab(tmp, urls.length + 10);
  await writeSection(tmp, "urls", urls);
  await writeSection(tmp, "pages", pages);
  await writeSection(tmp, "reasons", reasons);
  await writeSection(tmp, "crawl", crawl);
  await writeSection(tmp, "crawlUrls", crawlUrls);
  await writeSection(tmp, "ai", ai);
  await writeSection(tmp, "aiSplit", aiSplit);
  await writeSection(tmp, "sitemaps", mySitemaps);
  await writeSection(tmp, "changes", myChanges);

  // Check the URL list arrived complete before switching.
  const expected = urls.filter((r) => s(r[0])).length;
  const copied = (await readRange(tmp, `${SEC.urls.L}${FIRST_ROW}:${SEC.urls.L}`)).filter((r) => s(r[0])).length;
  if (copied !== expected) {
    throw new Error(`Moving ${site}: expected ${expected} URL rows, found ${copied}. Nothing was switched; it will retry with the next hourly run.`);
  }

  // Swap: old URL tab → "<name> (old)" (hidden), new tab → "<name>".
  cur = await tabs(true);
  const req: object[] = [];
  if (oldUrl && cur.has(oldUrl)) {
    let oldName = safeTitle(`${name.slice(0, 85)} (old)`);
    if (cur.has(oldName)) oldName = safeTitle(`${name.slice(0, 80)} (old ${Date.now() % 1000})`);
    req.push({ updateSheetProperties: { properties: { sheetId: cur.get(oldUrl)!.sheetId, title: oldName, hidden: true }, fields: "title,hidden" } });
  }
  req.push({ updateSheetProperties: { properties: { sheetId: cur.get(tmp)!.sheetId, title: name }, fields: "title" } });
  await batchUpdate(req);
  await tabs(true);

  // Today's queue holds row numbers: data now starts on row 3 instead of row 2.
  const ji = jobRows.findIndex((r) => s(r[0]) === site);
  if (ji >= 0 && s(jobRows[ji][9])) {
    const q = s(jobRows[ji][9])
      .split(",")
      .map((x) => Math.floor(Number(x)))
      .filter((x) => x >= 2)
      .map((x) => x + 1);
    await writeRange("_Jobs", `J${ji + 2}:J${ji + 2}`, [[q.join(",")]]);
  }
  return true;
}
