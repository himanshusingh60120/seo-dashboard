// lib/overview.ts
// The "Overview" section at the left of each property's tab: the key numbers, and who updated each weekly report and
// when. Rewritten after every daily plan, every check run and every weekly capture. Server-only.
import { batchRead, tabs, type Row } from "./sheets";
import { sectionRange, tabFor, writeSection } from "./sheetLayout";
import { IDX_LABEL } from "./indexStats";
import { addDays } from "./dates";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const s = (v: unknown) => (v == null ? "" : String(v).trim());
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const stamp = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC` : "");

export async function writeOverview(site: string) {
  const title = tabFor(site);
  if (!(await tabs()).has(title)) return;
  const [sm, pages, crawl, ai, log] = await batchRead([
    { title, range: sectionRange("sitemaps") },
    { title, range: sectionRange("pages") },
    { title, range: sectionRange("crawl") },
    { title, range: sectionRange("ai") },
    { title: "_Updates", range: "A2:I" },
  ]);

  // URL checks (from the per-sitemap summary).
  let urls = 0, indexed = 0, notIndexed = 0, unchecked = 0;
  for (const r of sm) {
    if (!s(r[0]) || !n(r[1])) continue;
    urls += n(r[1]);
    indexed += n(r[3]);
    notIndexed += n(r[4]);
    unchecked += n(r[5]) + n(r[6]);
  }

  // Google's own count: latest day of "All known pages".
  const known = pages
    .filter((r) => s(r[0]) === IDX_LABEL.ALL_URLS && DATE.test(s(r[1])))
    .sort((a, b) => s(a[1]).localeCompare(s(b[1])));
  const g = known[known.length - 1];

  // Crawl requests, last 7 saved days (All crawl requests, or Refresh + Discovery).
  const perDay = new Map<string, { total: number | null; split: number }>();
  for (const r of crawl) {
    const key = s(r[0]);
    const d = s(r[2]);
    if (!DATE.test(d)) continue;
    const e = perDay.get(d) || { total: null, split: 0 };
    if (key === "total") e.total = n(r[3]);
    else if (key === "refresh" || key === "discovery") e.split += n(r[3]);
    perDay.set(d, e);
  }
  const cDates = [...perDay.keys()].sort();
  const cLatest = cDates[cDates.length - 1] || "";
  const crawl7 = cLatest
    ? cDates.filter((d) => d > addDays(cLatest, -7)).reduce((t, d) => t + (perDay.get(d)!.total ?? perDay.get(d)!.split), 0)
    : 0;

  // AI impressions, last 28 saved days.
  const aiDays = ai.filter((r) => DATE.test(s(r[0])));
  const aLatest = aiDays.map((r) => s(r[0])).sort().pop() || "";
  const ai28 = aLatest ? aiDays.filter((r) => s(r[0]) > addDays(aLatest, -28)).reduce((t, r) => t + n(r[1]), 0) : 0;

  // Who updated each weekly report, and when.
  const last: Record<string, Row> = {};
  for (const r of log) {
    if (s(r[1]) !== site) continue;
    const rep = s(r[2]);
    if (s(r[4]) === "Deleted") {
      delete last[rep];
      continue;
    }
    last[rep] = r;
  }
  const updated = (rep: string): Row => {
    const r = last[rep];
    return r ? [`${rep} updated`, stamp(s(r[0])), s(r[3]) ? `by ${s(r[3])}` : ""] : [`${rep} updated`, "Not yet", ""];
  };

  const rows: Row[] = [
    ["URLs tracked", urls, "in your sitemaps or seen in search"],
    ["Indexed", indexed, "confirmed by Google's URL Inspection"],
    ["Not indexed", notIndexed, "confirmed by Google's URL Inspection"],
    ["Not checked yet", unchecked, "waiting for their URL Inspection"],
    ["", "", ""],
    ["Google's own count: indexed", g ? n(g[2]) : "", g ? `Page indexing report, ${s(g[1])}` : "no weekly capture yet"],
    ["Google's own count: not indexed", g ? n(g[3]) : "", g ? `of ${(n(g[2]) + n(g[3])).toLocaleString("en-US")} pages Google knows` : ""],
    ["Crawl requests, last 7 days", cLatest ? crawl7 : "", cLatest ? `up to ${cLatest}` : "no crawl stats yet"],
    ["AI impressions, last 28 days", aLatest ? ai28 : "", aLatest ? `up to ${aLatest}` : "no AI data yet"],
    ["", "", ""],
    updated("Page indexing"),
    updated("Crawl stats"),
    updated("AI impressions"),
    ["Overview updated", stamp(new Date().toISOString()), ""],
  ];
  await writeSection(title, "overview", rows);
}
