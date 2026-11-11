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
import { IDX_LABEL, IDX_VIEWS, emptyIdxStore, latestIdxDay, mergeIdx, type IdxDay, type IdxParsed, type IdxReason, type IdxStore, type IdxView } from "./indexStats";

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

/* ---------- Reading what the bookmark sent ---------- */

type Shown = { value: number; tol: number };
type CapView = {
  tiles?: { ni?: string; idx?: string };
  series?: (string | number | null)[][][];
  reasons?: [string, string, string, number][];
  from?: string;
};
type Capture = { v: number; src: string; site: string; current?: string; capturedAt: string; views?: Record<string, CapView> };

export type IdxCaptureResult = { parsed: IdxParsed; verified: boolean; summary: string; notes: string[]; problem?: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BAD = "That doesn't look like data from the “Copy page indexing” bookmark. Click the bookmark on the Page indexing report in Search Console.";

/** "16.9k" → 16,900 ± 50 (half of the last digit shown). */
function shown(s?: string): Shown | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.(\d+))?)\s*(bn|b|m|k)?$/i);
  if (!m) return null;
  const unit = (m[3] || "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" || unit === "bn" ? 1e9 : 1;
  return { value: Number(m[1]) * mult, tol: (0.5 * mult) / 10 ** (m[2]?.length ?? 0) };
}
const near = (x: number, t: Shown, slack: number) => Math.abs(x - t.value) <= t.tol + t.value * slack;

type Order = [number, number]; // [Not indexed column, Indexed column] in each row: [date, a, b, c]
const ORDERS: Order[] = [[1, 2], [2, 1]];

const lastRow = (s: (string | number | null)[][], o: Order) =>
  [...s].reverse().find((r) => typeof r[o[0]] === "number" && typeof r[o[1]] === "number");

const nonZero = (s: (string | number | null)[][]) => s.some((r) => (Number(r[1]) || 0) + (Number(r[2]) || 0) > 0);

function build(s: (string | number | null)[][], o: Order): Record<string, IdxDay> {
  const days: Record<string, IdxDay> = {};
  const impCol = [1, 2, 3].find((c) => c !== o[0] && c !== o[1]) ?? 3;
  for (const r of s) {
    const d = r[0], a = r[o[0]], b = r[o[1]];
    if (typeof d !== "string" || !DATE.test(d) || typeof a !== "number" || typeof b !== "number") continue;
    const imp = r[impCol];
    days[d] = { notIndexed: Math.round(a), indexed: Math.round(b), ...(typeof imp === "number" ? { impressions: Math.round(imp) } : {}) };
  }
  return days;
}

export function parseIdxCapture(text: string, site: string): IdxCaptureResult {
  let cap: Capture;
  try {
    cap = JSON.parse(text.trim());
  } catch {
    throw new Error(BAD);
  }
  if (!cap || cap.src !== "gsc-page-indexing" || !cap.views || typeof cap.views !== "object") throw new Error(BAD);
  if (cap.v !== 1) throw new Error("This came from a different version of the “Copy page indexing” bookmark. Drag the current one from the Indexing tab.");
  const norm = (s: string) => s.trim().toLowerCase().replace(/\/+$/, "");
  if (cap.site && site && norm(cap.site) !== norm(site)) {
    throw new Error(`This was copied from ${cap.site}, but the dashboard is showing ${site}, and your account can't open ${cap.site} here.`);
  }

  // First, views whose tiles can be matched: this also tells us which column is Indexed.
  const picks: Partial<Record<IdxView, { s: (string | number | null)[][]; o: Order; ok: boolean }>> = {};
  let learned: Order | null = null;
  for (const v of IDX_VIEWS) {
    const cv = cap.views[v];
    if (!cv) continue;
    const ni = shown(cv.tiles?.ni), ix = shown(cv.tiles?.idx);
    const cands = (cv.series || []).filter((s) => Array.isArray(s) && s.length && nonZero(s));
    if (!ni || !ix) continue;
    for (const s of cands) {
      for (const o of ORDERS) {
        const r = lastRow(s, o);
        if (r && near(r[o[0]] as number, ni, 0.002) && near(r[o[1]] as number, ix, 0.002)) {
          picks[v] = { s, o, ok: true };
          learned = learned || o;
          break;
        }
      }
      if (picks[v]) break;
    }
  }
  // Then the rest: the busiest series, read with the column order learned above.
  for (const v of IDX_VIEWS) {
    if (picks[v]) continue;
    const cands = (cap.views[v]?.series || []).filter((s) => Array.isArray(s) && s.length && nonZero(s));
    if (!cands.length) continue;
    const o = learned || ORDERS[0];
    const s = cands.slice().sort((a, b) => {
      const ra = lastRow(a, o), rb = lastRow(b, o);
      return ((rb ? (rb[1] as number) + (rb[2] as number) : 0) - (ra ? (ra[1] as number) + (ra[2] as number) : 0)) || b.length - a.length;
    })[0];
    picks[v] = { s, o, ok: false };
  }

  const parsed: IdxParsed = {};
  const notes: string[] = [];
  const parts: string[] = [];
  for (const v of IDX_VIEWS) {
    const pk = picks[v];
    const cv = cap.views[v];
    if (!pk) {
      notes.push(`${IDX_LABEL[v]} couldn't be read.`);
      continue;
    }
    const days = build(pk.s, pk.o);
    const dates = Object.keys(days).sort();
    if (!dates.length) {
      notes.push(`${IDX_LABEL[v]} had no daily numbers.`);
      continue;
    }
    const reasons: IdxReason[] = (cv?.reasons || [])
      .filter((r) => Array.isArray(r) && typeof r[0] === "string" && Number.isInteger(Number(r[3])))
      .map((r) => ({
        reason: String(r[0]).replace(/\s+/g, " ").trim(),
        source: String(r[1] || "").replace(/\s+/g, " ").trim(),
        validation: String(r[2] || "").replace(/\s+/g, " ").trim(),
        pages: Number(r[3]),
      }));
    const asOf = dates[dates.length - 1];
    parsed[v] = { days, reasons, asOf };
    const L = latestIdxDay({ days, reasons, reasonsHistory: {} })!;
    parts.push(`${IDX_LABEL[v]}: ${L.indexed.toLocaleString()} indexed · ${L.notIndexed.toLocaleString()} not indexed`);
    if (!reasons.length) notes.push(`The reasons for ${IDX_LABEL[v]} weren't read; choose that view on the report and click the bookmark there.`);
    if (!pk.ok) notes.push(`${IDX_LABEL[v]} couldn't be checked against its tiles.`);
  }
  if (!Object.keys(parsed).length) throw new Error("No daily Indexed / Not indexed numbers were found. Reload the report (F5) and click the bookmark again.");

  const cur = IDX_VIEWS.includes(cap.current as IdxView) ? (cap.current as IdxView) : null;
  const verified = cur ? !!picks[cur]?.ok : IDX_VIEWS.some((v) => picks[v]?.ok);
  const asOf = Object.values(parsed).map((p) => p!.asOf).sort().pop();
  return {
    parsed,
    verified,
    summary: `${parts.join("; ")} (as of ${asOf})`,
    notes,
    problem: verified
      ? undefined
      : "The daily numbers didn't match the report's Indexed / Not indexed tiles, so nothing was saved. Reload the report (F5) and click the bookmark again, or save anyway.",
  };
}

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
