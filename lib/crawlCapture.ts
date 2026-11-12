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

/* Reading what the bookmark sent lives in lib/capture/parseCrawl.ts, shared with the server (Chrome extension). */
export { parseCapture, type CaptureResult } from "./capture/parseCrawl";
