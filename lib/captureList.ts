// lib/captureList.ts
// Properties added to the weekly Search Console captures from the dashboard ("Capture this property now"), kept in the
// control Sheet's hidden _Captures tab. The Chrome extension captures these plus every property with daily index
// checks turned on. Server-only.
import { appendRows, controlBook, ensureTab, readRange } from "./sheets";

export const CAPTURES_TAB = "_Captures";
const HEADERS = ["Property", "Added by", "Added at"];
const s = (v: unknown) => (v == null ? "" : String(v).trim());

let cache: { at: number; sites: string[] } | null = null;

/** Every property on the weekly capture list (read at most once a minute per server instance). */
export async function captureList(fresh = false): Promise<string[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.sites;
  const control = controlBook();
  await ensureTab(control, CAPTURES_TAB, HEADERS);
  const rows = await readRange(control, CAPTURES_TAB, "A2:A");
  const sites = Array.from(new Set(rows.map((r) => s(r[0])).filter(Boolean)));
  cache = { at: Date.now(), sites };
  return sites;
}

/** Adds a property to the list. Returns false if it was already there. */
export async function addToCaptureList(site: string, by: string): Promise<boolean> {
  if ((await captureList(true)).includes(site)) return false;
  await appendRows(controlBook(), CAPTURES_TAB, [[site, by, new Date().toISOString()]]);
  cache = null;
  return true;
}
