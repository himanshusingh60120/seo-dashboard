// lib/evidence.ts
"use client";
import type { Snapshot, UrlCheck, DeindexRow } from "./snapshots";
import { compare } from "./snapshots";

export function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadJson = (name: string, data: unknown) => downloadFile(name, JSON.stringify(data, null, 2), "application/json");

export const fileSafe = (s: string) => s.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_").replace(/_+$/, "");

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");
const link = (href: string | undefined, text: string) => (href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text)}</a>` : "");

/** One-line human summary of a URL's checks, with evidence links. */
function evidenceHtml(c: UrlCheck | undefined) {
  if (!c) return "<span class=m>Not checked</span>";
  const parts: string[] = [];
  const i = c.inspection;
  if (i) {
    parts.push(
      `<div><b>URL Inspection:</b> ${esc(i.verdict === "PASS" || i.verdict === "PARTIAL" ? "Indexed" : i.verdict === "ERROR" ? "Error" : "Not indexed")} – ${esc(i.coverageState)}` +
        `<br><span class=m>Checked ${esc(when(i.checkedAt))}${i.lastCrawlTime ? ` · last crawled ${esc(i.lastCrawlTime.slice(0, 10))}` : ""}</span>` +
        `${i.link ? `<br>${link(i.link, "Open in Search Console")}` : ""}</div>`
    );
  }
  const s = c.site;
  if (s) {
    parts.push(
      `<div><b>${esc(s.query)}:</b> ${s.status === "found" ? "Found" : s.status === "not_found" ? `Not found (${s.resultsReturned} other result${s.resultsReturned === 1 ? "" : "s"})` : `Error – ${esc(s.error)}`}` +
        `<br><span class=m>Checked ${esc(when(s.checkedAt))} via ${esc(s.provider)}${s.searchId ? ` · search ID ${esc(s.searchId)}` : ""}</span>` +
        `<br>${link(s.googleUrl, "Repeat this search on Google")}${s.archiveUrl ? ` · ${link(s.archiveUrl, "Saved Google results page")}` : ""}</div>`
    );
  }
  return parts.join("") || "<span class=m>No result</span>";
}

function rowsHtml(rows: DeindexRow[]) {
  if (!rows.length) return `<p class=m>None.</p>`;
  return `<table><thead><tr><th>Page</th><th>Confidence</th><th>Before</th><th>Now</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td class=u>${link(r.url, r.url)}</td><td>${esc(r.confidence)}</td><td>${evidenceHtml(r.before)}</td><td>${evidenceHtml(r.now)}</td></tr>`)
    .join("")}</tbody></table>`;
}

/** Builds a self-contained HTML report comparing two daily snapshots. */
export function reportHtml(prev: Snapshot | null, cur: Snapshot) {
  const r = compare(prev, cur);
  const property = cur.site.replace(/^sc-domain:/, "");
  const methods = cur.methods.map((m) => (m === "inspection" ? "Google Search Console URL Inspection API" : "Google site: search")).join(" and ");
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Deindexed pages – ${esc(property)} – ${esc(cur.date)}</title>
<style>
body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#17202b;max-width:1200px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.m{color:#6b7682;font-size:12.5px}table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #e1e6eb}th{border-bottom:1px solid #b9c2cb}
td.u{max-width:320px;overflow-wrap:anywhere}td div+div{margin-top:6px}a{color:#2e4c8c}
.sum{display:flex;flex-wrap:wrap;gap:0;border:1px solid #d5dbe1;border-radius:6px;margin:16px 0}
.sum div{padding:10px 16px;border-right:1px solid #e7ebef}.sum b{display:block;font-size:22px}
.note{background:#f4f6f8;border-radius:6px;padding:12px 14px;font-size:13px}
@media print{a{color:inherit}.sum{break-inside:avoid}}
</style></head><body>
<h1>Deindexed pages report</h1>
<div class=m>Property ${esc(property)} · check of ${esc(cur.date)} compared with ${prev ? esc(prev.date) : "no earlier check"} · generated ${esc(new Date().toLocaleString())}</div>
<div class=sum>
<div><b>${r.deindexed.length}</b>Deindexed</div>
<div><b>${r.possible.length}</b>Possibly deindexed</div>
<div><b>${r.newlyIndexed.length}</b>Newly indexed</div>
<div><b>${r.stillIndexed}</b>Still indexed</div>
<div><b>${Object.keys(cur.checks).length}</b>Pages checked</div>
</div>
<div class=note><b>How this was checked.</b> Each page was checked with ${esc(methods)}.
The site: search is <code>site:</code> followed immediately by the full page URL; a page counts as found only when that exact URL appears in the results.
A page is listed as deindexed when at least one check found it indexed on ${prev ? esc(prev.date) : "the earlier day"} and a check on ${esc(cur.date)} found it not indexed.
When the two checks disagree today it is listed under “possibly deindexed”. Search Console's URL Inspection is Google's own record for the property and is the stronger evidence; site: results can vary by location and time.
Every row links to Search Console, to the same Google search, and (where available) to a saved copy of Google's results page.</div>
<h2>Deindexed (${r.deindexed.length})</h2>${rowsHtml(r.deindexed)}
<h2>Possibly deindexed – checks disagree (${r.possible.length})</h2>${rowsHtml(r.possible)}
<h2>Newly indexed (${r.newlyIndexed.length})</h2>${rowsHtml(r.newlyIndexed)}
${r.notRechecked ? `<p class=m>${r.notRechecked} page(s) indexed on ${esc(prev?.date)} were not re-checked on ${esc(cur.date)} (daily limit), so they are not in this report.</p>` : ""}
</body></html>`;
}

/** Flat CSV rows with evidence columns. */
export function reportCsvRows(rows: DeindexRow[], prevDate: string, curDate: string) {
  return rows.map((r) => ({
    url: r.url,
    confidence: r.confidence,
    compared_with: prevDate,
    checked_on: curDate,
    before_inspection: r.before.inspection ? `${r.before.inspection.verdict} – ${r.before.inspection.coverageState}` : "",
    before_inspection_checked_at: r.before.inspection?.checkedAt || "",
    before_site_search: r.before.site?.status || "",
    before_site_checked_at: r.before.site?.checkedAt || "",
    before_site_archive: r.before.site?.archiveUrl || "",
    now_inspection: r.now.inspection ? `${r.now.inspection.verdict} – ${r.now.inspection.coverageState}` : "",
    now_inspection_checked_at: r.now.inspection?.checkedAt || "",
    now_last_crawled: r.now.inspection?.lastCrawlTime || "",
    now_search_console_link: r.now.inspection?.link || "",
    now_site_query: r.now.site?.query || "",
    now_site_search: r.now.site?.status || "",
    now_site_checked_at: r.now.site?.checkedAt || "",
    now_site_google_url: r.now.site?.googleUrl || "",
    now_site_archive: r.now.site?.archiveUrl || "",
    now_site_provider: r.now.site?.provider || "",
  }));
}
