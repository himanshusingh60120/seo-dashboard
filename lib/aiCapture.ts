// lib/aiCapture.ts
"use client";
/**
 * One-click "Copy AI impressions" bookmark.
 * Clicked on Search Console's Generative AI features report, it reads the daily impressions and the Pages list from the
 * page, opens the Countries and Devices tabs to read those tables too, then opens the dashboard, which checks that the
 * days add up to the page's "Total impressions" and saves everything for everyone.
 * Search Console keeps earlier pages (and their data) in the background, so the bookmark only uses visible tabs and
 * tables, and picks the page list whose numbers match the rows visible on screen.
 * It depends on how Search Console's pages hold their data, which Google can change; the export import stays as the fallback.
 */
import type { AiParsed } from "./aiStore";
import { AI_MAX_PAGES } from "./aiStore";
import { normalizeUrl, urlInProperty } from "./url";

const SRC = String.raw`(function(){
var DASH=__DASH__,T='Copy AI impressions: ';
function stop(m){alert(T+m);}
if(location.hostname!=='search.google.com'||location.pathname.indexOf('/search-console')!==0){stop('open Search Console, go to Performance > Generative AI features, then click this bookmark there.');return;}
var site='';try{site=new URL(location.href).searchParams.get('resource_id')||'';}catch(e){}
if(!site){stop('open the Generative AI features report of a property first.');return;}
var txt=document.body.innerText||'';
if(/Total clicks/.test(txt)||!/Generative AI features/i.test(txt)){stop('this is not the Generative AI features report. In Performance, click Open report in the generative AI box, then click this bookmark there.');return;}
var tm=txt.match(/Total impressions\s+([\d.,]+\s*(?:bn|[kKmMB])?)/);
if(!tm){stop('the Total impressions figure is not showing yet. Wait for the chart to load, then click the bookmark again.');return;}
var w=null;try{w=window.open(DASH+'/#ai-wait','_blank');}catch(e){}
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
function urlRow(el){
if(!Array.isArray(el))return null;
var parts=[];flat(el,0,parts);
var url=null,nums=[];
for(var i=0;i<parts.length;i++){var v=parts[i].v;
if(!url&&typeof v==='string'&&/^https?:\/\/\S+$/.test(v)){url=v;continue;}
if(isNum(v))nums.push(v);else if(typeof v==='string'&&/^\d+(\.\d+)?$/.test(v))nums.push(Number(v));}
return url&&nums.length?[url].concat(nums):null;}
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
function pagesIn(blobs){var found=[],seen=0;
function scan(x,path,depth){
if(x===null||typeof x!=='object'||depth>14||seen>300000)return;seen++;
if(Array.isArray(x)){
if(x.length>=2&&x.length<=25000){var rows=[],urls={};
for(var i=0;i<x.length;i++){var r=urlRow(x[i]);if(r&&!urls[r[0]]){urls[r[0]]=1;rows.push(r);}}
if(rows.length>=2&&rows.length>=x.length*0.8){found.push({path:path,rows:rows.slice(0,5000)});return;}}
for(var j=0;j<x.length;j++)scan(x[j],path+'.'+j,depth+1);}
else{for(var k in x)if(Object.prototype.hasOwnProperty.call(x,k))scan(x[k],path+'.'+k,depth+1);}}
for(var b=0;b<blobs.length;b++)scan(blobs[b],'ds'+b,0);
return found;}
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
function vis(e){try{return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';}catch(x){return false;}}
function rowsNow(){var out=[],trs=document.querySelectorAll('tr,[role=row]');
for(var t=0;t<trs.length&&out.length<1000;t++){if(!vis(trs[t]))continue;
var cells=trs[t].querySelectorAll('td,[role=cell],[role=gridcell]');if(cells.length<2)continue;
var a=(cells[0].innerText||'').trim(),n=(cells[cells.length-1].innerText||'').replace(/[,\s]/g,'');
if(a&&/^\d+$/.test(n))out.push([a,Number(n)]);}
return out;}
var DEVW=/\b(desktop|mobile|tablet)\b/i;
function isUrl(l){return /^https?:\/\/\S+$/.test(l);}
function tabEl(name){var els=document.querySelectorAll('[role=tab]');
for(var i=0;i<els.length;i++)if(vis(els[i])&&(els[i].innerText||'').trim().toUpperCase()===name)return els[i];
els=document.querySelectorAll('button,a,span,div');
for(var j=0;j<els.length;j++){var e=els[j];if(e.children.length<=2&&vis(e)&&(e.innerText||'').trim().toUpperCase()===name)return e;}
return null;}
function viaTab(name,ok){return new Promise(function(res){var el=tabEl(name);if(!el){res(null);return;}
try{el.click();}catch(x){res(null);return;}
var n=0;(function wait(){n++;var rows=rowsNow().filter(function(r){return ok(r[0]);});if(rows.length||n>48)res(rows);else setTimeout(wait,250);})();});}
var table=rowsNow().filter(function(r){return isUrl(r[0]);});
var tmap={};for(var q=0;q<table.length;q++)tmap[table[q][0]]=table[q][1];
function agree(c){var n=0;for(var j=0;j<c.rows.length;j++){var r=c.rows[j],v=tmap[r[0]];if(v!=null&&r.indexOf(v,1)>0)n++;}return n;}
var dom=[],ss=document.getElementsByTagName('script');
for(var m=0;m<ss.length;m++){var st=ss[m].textContent||'';if(st.indexOf('AF_initDataCallback')>=0)dom=dom.concat(grab(st));}
var countries=[],devices=[],debug={};
viaTab('COUNTRIES',function(l){return !isUrl(l)&&!DEVW.test(l);})
.then(function(c){if(c===null)debug.countriesTab='not found';countries=c||[];return viaTab('DEVICES',function(l){return DEVW.test(l);});})
.then(function(d){if(d===null)debug.devicesTab='not found';devices=d||[];
if(!devices.length)debug.devicesSeen=rowsNow().slice(0,5).map(function(r){return r[0];});
var p=tabEl('PAGES');if(p){try{p.click();}catch(x){}}})
.then(function(){return fetch(location.href,{credentials:'include'}).then(function(r){return r.ok?r.text():'';}).catch(function(){return '';});})
.then(function(h){
var blobs=dom.concat(h?grab(h):[]);
var series=seriesIn(blobs);
var pages=pagesIn(blobs).map(function(c){c.agree=agree(c);return c;}).sort(function(a,b){return b.agree-a.agree||b.rows.length-a.rows.length;}).slice(0,2);
if(!series.length){if(w)w.close();stop('no daily AI impressions were found on this page. Reload it (F5), wait for the chart, and click the bookmark again. If it keeps failing, use Export > Download CSV and import the file instead.');return;}
var json=JSON.stringify({v:2,src:'gsc-ai-impressions',site:site,url:location.href,capturedAt:new Date().toISOString(),tiles:{impressions:tm[1].replace(/\s+/g,'')},series:series,pages:pages,table:table,countries:countries,devices:devices,debug:debug});
if(w&&!w.closed){w.location.href=DASH+'/#aistats='+encodeURIComponent(json);return;}
var ok=T+'copied. Open the dashboard (Overview tab) and paste it under "Paste AI impressions".';
function legacy(s){var ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();if(done)alert(ok);else prompt('Copy this text (Ctrl+C), then paste it into the dashboard:',s);}
try{navigator.clipboard.writeText(json).then(function(){alert(ok);},function(){legacy(json);});}catch(e){legacy(json);}
});
})();`;

/** The bookmark for this dashboard (it needs to know where to send the data). */
export const aiBookmarkletFor = (dashboardOrigin: string) =>
  "javascript:" + encodeURIComponent(SRC.replace("__DASH__", JSON.stringify(dashboardOrigin)));

type Shown = { value: number; tol: number };
type Rows = { path: string; rows: (string | number)[][] };
type Capture = {
  v: number;
  src: string;
  site: string;
  url?: string;
  capturedAt: string;
  tiles?: { impressions?: string };
  series?: Rows[];
  pages?: Rows[];
  table?: [string, number][];
  countries?: [string, number][];
  devices?: [string, number][];
  debug?: { countriesTab?: string; devicesTab?: string; devicesSeen?: string[] };
};

export type AiCaptureResult = {
  item: AiParsed;
  verified: boolean;
  /** Short line for the dashboard, e.g. "87,487 AI impressions, 2026-08-10 to 2026-11-09 · 1,000 pages · 10 countries · 3 devices". */
  summary: string;
  /** Short warnings worth showing (missing parts). Empty when everything came through. */
  notes: string[];
  /** Why it wasn't saved automatically (only when verified is false). */
  problem?: string;
};

/** "87.5k" → 87,500 ± 50 (half of the last digit shown). */
function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** (m[2]?.length ?? 0) };
}
const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;

/** "smartphone Mobile" → "Mobile". */
function deviceOf(label: string): string | null {
  const m = label.match(/\b(desktop|mobile|tablet)\b/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

const BAD =
  "That doesn't look like data from the “Copy AI impressions” bookmark. Click the bookmark on the Generative AI features report in Search Console.";

/** Reads what the bookmark sent, picks the daily impressions that add up to the page's total, and the page, country and device lists. */
export function parseAiCapture(text: string, site: string): AiCaptureResult {
  let cap: Capture;
  try {
    cap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!cap || cap.src !== "gsc-ai-impressions" || !Array.isArray(cap.series)) throw new Error(BAD);
  if (cap.v !== 1 && cap.v !== 2) {
    throw new Error("This came from a different version of the “Copy AI impressions” bookmark. Drag the current one from the Overview tab.");
  }
  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (cap.site && site && norm(cap.site) !== norm(site)) {
    throw new Error(`This was copied from ${cap.site}, but the dashboard is showing ${site}, and your account can't open ${cap.site} here.`);
  }

  // Daily columns: whole-number values on at least 80% of the dates.
  type DayCol = { map: Map<string, number>; sum: number };
  const cols: DayCol[] = [];
  for (const s of cap.series || []) {
    const rows = (s.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r[0] as string));
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    for (let j = 1; j < width; j++) {
      const map = new Map<string, number>();
      let sum = 0;
      for (const r of rows) {
        const v = Number(r[j]);
        if (Number.isInteger(v) && v >= 0) {
          map.set(String(r[0]), v);
          sum += v;
        }
      }
      if (map.size >= rows.length * 0.8) cols.push({ map, sum });
    }
  }
  if (!cols.length) {
    throw new Error("No daily AI impressions were found. Reload the report (F5), wait for the chart, and click the bookmark again, or import an export instead.");
  }
  const tile = shown(cap.tiles?.impressions);
  const matching = tile ? cols.filter((c) => near(c.sum, tile, 0.003)) : [];
  const verified = matching.length > 0;
  const pick = (verified ? matching : cols).slice().sort((a, b) => b.map.size - a.map.size || b.sum - a.sum)[0];
  const dates = Array.from(pick.map.keys()).sort();
  const days: Record<string, number> = {};
  for (const d of dates) days[d] = pick.map.get(d)!;
  const total = dates.reduce((n, d) => n + days[d], 0);

  // Pages: the column that agrees with the rows visible in the table; otherwise just the visible rows.
  const notes: string[] = [];
  const inProp = (u: string) => {
    try {
      return urlInProperty(site, u);
    } catch {
      return false;
    }
  };
  const table = new Map<string, number>();
  for (const r of cap.table || []) {
    if (Array.isArray(r) && typeof r[0] === "string" && inProp(r[0]) && Number.isInteger(Number(r[1]))) table.set(normalizeUrl(r[0]), Number(r[1]));
  }
  let best: { rows: Record<string, number>; agree: number; n: number } | null = null;
  for (const cand of cap.pages || []) {
    const rows = (cand.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && inProp(r[0] as string));
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    for (let j = 1; j < width; j++) {
      const out: Record<string, number> = {};
      let agree = 0, n = 0;
      for (const r of rows) {
        const v = Number(r[j]);
        if (!Number.isInteger(v) || v < 0) continue;
        const u = normalizeUrl(String(r[0]));
        out[u] = v;
        n++;
        if (table.get(u) === v) agree++;
      }
      if (n < rows.length * 0.8) continue;
      if (!best || agree > best.agree || (agree === best.agree && n > best.n)) best = { rows: out, agree, n };
    }
  }
  let pages: Record<string, number> = {};
  if (best && (best.agree > 0 || !table.size)) {
    pages = best.rows;
  } else if (table.size) {
    pages = Object.fromEntries(table);
    notes.push(`Only the ${table.size} page rows visible on screen were found; open the report directly (not from the Performance page) and click the bookmark again for the full list.`);
  } else {
    notes.push("No page list was found.");
  }
  pages = Object.fromEntries(Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, AI_MAX_PAGES));

  // Countries and devices: read from their tabs by the bookmark (rows visible in each table).
  const countries: Record<string, number> = {};
  for (const r of cap.countries || []) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    const k = r[0].trim(), v = Number(r[1]);
    if (k && k.length <= 80 && !/^https?:\/\//i.test(k) && !deviceOf(k) && Number.isInteger(v) && v >= 0) countries[k] = v;
  }
  const devices: Record<string, number> = {};
  for (const r of cap.devices || []) {
    if (!Array.isArray(r) || typeof r[0] !== "string") continue;
    const k = deviceOf(r[0]), v = Number(r[1]);
    if (k && Number.isInteger(v) && v >= 0) devices[k] = v;
  }
  const nP = Object.keys(pages).length, nC = Object.keys(countries).length, nD = Object.keys(devices).length;
  if (cap.v === 1) notes.push("Countries and devices need the updated bookmark: drag it from this page again.");
  else {
    if (!nC) notes.push(cap.debug?.countriesTab === "not found" ? "The Countries tab wasn't found." : "No countries were read.");
    if (!nD) {
      const seen = cap.debug?.devicesSeen?.filter(Boolean) || [];
      notes.push(
        cap.debug?.devicesTab === "not found"
          ? "The Devices tab wasn't found."
          : `No devices were read${seen.length ? ` (the Devices tab showed: ${seen.join(", ")})` : ""}.`
      );
    }
  }

  const summary =
    `${total.toLocaleString()} AI impressions, ${dates[0]} to ${dates[dates.length - 1]}` +
    ` · ${nP.toLocaleString()} pages · ${nC} countries · ${nD} devices`;
  const problem = verified
    ? undefined
    : tile
      ? `The days add up to ${total.toLocaleString()}, not the report's Total impressions (${cap.tiles?.impressions}), so nothing was saved. Check the date range on the report and click the bookmark again, or save anyway.`
      : "The report's Total impressions couldn't be read, so the numbers couldn't be checked and nothing was saved. Click the bookmark again, or save anyway.";

  return {
    item: {
      file: `Bookmark, ${new Date(cap.capturedAt).toLocaleString()}`,
      from: dates[0],
      to: dates[dates.length - 1],
      days,
      pages,
      countries,
      devices,
    },
    verified,
    summary,
    notes,
    problem,
  };
}
