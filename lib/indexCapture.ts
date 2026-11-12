// lib/indexCapture.ts
"use client";
/**
 * One-click "Copy page indexing" bookmark, plus loading and saving the result.
 * Clicked on Search Console's Page indexing report, it reads the exact daily Indexed / Not indexed counts and the
 * "Why pages aren't indexed" table for All known pages, All submitted pages and Unsubmitted pages only (loading the
 * other two views in the background in your signed-in browser), then opens the dashboard, which checks the numbers
 * against the report's tiles and saves them for everyone. It depends on how Search Console's pages work, which Google can change.
 */
import { useEffect, useState } from "react";
import { kvDel, kvGet, kvSet } from "./idb";
import { emptyIdxStore, mergeIdx, type IdxParsed, type IdxStore, type IdxView } from "./indexStats";

const SRC = String.raw`(function(){
var DASH=__DASH__,T='Copy page indexing: ';
function stop(m){alert(T+m);}
if(location.hostname!=='search.google.com'||location.pathname.indexOf('/search-console/index')!==0){stop('open Search Console > Indexing > Pages (the Page indexing report), then click this bookmark there.');return;}
var site='',cur='';try{var U=new URL(location.href);site=U.searchParams.get('resource_id')||'';cur=U.searchParams.get('pages')||'ALL_URLS';}catch(e){}
if(!site){stop('open the Page indexing report of a property first.');return;}
var VIEWS=['ALL_URLS','ALL_SUBMITTED_URLS','ALL_NON_SUBMITTED_URLS'];
if(VIEWS.indexOf(cur)<0)cur='';
var w=null;try{w=window.open(DASH+'/#idx-wait','_blank');}catch(e){}
function pad(n){return(n<10?'0':'')+n;}
function iso(d){return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());}
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
function seriesIn(blobs){var found=[],seen=0,keys={};
function scan(x,depth){if(x===null||typeof x!=='object'||depth>14||seen>300000)return;seen++;
if(Array.isArray(x)){
if(x.length>=7&&x.length<=2000){var rows=[];
for(var i=0;i<x.length;i++){var r=x[i];
if(Array.isArray(r)&&typeof r[0]==='number'&&r[0]>1.4e12&&r[0]<2.2e12&&Array.isArray(r[1])&&r[1].length>=2){
rows.push([iso(new Date(r[0]))].concat(r[1].map(function(v){var n=Number(v);return isFinite(n)?n:null;})));}}
if(rows.length>=7&&rows.length>=x.length*0.8){var key=JSON.stringify(rows[rows.length-1])+rows.length;if(!keys[key]){keys[key]=1;found.push(rows);}return;}}
for(var j=0;j<x.length;j++)scan(x[j],depth+1);}
else{for(var k in x)if(Object.prototype.hasOwnProperty.call(x,k))scan(x[k],depth+1);}}
for(var b=0;b<blobs.length;b++)scan(blobs[b],0);
return found.slice(0,6);}
function vis(e){try{var v=e.ownerDocument.defaultView;return e.getClientRects().length>0&&v.getComputedStyle(e).visibility!=='hidden';}catch(x){return false;}}
function reasonRows(doc){var out=[],trs=doc.querySelectorAll('tr,[role=row]');
for(var t=0;t<trs.length&&out.length<80;t++){if(!vis(trs[t]))continue;
var cells=trs[t].querySelectorAll('td,[role=cell],[role=gridcell]');if(cells.length<3)continue;
var a=(cells[0].innerText||'').trim(),n=(cells[cells.length-1].innerText||'').replace(/[,\s]/g,'');
if(a&&/^\d+$/.test(n))out.push([a,(cells[1].innerText||'').trim(),(cells[2].innerText||'').trim(),Number(n)]);}
return out;}
function tilesOf(s){var a=s.match(/Not indexed\s+([\d.,]+\s*[kKmMB]?)/),b=s.match(/(?:^|\n)Indexed\s+([\d.,]+\s*[kKmMB]?)/);
return {ni:a?a[1].replace(/\s+/g,''):'',idx:b?b[1].replace(/\s+/g,''):''};}
function scriptsOf(doc){var h='',ss=doc.getElementsByTagName('script');for(var i=0;i<ss.length;i++){var t=ss[i].textContent||'';if(t.indexOf('AF_initDataCallback')>=0)h+=t+'\n';}return h;}
function urlFor(v){return 'https://search.google.com/search-console/index?resource_id='+encodeURIComponent(site)+'&pages='+v;}
function viaFetch(v){return fetch(urlFor(v),{credentials:'include'}).then(function(r){return r.ok?r.text():'';}).catch(function(){return '';}).then(function(h){return h?seriesIn(grab(h)):[];});}
function viaFrame(v){return new Promise(function(res){var f=document.createElement('iframe'),done=false,n=0;
f.style.cssText='position:fixed;left:-13000px;top:0;width:1300px;height:2400px;border:0;';
function fin(x){if(done)return;done=true;try{f.parentNode.removeChild(f);}catch(e){}res(x);}
f.onload=function(){(function wait(){n++;var d=null;try{d=f.contentDocument;}catch(e){}
if(!d||!d.body){if(n>8){fin(null);return;}setTimeout(wait,250);return;}
var rows=reasonRows(d),tl=tilesOf(d.body.innerText||'');
if((rows.length&&tl.ni&&tl.idx)||n>100){fin({reasons:rows,tiles:tl,series:seriesIn(grab(scriptsOf(d)))});}
else setTimeout(wait,250);})();};
f.src=urlFor(v);document.body.appendChild(f);setTimeout(function(){fin(null);},35000);});}
var views={};
function one(v){
if(v===cur){var rows=reasonRows(document),tl=tilesOf(document.body.innerText||'');
return viaFetch(v).then(function(s){views[v]={tiles:tl,series:s,reasons:rows,from:'page'};});}
return viaFrame(v).then(function(r){
if(r&&r.series.length){views[v]={tiles:r.tiles,series:r.series,reasons:r.reasons,from:'frame'};return;}
return viaFetch(v).then(function(s){views[v]={tiles:r?r.tiles:{ni:'',idx:''},series:s,reasons:r?r.reasons:[],from:r?'frame':'fetch'};});});}
var chain=Promise.resolve();
VIEWS.forEach(function(v){chain=chain.then(function(){return one(v);});});
chain.then(function(){
var any=false;for(var k in views)if(views[k].series.length)any=true;
if(!any){if(w)w.close();stop('no daily Indexed / Not indexed numbers were found. Reload the report (F5), wait for the chart, and click the bookmark again.');return;}
var json=JSON.stringify({v:1,src:'gsc-page-indexing',site:site,current:cur,capturedAt:new Date().toISOString(),views:views});
if(w&&!w.closed){w.location.href=DASH+'/#idxstats='+encodeURIComponent(json);return;}
var ok=T+'copied. Open the dashboard (Indexing tab) and paste it under "Paste page indexing".';
function legacy(s){var ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();if(done)alert(ok);else prompt('Copy this text (Ctrl+C), then paste it into the dashboard:',s);}
try{navigator.clipboard.writeText(json).then(function(){alert(ok);},function(){legacy(json);});}catch(e){legacy(json);}
});
})();`;

/** The bookmark for this dashboard (it needs to know where to send the data). */
export const idxBookmarkletFor = (dashboardOrigin: string) =>
  "javascript:" + encodeURIComponent(SRC.replace("__DASH__", JSON.stringify(dashboardOrigin)));

/** The Page indexing report for a property and view. */
export const pageIndexingUrl = (site: string, view: IdxView = "ALL_URLS") =>
  `https://search.google.com/search-console/index?resource_id=${encodeURIComponent(site)}&pages=${view}`;

/* ---------- Reading what the bookmark sent (shared with the server, for the Chrome extension) ---------- */

export { parseIdxCapture, type IdxCaptureResult } from "./capture/parseIdx";

/* ---------- Saved data, shared by every component that shows it ---------- */

export type IdxState = { store: IdxStore; shared: boolean; note?: string };
const mem = new Map<string, IdxState>();
const loading = new Map<string, Promise<IdxState>>();
const subs = new Set<(site: string, s: IdxState) => void>();
const localKey = (site: string) => `dash:idx:${site}`;

function publish(site: string, s: IdxState) {
  mem.set(site, s);
  subs.forEach((f) => f(site, s));
}

async function localStore(site: string): Promise<IdxStore> {
  try {
    return (await kvGet<IdxStore>(localKey(site))) || emptyIdxStore();
  } catch {
    return emptyIdxStore();
  }
}

export function loadIdx(site: string, force = false): Promise<IdxState> {
  if (!force && mem.has(site)) return Promise.resolve(mem.get(site)!);
  if (!force && loading.has(site)) return loading.get(site)!;
  const p = (async (): Promise<IdxState> => {
    try {
      const r = await fetch(`/api/index-stats?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      if (r.status === 501) return { store: await localStore(site), shared: false };
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      return { store: (j.store as IdxStore) || emptyIdxStore(), shared: true };
    } catch (e) {
      return {
        store: await localStore(site),
        shared: false,
        note: `Couldn't reach shared storage (${e instanceof Error ? e.message : "error"}). Showing data saved in this browser.`,
      };
    }
  })().then((s) => {
    loading.delete(site);
    publish(site, s);
    return s;
  });
  loading.set(site, p);
  return p;
}

/** Saved page indexing data for a property; updates everywhere after a save. Null while loading. */
export function useIdxStore(site: string): IdxState | null {
  const [s, setS] = useState<IdxState | null>(() => mem.get(site) ?? null);
  useEffect(() => {
    setS(mem.get(site) ?? null);
    const f = (x: string, v: IdxState) => {
      if (x === site) setS(v);
    };
    subs.add(f);
    loadIdx(site).catch(() => {});
    return () => {
      subs.delete(f);
    };
  }, [site]);
  return s;
}

export async function saveIdx(site: string, parsed: IdxParsed): Promise<IdxState> {
  const cur = await loadIdx(site);
  if (cur.shared) {
    const r = await fetch("/api/index-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site, parsed }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Saving failed (${r.status})`);
    const s: IdxState = { store: j.store as IdxStore, shared: true };
    publish(site, s);
    return s;
  }
  const store = mergeIdx(cur.store, parsed);
  await kvSet(localKey(site), store);
  const s: IdxState = { store, shared: false };
  publish(site, s);
  return s;
}

export async function clearIdx(site: string): Promise<void> {
  const cur = await loadIdx(site);
  if (cur.shared) {
    const r = await fetch(`/api/index-stats?site=${encodeURIComponent(site)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Delete failed (${r.status})`);
  } else {
    await kvDel(localKey(site));
  }
  publish(site, { store: emptyIdxStore(), shared: cur.shared });
}
