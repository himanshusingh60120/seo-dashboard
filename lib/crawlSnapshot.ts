// lib/crawlSnapshot.ts
"use client";
/**
 * "Copy crawl stats" bookmarklet. Clicked on Search Console's Crawl stats page (or a breakdown such as
 * By purpose → Refresh), it finds the daily chart data already loaded in that page and copies it.
 * The dashboard then reads the pasted text and checks it against the totals shown on the page.
 * Nothing is downloaded and nothing leaves the browser. It depends on how Search Console's page holds
 * its data, which Google can change; if it stops finding data, the export import still works.
 */
import { KIND_LABEL, type CrawlDay, type ParsedCrawl, type SeriesKind } from "./crawlStats";

export const BOOKMARKLET_SRC = String.raw`(function(){
var T='Copy crawl stats: ';
if(location.hostname!=='search.google.com'||location.pathname.indexOf('/search-console')!==0){alert(T+'open Search Console, go to Settings > Crawl stats, then click this bookmark on that page.');return;}
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
var found=[],seen=0;
function scan(x,path,depth){
if(x===null||typeof x!=='object'||depth>14||seen>300000)return;seen++;
if(Array.isArray(x)){
if(x.length>=7&&x.length<=1500){var rows=[],dates={};
for(var i=0;i<x.length;i++){var r=rowOf(x[i]);if(r&&!dates[r[0]]){dates[r[0]]=1;rows.push(r);}}
if(rows.length>=7&&rows.length>=x.length*0.8){found.push({path:path,rows:rows});return;}}
for(var j=0;j<x.length;j++)scan(x[j],path+'.'+j,depth+1);}
else{for(var k in x)if(Object.prototype.hasOwnProperty.call(x,k))scan(x[k],path+'.'+k,depth+1);}}
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
var blobs=[],ss=document.getElementsByTagName('script');
for(var i=0;i<ss.length;i++){var t=ss[i].textContent||'';if(t.indexOf('AF_initDataCallback')>=0)blobs=blobs.concat(grab(t));}
for(var b=0;b<blobs.length;b++)scan(blobs[b],'ds'+b,0);
if(!found.length){alert(T+'no daily crawl data was found on this page. Reload the page (F5), wait until the chart shows, and click the bookmark again. If it still fails, use the export import in the dashboard instead.');return;}
found.sort(function(a,b){return b.rows.length-a.rows.length;});
var txt=document.body.innerText||'';
function tile(re){var m=txt.match(re);return m?m[1].replace(/\s+/g,''):'';}
var tiles={requests:tile(/Total crawl requests\s+([\d.,]+\s*(?:bn|[kKmMB])?)/),bytes:tile(/Total download size \(bytes\)\s+([\d.,]+\s*(?:bn|[kKmMB])?)/),ms:tile(/Average response time \(ms\)\s+([\d.,]+)/)};
var hs=[],he=document.querySelectorAll('h1,h2,[role="heading"]');
for(var h=0;h<he.length&&hs.length<10;h++){var x=(he[h].innerText||'').trim();if(x&&x.length<120)hs.push(x);}
var site='';try{site=new URL(location.href).searchParams.get('resource_id')||'';}catch(e){}
var payload=JSON.stringify({v:1,src:'gsc-crawl-stats',url:location.href,title:document.title,headings:hs,site:site,capturedAt:new Date().toISOString(),tiles:tiles,series:found.slice(0,8)});
var ok=T+'copied '+found[0].rows.length+' days of crawl data. Go back to the dashboard (Crawl activity tab) and click "Paste crawl stats".';
function legacy(s){var ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();if(done)alert(ok);else prompt('Copy this text (Ctrl+C), then paste it into the dashboard:',s);}
try{navigator.clipboard.writeText(payload).then(function(){alert(ok);},function(){legacy(payload);});}catch(e){legacy(payload);}
})();`;

export const BOOKMARKLET = "javascript:" + encodeURIComponent(BOOKMARKLET_SRC);

type Snap = {
  v: number;
  src: string;
  url: string;
  title: string;
  headings?: string[];
  site?: string;
  capturedAt: string;
  tiles?: { requests?: string; bytes?: string; ms?: string };
  series: { path: string; rows: (string | number)[][] }[];
};
type Shown = { value: number; tol: number };

/** "166k" → 166,000 ± 500 (half of the last digit shown). */
function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  const decimals = m[2]?.length ?? 0;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** decimals };
}

function guess(text: string): { kind: SeriesKind; label: string } {
  if (/refresh/i.test(text)) return { kind: "refresh", label: KIND_LABEL.refresh };
  if (/discover/i.test(text)) return { kind: "discovery", label: KIND_LABEL.discovery };
  const m = text.match(/(OK \(200\)|Not found \(404\)|Moved permanently \(301\)|Moved temporarily \(302\)|Not modified \(304\)|Server error \(5xx\)|Smartphone|Desktop|Page resource load|AdsBot|StoreBot)/i);
  if (m) return { kind: "other", label: m[1] };
  return { kind: "total", label: KIND_LABEL.total };
}

const BAD = "That doesn't look like data from the “Copy crawl stats” button. Click the bookmark on the Crawl stats page, then paste again.";

/** Reads what the bookmarklet copied and picks the column that adds up to the total shown on the page. */
export function parseSnapshot(text: string, site: string): ParsedCrawl {
  let snap: Snap;
  try {
    snap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!snap || snap.src !== "gsc-crawl-stats" || !Array.isArray(snap.series)) throw new Error(BAD);

  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (snap.site && site && norm(snap.site) !== norm(site)) {
    throw new Error(`This was copied from ${snap.site}, but the dashboard is showing ${site}. Choose that property in the top bar, or copy from this property's Crawl stats.`);
  }

  const series = snap.series
    .map((s) => ({ rows: (s.rows || []).filter((r) => Array.isArray(r) && typeof r[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r[0] as string)) }))
    .filter((s) => s.rows.length);
  if (!series.length) throw new Error("No daily crawl data was found in what was copied. Reload the Crawl stats page (F5), wait for the chart, and click the bookmark again.");

  type ColRef = { s: number; j: number; sum: number; n: number };
  const cols: ColRef[] = [];
  series.forEach((s, si) => {
    const width = Math.max(...s.rows.map((r) => r.length));
    for (let j = 1; j < width; j++) {
      let sum = 0, n = 0;
      for (const r of s.rows) {
        const v = Number(r[j]);
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      if (n >= s.rows.length * 0.8) cols.push({ s: si, j, sum, n });
    }
  });
  cols.sort((a, b) => b.n - a.n);
  if (!cols.length) throw new Error("The copied data has dates but no numbers. Use the export import instead.");

  const valueAt = (c: ColRef) => new Map(series[c.s].rows.map((r) => [String(r[0]), Number(r[c.j])] as const));
  const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;
  const reqTile = shown(snap.tiles?.requests), byTile = shown(snap.tiles?.bytes), msTile = shown(snap.tiles?.ms);

  let req = reqTile ? cols.find((c) => near(c.sum, reqTile, 0.002)) : undefined;
  const matched = !!req;
  if (!req) req = cols[0];
  const reqMap = valueAt(req);

  const by = byTile ? cols.find((c) => c !== req && near(c.sum, byTile, 0.002)) : undefined;
  const byMap = by ? valueAt(by) : null;

  // Average response time is per request, so compare a request-weighted average with the page's number.
  let msMap: Map<string, number> | null = null;
  if (msTile) {
    for (const c of cols) {
      if (c === req || c === by) continue;
      const m = valueAt(c);
      let s = 0, w = 0;
      reqMap.forEach((q, d) => {
        const v = m.get(d);
        if (v != null && Number.isFinite(v) && Number.isFinite(q)) { s += v * q; w += q; }
      });
      if (w && near(s / w, msTile, 0.03)) { msMap = m; break; }
    }
  }

  const days: Record<string, CrawlDay> = {};
  reqMap.forEach((q, d) => {
    if (!Number.isFinite(q)) return;
    const b = byMap?.get(d);
    const t = msMap?.get(d);
    days[d] = {
      requests: q,
      ...(b != null && Number.isFinite(b) ? { bytes: b } : {}),
      ...(t != null && Number.isFinite(t) ? { ms: t } : {}),
    };
  });
  const dates = Object.keys(days).sort();
  const total = dates.reduce((n, d) => n + days[d].requests, 0);
  const g = guess(`${snap.url} ${snap.title} ${(snap.headings || []).join(" ")}`);
  const when = new Date(snap.capturedAt).toLocaleString();

  return {
    file: `Copied from Crawl stats page${g.kind !== "total" ? ` (${g.label})` : ""}, ${when}`,
    ...g,
    days,
    urls: [],
    from: dates[0] || "",
    to: dates[dates.length - 1] || "",
    total,
    note: matched
      ? `Matches the page: ${total.toLocaleString()} crawl requests (page shows ${snap.tiles?.requests}).`
      : `Couldn't confirm against the page's total${snap.tiles?.requests ? ` (${snap.tiles.requests})` : ""}. Check a day against Search Console before saving.`,
  };
}
