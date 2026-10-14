// lib/evidence.ts
"use client";
// Downloads and self-contained HTML reports (index changes, GSC audit).
import { EVENT_LABEL, type IndexEvent } from "./indexCache";
import { CATALOG, STATUS_LABEL, type IssueGroup, type Solution } from "./audit/catalog";
import type { Range } from "./dates";

export function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadJson = (name: string, data: unknown) => downloadFile(name, JSON.stringify(data, null, 2), "application/json");

export const fileSafe = (s: string) =>
  s.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_").replace(/_+$/, "");

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const safeHref = (h: string) => (/^https?:\/\//i.test(h) ? h : "#");
const link = (href: string, text: string) => `<a href="${esc(safeHref(href))}" target="_blank" rel="noreferrer">${esc(text)}</a>`;
const cell = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) ? link(v, v) : esc(v ?? ""));

function page(title: string, body: string) {
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#17202b;max-width:1200px;margin:32px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 6px}h3{font-size:14px;margin:14px 0 4px}
.m{color:#6b7682;font-size:12.5px}table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
th,td{text-align:left;vertical-align:top;padding:6px;border-bottom:1px solid #e1e6eb}td{overflow-wrap:anywhere;max-width:420px}
a{color:#2e4c8c}.note{background:#f4f6f8;border-radius:6px;padding:10px 12px}section{border-top:1px solid #d5dbe1;margin-top:20px}
.sev{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;color:#fff}.critical,.high{background:#b42318}.medium{background:#b54708}.low{background:#475467}
</style></head><body>${body}</body></html>`;
}

export function eventsReportHtml(site: string, events: IndexEvent[], days: number) {
  const rows = events
    .map((e) => `<tr><td>${esc(new Date(e.at).toLocaleString())}</td><td>${esc(EVENT_LABEL[e.type])}</td><td>${link(e.url, e.url)}</td><td>${esc(e.from)}</td><td>${esc(e.to)}</td><td>${e.link ? link(e.link, "Search Console") : ""}</td></tr>`)
    .join("");
  return page(
    `Index changes – ${site}`,
    `<h1>Index status changes</h1><div class=m>Property ${esc(site)} · last ${days} days · generated ${esc(new Date().toLocaleString())}</div>
<p class=note>Each row compares two Google URL Inspection results for the same URL: the earlier one and the newer one. “Dropped from Google's index” means the earlier result said the URL was on Google and the newer one says it isn't. Failed checks are never counted as drops.</p>
<table><thead><tr><th>When</th><th>Change</th><th>URL</th><th>Before</th><th>After</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=6>No changes in this window.</td></tr>"}</tbody></table>`
  );
}

export function auditReportHtml(a: {
  site: string;
  window: { days: number; current: Range; previous: Range; dataThrough?: string } | null;
  groups: IssueGroup[];
  sols: Record<string, Solution>;
}) {
  const count = (s: string) => a.groups.filter((g) => g.severity === s).length;
  const list = (xs: string[], tag = "ul") => (xs.length ? `<${tag}>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</${tag}>` : "");
  const sections = a.groups
    .map((g) => {
      const c = CATALOG[g.type];
      const s = a.sols[g.fingerprint];
      const fix = s && s.status !== "error" ? s : null;
      const cols = g.evidence.length ? Object.keys(g.evidence[0]) : [];
      const ev = cols.length
        ? `<table><thead><tr>${cols.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>${g.evidence
            .map((r) => `<tr>${cols.map((k) => `<td>${cell(r[k])}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`
        : "";
      const body = fix
        ? `<p><b>${esc(STATUS_LABEL[fix.status])}</b> — ${esc(fix.summary)}</p><h3>Likely causes</h3>${list(fix.causes)}<h3>Fix</h3>${list(fix.steps, "ol")}<h3>Confirm the fix</h3>${list(fix.verify)}<h3>Checks run on this answer</h3><ul>${fix.checks
            .map((k) => `<li>${k.passed ? "✔" : "✖"} ${esc(k.name)} — ${esc(k.detail)}</li>`)
            .join("")}</ul>`
        : `<p><b>Standard fix</b>${s?.status === "error" ? ` (AI failed: ${esc(s.summary)})` : ""}</p><h3>Likely causes</h3>${list(c.causes)}<h3>Fix</h3>${list(c.steps, "ol")}<h3>Confirm the fix</h3>${list(c.verify)}`;
      return `<section><h2><span class="sev ${g.severity}">${g.severity}</span> ${esc(g.title)}</h2><div class=m>${g.count.toLocaleString()} affected · ${esc(g.category)} · source: ${esc(g.source)}</div><p>${esc(c.what)}</p>${body}${c.doc ? `<p>${link(c.doc, "Google documentation")}</p>` : ""}<h3>Evidence (first ${g.evidence.length} of ${g.count.toLocaleString()})</h3>${ev}</section>`;
    })
    .join("");
  const w = a.window;
  return page(
    `GSC audit – ${a.site}`,
    `<h1>Search Console audit</h1><div class=m>Property ${esc(a.site)}${w ? ` · ${w.current.startDate} to ${w.current.endDate} vs ${w.previous.startDate} to ${w.previous.endDate}` : ""} · generated ${esc(new Date().toLocaleString())}</div>
<p class=note><b>${count("critical")}</b> critical · <b>${count("high")}</b> high · <b>${count("medium")}</b> medium · <b>${count("low")}</b> low. Issues and counts come from Google's APIs and this dashboard's own page checks. AI only writes the fixes, and each fix is checked by code (only URLs and numbers from the data, no unsafe advice) and by Jev or a second GPT review.</p>${sections}`
  );
}
