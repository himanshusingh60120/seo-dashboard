// lib/indexSheet.ts
// Server-only. Reads Google's URL Inspection results that the daily index checks (lib/indexJob.ts) saved in the
// property's own Sheet ("URL checks" section), a page of rows at a time. Other tabs use these instead of running
// URL Inspection themselves, so they never spend Google's daily inspection quota.
import { readRange } from "./sheets";
import { FIRST_ROW, SEC } from "./sheetLayout";
import { findSheet } from "./sheetBooks";
import { readJobs, type PlanStats } from "./indexJob";

/** [URL, status ("Indexed" | "Not indexed" | "" = no result yet), Google's reason, page fetch, last crawled,
 *  Google canonical, last inspected, in a sitemap (1 / 0), sitemap file] */
export type IndexRow = [string, string, string, string, string, string, string, number, string];

export type IndexResults = {
  configured: boolean;
  rows: IndexRow[];
  /** Offset to ask for next. */
  next: number;
  done: boolean;
  job: { enabled: boolean; planDay: string; runAs: string; stats: PlanStats | null } | null;
};

/** Sheet rows per request: small enough to stay well under Vercel's 4.5 MB response limit. */
export const PAGE_ROWS = 4000;

const s = (v: unknown) => (v == null ? "" : String(v).trim());

export async function readIndexPage(site: string, offset: number): Promise<IndexResults> {
  const ref = await findSheet(site);
  if (!ref) return { configured: false, rows: [], next: offset, done: true, job: null };
  const sec = SEC.urls;
  const start = FIRST_ROW + Math.max(0, Math.floor(offset));
  const raw = await readRange(ref.book, ref.title, `${sec.L}${start}:${sec.R}${start + PAGE_ROWS - 1}`);
  const rows: IndexRow[] = [];
  for (const r of raw) {
    const url = s(r[0]);
    const source = s(r[2]);
    if (!url || source === "No longer listed") continue;
    const status = s(r[4]);
    const checked = s(r[5]) === "URL Inspection" && (status === "Indexed" || status === "Not indexed");
    rows.push([
      url,
      checked ? status : "",
      checked ? s(r[6]) : "",
      checked ? s(r[7]) : "",
      checked ? s(r[8]) : "",
      checked ? s(r[9]) : "",
      checked ? s(r[10]) : "",
      source.startsWith("Sitemap") ? 1 : 0,
      s(r[1]),
    ]);
  }
  let job: IndexResults["job"] = null;
  if (offset === 0) {
    const j = (await readJobs().catch(() => [])).find((x) => x.site === site);
    if (j) job = { enabled: j.enabled, planDay: j.planDay, runAs: j.runAs, stats: j.stats };
  }
  const configured = offset > 0 || rows.length > 0 || !!job;
  return { configured, rows, next: offset + raw.length, done: raw.length < PAGE_ROWS, job };
}
