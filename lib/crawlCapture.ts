// lib/crawlCapture.ts
"use client";
/**
 * One-click "Copy crawl stats" bookmark.
 * Clicked on any Search Console Crawl stats page, it reads the daily data for the whole report plus Refresh and
 * Discovery (opening those pages in the background in your signed-in browser), then opens the dashboard, which
 * checks the numbers (Refresh + Discovery must equal the total on each day) and saves them for everyone.
 * It learns the Refresh and Discovery page addresses from the report's links, or the first time it's clicked on
 * those pages. It depends on how Search Console's pages hold their data, which Google can change.
 */
import { KIND_LABEL, type CrawlDay, type ParsedCrawl, type SeriesKind } from "./crawlStats";

const SRC = String.raw`(function(){
var DASH=__DASH__,T='Copy crawl stats: ';
if(location.hostname!=='search.google.com'||location.pathname.indexOf('/search-console')!==0){alert(T+'open Search Console, go to Settings > Crawl stats, then click this bookmark there.');return;}
var site='';try{site=new URL(location.href).searchParams.get('resource_id')||'';}catch(e){}
if(!site){alert(T+'open the Crawl stats report of a property first.');return;}
var w=null;try{w=window.open(DASH+'/#crawl-wait','_blank');}catch(e){}
function pad(n){return(n<10?'0':'')+n;}
function iso(d){return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());}
function isNum(n){return typeof n==='number'&&isFinite(n);}
function dateOf(v){
if(typeof v==='string'){if(/^\d{4}-\d{2}-\d{2}/.test(v))return v.slice(0,10);if(/^\d{8}$/.test(v)||/^\d{10}$/.test(v)||/^\d{13}$/.test(v))v=Number(v);else return null;}
if(isNum(v)){
if(v>19000000&&v<21000000){var s=String(v);return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);}
if(v>1.4e12&&v<2.2e12)return iso(new Date(v));
if(v>1.4e9&&v<2.2e9)return iso(new Date(v*1000));
return null;}
if(Array.isArray(v)&&v.length>=3&&v.length<=4&&isNum(v[0])&&v[0]>2000&&v[0]<2100&&v[1]>=1&&v[1]<=12&&v[2]>=1&&v[2]<=31)return v[0]+'-'+pad(v[1])+'-'+pad(v[2]);
return null;}
function flat(x,depth,out){
if(Array.isArray(x)&&depth<4){var d=dateOf(x);if(d){out.push({d:d});return;}for(var i=0;i<x.length;i++)flat(x[i],depth+1,out);}
else out.push({v:x});}
function rowOf(el){
if(!Array.isArray(el))return null;
var parts=[];flat(el,0,parts);
var date=null,nums=[];
for(var i=0;i<parts.length;i++){var p=parts[i];
if(p.d){if(!date)date=p.d;continue;}
var v=p.v;
if(!date){var dd=dateOf(v);if(dd){date=dd;continue;}}
if(isNum(v))nums.push(v);else if(typeof v==='string'&&/^-?\d+(\.\d+)?$/.test(v))nums.push(Number(v));}
return date&&nums.length?[date].concat(nums):null;}
function seriesIn(blobs){var found=[],seen=0;
function scan(x,path,depth){
if(x===null||typeof x!=='object'||depth>14||seen>300000)return;seen++;
if(Array.isArray(x)){
if(x.length>=7&&x.length<=1500){var rows=[],dates={};
for(var i=0;i<x.length;i++){var r=rowOf(x[i]);if(r&&!dates[r[0]]){dates[r[0]]=1;rows.push(r);}}
if(rows.length>=7&&rows.length>=x.length*0.8){found.push({path:path,rows:rows});return;}}
for(var j=0;j<x.length;j++)scan(x[j],path+'.'+j,depth+1);}
else{for(var k in x)if(Object.prototype.hasOwnProperty.call(x,k))scan(x[k],path+'.'+k,depth+1);}}
for(var b=0;b<blobs.length;b++)scan(blobs[b],'ds'+b,0);
found.sort(function(a,b){return b.rows.length-a.rows.length;});return found.slice(0,6);}
function grab(t){var out=[],k=0;
while((k=t.indexOf('data:',k))>=0){var s=k+5;while(t.charAt(s)===' ')s++;var c0=t.charAt(s);if(c0!=='['&&c0!=='{'){k=s;continue;}
var d=0,q=null,e=s;
for(;e<t.length;e++){var c=t.charAt(e);
if(q){if(c==='\\'){e++;continue;}if(c===q)q=null;continue;}
if(c==='"'){q=c;continue;}
if(c==='['||c==='{')d++;else if(c===']'||c==='}'){d--;if(d===0)break;}}
try{out.push(JSON.parse(t.slice(s,e+1)));}catch(x){}
k=e+1;}
return out;}
var txt=document.body.innerText||'';
function tile(re){var m=txt.match(re);return m?m[1].replace(/\s+/g,''):'';}
var tiles={requests:tile(/Total crawl requests\s+([\d.,]+\s*(?:bn|[kKmMB])?)/),bytes:tile(/Total download size \(bytes\)\s+([\d.,]+\s*(?:bn|[kKmMB])?)/),ms:tile(/Average response time \(ms\)\s+([\d.,]+)/)};
var cm=txt.match(/Crawl requests:\s*([^\n]+)/);
var hereLabel=cm?cm[1].trim():'';
var hereKind=!cm?'total':/^refresh/i.test(hereLabel)?'refresh':/^discover/i.test(hereLabel)?'discovery':'other';
var LS='dashCrawlLinks:'+site,links={};
try{links=JSON.parse(localStorage.getItem(LS)||'{}')||{};}catch(e){}
if(hereKind==='refresh'||hereKind==='discovery')links[hereKind]=location.href;
var as=document.querySelectorAll('a[href]');
for(var i=0;i<as.length;i++){var at=(as[i].innerText||'').trim(),ah=as[i].href;if(ah.indexOf('crawl')<0)continue;if(/^Refresh\b/i.test(at))links.refresh=ah;else if(/^Discovery\b/i.test(at))links.discovery=ah;}
try{localStorage.setItem(LS,JSON.stringify(links));}catch(e){}
var dom=[],ss=document.getElementsByTagName('script');
for(var n=0;n<ss.length;n++){var st=ss[n].textContent||'';if(st.indexOf('AF_initDataCallback')>=0)dom=dom.concat(grab(st));}
var domSeries=seriesIn(dom);
var mainUrl='https://search.google.com/search-console/settings/crawl-stats?resource_id='+encodeURIComponent(site);
var jobs=[{kind:'total',label:'All crawl requests',url:hereKind==='total'?location.href:mainUrl}];
if(links.refresh)jobs.push({kind:'refresh',label:'Refresh',url:links.refresh});
if(links.discovery)jobs.push({kind:'discovery',label:'Discovery',url:links.discovery});
if(hereKind==='other')jobs.push({kind:'other',label:hereLabel,url:location.href});
var missing=[];if(!links.refresh)missing.push('refresh');if(!links.discovery)missing.push('discovery');
function load(j){return fetch(j.url,{credentials:'include'}).then(function(r){return r.ok?r.text():'';}).catch(function(){return '';}).then(function(h){
var sr=h?seriesIn(grab(h)):[];
if(j.kind===hereKind){j.tiles=tiles;if(!sr.length)sr=domSeries;}
j.series=sr;return j;});}
Promise.all(jobs.map(load)).then(function(pages){
pages=pages.filter(function(p){return p.series.length;});
if(!pages.length){if(w)w.close();alert(T+'no daily crawl data was found. Reload the page (F5), wait until the chart shows, and click the bookmark again.');return;}
var json=JSON.stringify({v:2,src:'gsc-crawl-stats',site:site,capturedAt:new Date().toISOString(),pages:pages,missing:missing});
if(w&&!w.closed){w.location.href=DASH+'/#crawlstats='+encodeURIComponent(json);return;}
var ok=T+'copied. Open the dashboard (Crawl activity tab) and click "Paste crawl stats".';
function legacy(s){var ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();if(done)alert(ok);else prompt('Copy this text (Ctrl+C), then paste it into the dashboard:',s);}
try{navigator.clipboard.writeText(json).then(function(){alert(ok);},function(){legacy(json);});}catch(e){legacy(json);}
});
})();`;

/** The bookmark for this dashboard (it needs to know where to send the data). */
export const bookmarkletFor = (dashboardOrigin: string) => "javascript:" + encodeURIComponent(SRC.replace("__DASH__", JSON.stringify(dashboardOrigin)));

type Tiles = { requests?: string; bytes?: string; ms?: string };
type CapturePage = { kind: SeriesKind; label: string; url: string; tiles?: Tiles; series: { path: string; rows: (string | number)[][] }[] };
type Capture = { v: number; src: string; site: string; capturedAt: string; pages: CapturePage[]; missing?: string[] };
type Shown = { value: number; tol: number };
type Col = { map: Map<string, number>; sum: number; n: number };
type Cand = { col: Col; tile: boolean };

export type CaptureResult = { items: ParsedCrawl[]; verified: boolean; summary: string };

/** "166k" → 166,000 ± 500 (half of the last digit shown). */
function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** (m[2]?.length ?? 0) };
}
const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;

const BAD = "That doesn't look like data from the “Copy crawl stats” bookmark. Click the bookmark on the Crawl stats page in Search Console.";

/** Reads what the bookmark sent, picks the right numbers (Refresh + Discovery = total), and says whether it checked out. */
export function parseCapture(text: string, site: string): CaptureResult {
  let cap: Capture;
  try {
    cap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!cap || cap.src !== "gsc-crawl-stats" || !Array.isArray(cap.pages)) throw new Error(BAD);
  if (cap.v !== 2) throw new Error("This came from an older “Copy crawl stats” bookmark. Delete it and drag the new one from the Crawl activity tab.");
  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (cap.site && site && norm(cap.site) !== norm(site)) {
    throw new Error(`This was copied from ${cap.site}, but the dashboard is showing ${site}, and your account can't open ${cap.site} here.`);
  }

  const colCache = new Map<CapturePage, Col[]>();
  const colsOf = (p: CapturePage): Col[] => {
    const hit = colCache.get(p);
    if (hit) return hit;
    const out: Col[] = [];
    for (const s of p.series || []) {
      const rows = (s.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r[0] as string));
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      for (let j = 1; j < width; j++) {
        const map = new Map<string, number>();
        let sum = 0;
        for (const r of rows) {
          const v = Number(r[j]);
          if (Number.isFinite(v)) { map.set(String(r[0]), v); sum += v; }
        }
        if (map.size >= rows.length * 0.8) out.push({ map, sum, n: map.size });
      }
    }
    out.sort((a, b) => b.n - a.n);
    colCache.set(p, out);
    return out;
  };
  const candidates = (p?: CapturePage): Cand[] => {
    if (!p) return [];
    const cols = colsOf(p);
    const t = shown(p.tiles?.requests);
    if (t) {
      const m = cols.filter((c) => near(c.sum, t, 0.002));
      if (m.length) return m.map((col) => ({ col, tile: true }));
    }
    return cols.map((col) => ({ col, tile: false }));
  };
  const extras = (p: CapturePage, req: Col) => {
    const cols = colsOf(p);
    const by = shown(p.tiles?.bytes), mt = shown(p.tiles?.ms);
    const bytes = by ? cols.find((c) => c !== req && near(c.sum, by, 0.002))?.map ?? null : null;
    let ms: Map<string, number> | null = null;
    if (mt) {
      for (const c of cols) {
        if (c === req || c.map === bytes) continue;
        let s = 0, w = 0;
        req.map.forEach((q, d) => {
          const v = c.map.get(d);
          if (v != null) { s += v * q; w += q; }
        });
        if (w && near(s / w, mt, 0.03)) { ms = c.map; break; }
      }
    }
    return { bytes, ms };
  };

  const find = (k: SeriesKind) => cap.pages.find((p) => p.kind === k);
  const T = find("total"), R = find("refresh"), D = find("discovery");
  const ct = candidates(T), cr = candidates(R), cd = candidates(D);

  let pick: { t?: Cand; r?: Cand; d?: Cand } = { t: ct[0], r: cr[0], d: cd[0] };
  let check: { ok: number; overlap: number } | null = null;
  if (ct.length && cr.length && cd.length) {
    let bestRatio = -1, bestOverlap = 0;
    for (const t of ct)
      for (const r of cr)
        for (const d of cd) {
          let ok = 0, overlap = 0;
          t.col.map.forEach((tv, date) => {
            const rv = r.col.map.get(date), dv = d.col.map.get(date);
            if (rv == null || dv == null) return;
            overlap++;
            if (Math.abs(rv + dv - tv) <= Math.max(1, tv * 0.002)) ok++;
          });
          const ratio = overlap ? ok / overlap : 0;
          if (ratio > bestRatio || (ratio === bestRatio && overlap > bestOverlap)) {
            bestRatio = ratio;
            bestOverlap = overlap;
            pick = { t, r, d };
            check = { ok, overlap };
          }
        }
  }
  const sumOk = !!check && check.overlap >= 7 && check.ok >= check.overlap * 0.95;
  const present = [T ? pick.t : undefined, R ? pick.r : undefined, D ? pick.d : undefined].filter(Boolean) as Cand[];
  const verified = check ? sumOk : present.length > 0 && present.every((x) => x.tile);

  const when = new Date(cap.capturedAt).toLocaleString();
  const items: ParsedCrawl[] = [];
  const make = (p: CapturePage, c: Cand | undefined, kind: SeriesKind, label: string) => {
    if (!c) return;
    const ex = extras(p, c.col);
    const days: Record<string, CrawlDay> = {};
    c.col.map.forEach((q, d) => {
      const b = ex.bytes?.get(d), t = ex.ms?.get(d);
      days[d] = { requests: q, ...(b != null && Number.isFinite(b) ? { bytes: b } : {}), ...(t != null && Number.isFinite(t) ? { ms: t } : {}) };
    });
    const dates = Object.keys(days).sort();
    items.push({
      file: `Crawl stats page (${label}), copied ${when}`,
      kind,
      label,
      days,
      urls: [],
      from: dates[0] || "",
      to: dates[dates.length - 1] || "",
      total: dates.reduce((n, d) => n + days[d].requests, 0),
      note: c.tile ? `Matches the page total (${p.tiles?.requests}).` : "",
    });
  };
  if (T) make(T, pick.t, "total", KIND_LABEL.total);
  if (R) make(R, pick.r, "refresh", KIND_LABEL.refresh);
  if (D) make(D, pick.d, "discovery", KIND_LABEL.discovery);
  for (const p of cap.pages.filter((x) => x.kind === "other")) make(p, candidates(p)[0], "other", p.label || "Other");
  if (!items.length) throw new Error("No daily crawl data was found. Reload the Crawl stats page (F5), wait for the chart, and click the bookmark again.");

  let summary = `Copied ${when}: ${items.map((i) => `${i.label} ${i.total.toLocaleString()}`).join(", ")} (${items[0].from} to ${items[0].to}).`;
  if (check) {
    const c = check as { ok: number; overlap: number };
    summary += sumOk
      ? ` Checked: Refresh + Discovery = All crawl requests on ${c.ok} of ${c.overlap} days.`
      : ` Refresh + Discovery matched the total on only ${c.ok} of ${c.overlap} days, so it wasn't saved automatically.`;
  }
  const miss = (cap.missing || []).map((m) => (m === "refresh" ? "Refresh" : "Discovery"));
  if (miss.length) {
    summary += ` ${miss.join(" and ")} ${miss.length > 1 ? "weren't" : "wasn't"} included yet: in Search Console open Crawl stats → By purpose → ${miss.join(", then ")} and click the bookmark on ${miss.length > 1 ? "each" : "that"} page once. After that it's included automatically.`;
  }
  return { items, verified, summary };
}
