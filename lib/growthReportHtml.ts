// lib/growthReportHtml.ts
import { expand, lc, STATUS_LABEL, type GrowthReport, type Tuple, type Bridge } from "./queryGrowth";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const n = (x: number | null | undefined) => (x == null ? "–" : Math.round(x).toLocaleString());
const signed = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.round(Math.abs(x)).toLocaleString()}`;
const pct = (x: number | null | undefined, d = 1) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const pos = (x: number | null | undefined) => (x == null ? "–" : x.toFixed(1));
const change = (cur: number, prev: number) => (prev ? `${cur >= prev ? "+" : "−"}${Math.abs(((cur - prev) / prev) * 100).toFixed(1)}%` : cur ? "new" : "–");
const cls = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");

function bridgeHtml(title: string, b: Bridge) {
  const parts: [string, number, string][] = [
    ["New queries", b.fromNew, "up"],
    ["Growing queries", b.growing, "up"],
    ["Declining queries", -b.declining, "down"],
    ["Lost queries", -b.lost, "down"],
    ...(Math.round(b.unlisted) !== 0 ? ([["Queries not listed individually", b.unlisted, "grey"]] as [string, number, string][]) : []),
  ];
  const max = Math.max(1, ...parts.map((p) => Math.abs(p[1])), Math.abs(b.end - b.start));
  const bar = (v: number, c: string) =>
    `<div class=dv><span class="l">${v < 0 ? `<i class="${c}" style="width:${(Math.abs(v) / max) * 100}%"></i>` : ""}</span><span class="r">${v > 0 ? `<i class="${c}" style="width:${(v / max) * 100}%"></i>` : ""}</span></div>`;
  return `<h3>${esc(title)}</h3><p class=m>${n(b.start)} before → ${n(b.end)} now (${signed(b.end - b.start)}, ${change(b.end, b.start)})</p>
<table class=bridge><tbody>${parts.map(([l, v, c]) => `<tr><td>${esc(l)}</td><td class=bar>${bar(v, c)}</td><td class="n ${cls(v)}">${signed(v)}</td></tr>`).join("")}
<tr class=net><td>Net change</td><td class=bar>${bar(b.end - b.start, "net")}</td><td class="n ${cls(b.end - b.start)}">${signed(b.end - b.start)}</td></tr></tbody></table>`;
}

function listHtml(title: string, rows: Tuple[], note: string, limit = 50) {
  const r = rows.slice(0, limit).map(expand);
  if (!r.length) return `<h3>${esc(title)}</h3><p class=m>None.</p>`;
  return `<h3>${esc(title)}</h3><p class=m>${esc(note)}${rows.length > limit ? ` Showing the first ${limit}.` : ""}</p>
<table><thead><tr><th>Query</th><th>Status</th><th class=n>Clicks</th><th class=n>Before</th><th class=n>Change</th><th class=n>Impressions</th><th class=n>Before</th><th class=n>Position</th><th class=n>Before</th></tr></thead><tbody>
${r.map((x) => `<tr><td class=q>${esc(x.query)}</td><td>${STATUS_LABEL[x.status]}</td><td class=n>${n(x.clicks)}</td><td class=n>${n(x.prevClicks)}</td><td class="n ${cls(x.clickChange)}">${signed(x.clickChange)}</td><td class=n>${n(x.impressions)}</td><td class=n>${n(x.prevImpressions)}</td><td class=n>${pos(x.position)}</td><td class=n>${pos(x.prevPosition)}</td></tr>`).join("")}
</tbody></table>`;
}

/** A self-contained, printable HTML version of the report. */
export function growthReportHtml(r: GrowthReport) {
  const tc = r.totals.current, tp = r.totals.previous, c = r.counts;
  const kpi = (label: string, now: string, before: string | null, delta: string, good?: boolean) =>
    `<div><span>${esc(label)}</span><b>${now}</b><em class="${good == null ? "" : good ? "up" : "down"}">${delta}</em>${before == null ? "" : `<small>before ${before}</small>`}</div>`;
  const posDelta = tc.position != null && tp.position != null ? tc.position - tp.position : null;
  const p1 = (k: "cur" | "prev") => r.bands[0][k] + r.bands[1][k];
  const maxBand = Math.max(1, ...r.bands.flatMap((b) => [b.cur, b.prev]));

  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Query growth – ${esc(r.subject)}</title>
<style>
body{font:14px/1.5 "Public Sans","Segoe UI",system-ui,sans-serif;color:#17202b;max-width:1100px;margin:32px auto;padding:0 20px;font-variant-numeric:tabular-nums}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:18px;margin:32px 0 8px;padding-top:12px;border-top:1px solid #d5dbe1}h3{font-size:15px;margin:20px 0 4px}
.m{color:#6b7682;font-size:12.5px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #e7ebef}
th{border-bottom:1px solid #b9c2cb;font-weight:600;color:#4a5663}.n{text-align:right;white-space:nowrap}td.q{overflow-wrap:anywhere}
.up{color:#16794a}.down{color:#b3261e}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border:1px solid #d5dbe1;border-radius:6px;margin:16px 0}
.kpis div{padding:12px 14px;border-right:1px solid #e7ebef}.kpis div:last-child{border-right:0}
.kpis span{display:block;font-size:12.5px;color:#4a5663}.kpis b{display:block;font-size:22px;font-weight:600}.kpis em{font-style:normal;font-size:12px;font-weight:600;display:block}.kpis small{color:#7b8794;font-size:12px}
ul{padding-left:18px;max-width:80ch}li{margin-bottom:6px}
.bridge td{border:0;padding:4px 8px}.bridge .bar{width:60%}.bridge tr.net td{border-top:1px solid #d5dbe1;font-weight:600}
.dv{display:grid;grid-template-columns:1fr 1fr;height:14px}.dv span{display:flex}.dv .l{justify-content:flex-end;border-right:1px solid #7b8794}
.dv i{display:block;height:100%}.dv i.up{background:#16794a}.dv i.down{background:#b3261e}.dv i.grey{background:#9aa5b1}.dv i.net{background:#2e4c8c}
.pair{display:grid;gap:2px}.pair i{display:block;height:7px}.pair .b{background:#9bb0d9}.pair .a{background:#2e4c8c}
.note{background:#f4f6f8;border-radius:6px;padding:10px 12px;font-size:13px;margin:12px 0}
@media print{h2{break-before:auto}table,.kpis{break-inside:avoid}a{color:inherit}}
</style></head><body>
<h1>Query growth report</h1>
<p class=m>${esc(r.subject)} · ${esc(r.currentLabel)} compared with ${esc(lc(r.previousLabel))} · generated ${esc(new Date().toLocaleString())}</p>
<div class=kpis>
${kpi("Clicks", n(tc.clicks), n(tp.clicks), change(tc.clicks, tp.clicks), tc.clicks >= tp.clicks)}
${kpi("Impressions", n(tc.impressions), n(tp.impressions), change(tc.impressions, tp.impressions), tc.impressions >= tp.impressions)}
${kpi("CTR", pct(tc.ctr, 2), pct(tp.ctr, 2), `${tc.ctr >= tp.ctr ? "+" : "−"}${Math.abs((tc.ctr - tp.ctr) * 100).toFixed(2)} pts`, tc.ctr >= tp.ctr)}
${kpi("Avg. position", pos(tc.position), pos(tp.position), posDelta == null ? "–" : `${posDelta <= 0 ? "▲" : "▼"} ${Math.abs(posDelta).toFixed(1)}`, posDelta == null ? undefined : posDelta <= 0)}
${kpi("Queries", n(c.current), n(c.previous), signed(c.current - c.previous), c.current >= c.previous)}
${kpi("New / lost queries", `${n(c.new)} / ${n(c.lost)}`, null, `${n(c.retained)} in both periods`)}
</div>
<div class=note>${esc(r.coverage)}${r.warnings.length ? `<br>${r.warnings.map(esc).join("<br>")}` : ""}</div>

<h2>Summary</h2>
<ul>${r.narrative.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>

<h2>Where the change came from</h2>
${bridgeHtml("Clicks", r.clicksBridge)}
${bridgeHtml("Impressions", r.impressionsBridge)}

${r.hasPositions ? `<h2>Queries by position</h2>
<p class=m>${n(p1("cur"))} queries on page one now, ${n(p1("prev"))} before. ${n(c.reachedPageOne)} moved onto page one and ${n(c.droppedPageOne)} fell off it (queries with ${r.minImpr}+ impressions).</p>
<table><thead><tr><th>Position</th><th style="width:45%"></th><th class=n>Before</th><th class=n>Now</th><th class=n>Change</th></tr></thead><tbody>
${r.bands.map((b) => `<tr><td>${esc(b.label)}</td><td><div class=pair><i class=b style="width:${(b.prev / maxBand) * 100}%"></i><i class=a style="width:${(b.cur / maxBand) * 100}%"></i></div></td><td class=n>${n(b.prev)}</td><td class=n>${n(b.cur)}</td><td class="n ${cls(b.cur - b.prev)}">${signed(b.cur - b.prev)}</td></tr>`).join("")}
</tbody></table><p class=m>Light bar: before. Dark bar: now.</p>` : ""}

<h2>Growth by segment</h2>
<table><thead><tr><th>Segment</th><th class=n>Queries now</th><th class=n>Before</th><th class=n>Clicks now</th><th class=n>Before</th><th class=n>Change</th><th class=n>Impressions now</th><th class=n>Before</th><th class=n>Change</th><th class=n>Position now</th><th class=n>Before</th></tr></thead><tbody>
${r.segments.map((s) => `<tr><td>${esc(s.label)}</td><td class=n>${n(s.cur.queries)}</td><td class=n>${n(s.prev.queries)}</td><td class=n>${n(s.cur.clicks)}</td><td class=n>${n(s.prev.clicks)}</td><td class="n ${cls(s.cur.clicks - s.prev.clicks)}">${change(s.cur.clicks, s.prev.clicks)}</td><td class=n>${n(s.cur.impressions)}</td><td class=n>${n(s.prev.impressions)}</td><td class="n ${cls(s.cur.impressions - s.prev.impressions)}">${change(s.cur.impressions, s.prev.impressions)}</td><td class=n>${pos(s.cur.position)}</td><td class=n>${pos(s.prev.position)}</td></tr>`).join("")}
</tbody></table>

<h2>Queries</h2>
${listHtml("Biggest gainers", r.lists.gainers, "Sorted by the increase in clicks. New queries are included.")}
${listHtml("Biggest losers", r.lists.losers, "Sorted by the drop in clicks. Lost queries are included.")}
${listHtml("New queries", r.lists.new, `${n(c.new)} queries were shown this period but not before. Sorted by clicks.`)}
${listHtml("Lost queries", r.lists.lost, `${n(c.lost)} queries were shown before but not this period. Sorted by clicks before.`)}
${r.hasPositions ? listHtml("Moved onto page one", r.lists.reachedPageOne, `Position above 10 before, 10 or better now, ${r.minImpr}+ impressions now.`) : ""}
${r.hasPositions ? listHtml("Fell off page one", r.lists.droppedPageOne, `Position 10 or better before, worse than 10 now, ${r.minImpr}+ impressions before.`) : ""}

<div class=note><b>How this was calculated.</b> Queries are matched by their exact text across the two periods. New = shown now but not before; lost = shown before but not now; growing / declining = more / fewer clicks than before (impressions decide when clicks are equal).
“Where the change came from” splits the change in the total: previous total + new + growing − declining − lost + queries not listed individually = this period's total. Average positions are weighted by impressions.
The full query list (${n(r.rowCount)} queries) is available as a CSV from the dashboard's Query growth tab.</div>
</body></html>`;
}
