// lib/aiCapture.ts
"use client";
/**
 * One-click "Copy AI impressions" bookmark.
 * Clicked on Search Console's Generative AI features report, it reads the daily impressions, the full Pages list
 * (from the data in the page, or by paging through the table when that isn't available), and the Countries and Devices
 * tabs, then opens the dashboard, which checks that the days add up to the page's "Total impressions" and saves
 * everything for everyone. Search Console keeps earlier pages in the background, so the bookmark only uses visible
 * tabs and tables. It depends on how Search Console's pages work, which Google can change; the export import stays as the fallback.
 */

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
function urlRowsNow(){return rowsNow().filter(function(r){return isUrl(r[0]);});}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function press(e){['mousedown','mouseup','click'].forEach(function(t){try{e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));}catch(x){}});}
function tabEl(name){var els=document.querySelectorAll('[role=tab]');
for(var i=0;i<els.length;i++)if(vis(els[i])&&(els[i].innerText||'').trim().toUpperCase()===name)return els[i];
els=document.querySelectorAll('button,a,span,div');
for(var j=0;j<els.length;j++){var e=els[j];if(e.children.length<=2&&vis(e)&&(e.innerText||'').trim().toUpperCase()===name)return e;}
return null;}
function viaTab(name,ok){if(!tabEl(name))return Promise.resolve(null);
var n=0;return sleep(700).then(function(){return new Promise(function(res){
(function wait(){if(n%8===0){var t=tabEl(name);if(t){try{t.click();}catch(x){}}}
n++;var rows=rowsNow().filter(function(r){return ok(r[0]);});
if(rows.length){sleep(400).then(function(){res(rowsNow().filter(function(r){return ok(r[0]);}));});return;}
if(n>60){res([]);return;}
setTimeout(wait,250);})();});});}
function btnBy(re){var els=document.querySelectorAll('[aria-label]');
for(var i=0;i<els.length;i++){var e=els[i];if(vis(e)&&re.test(e.getAttribute('aria-label')||''))return e;}return null;}
function setPageSize(){return new Promise(function(res){
var els=document.querySelectorAll('div,span,label'),lab=null;
for(var i=0;i<els.length;i++){var e=els[i];if(e.children.length===0&&vis(e)&&/^Rows per page/i.test((e.innerText||'').trim())){lab=e;break;}}
if(!lab){res();return;}
var box=lab.parentElement,dd=null;
for(var k=0;k<3&&box&&!dd;k++){dd=box.querySelector('select,[role=listbox],[aria-haspopup]');box=box.parentElement;}
if(!dd){res();return;}
if(dd.tagName==='SELECT'){var mx=null;for(var s=0;s<dd.options.length;s++){if(!mx||Number(dd.options[s].value)>Number(mx.value))mx=dd.options[s];}
if(mx){dd.value=mx.value;dd.dispatchEvent(new Event('change',{bubbles:true}));}sleep(1500).then(res);return;}
press(dd);
sleep(600).then(function(){var opts=document.querySelectorAll('[role=option]'),best=null,bv=0;
for(var j=0;j<opts.length;j++){var o=opts[j];if(!vis(o))continue;var v=parseInt((o.innerText||'').replace(/[^\d]/g,''),10);if(v>bv&&v<=1000){bv=v;best=o;}}
if(best){press(best);sleep(2000).then(res);}
else{try{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));}catch(x){}res();}});});}
function pageThrough(){var all={};
function take(){var rows=urlRowsNow();for(var i=0;i<rows.length;i++)all[rows[i][0]]=rows[i][1];return rows.length?rows[0][0]:'';}
return setPageSize().then(function(){return new Promise(function(res){
var first=take(),pages=0;
(function next(){var b=btnBy(/next page/i);
if(Object.keys(all).length>=1000||!b||b.disabled||b.getAttribute('aria-disabled')==='true'){res({all:all,done:true});return;}
if(pages>=200){res({all:all,done:false});return;}
try{b.click();}catch(x){res({all:all,done:false});return;}pages++;
var tries=0;(function wait(){var f=urlRowsNow(),sig=f.length?f[0][0]:'';
if(sig&&sig!==first){sleep(200).then(function(){first=take();next();});}
else if(++tries>40){res({all:all,done:false});}
else setTimeout(wait,150);})();})();});});}
var table=urlRowsNow(),tableComplete=false;
var tmap={};for(var q=0;q<table.length;q++)tmap[table[q][0]]=table[q][1];
function agree(c){var n=0;for(var j=0;j<c.rows.length;j++){var r=c.rows[j],v=tmap[r[0]];if(v!=null&&r.indexOf(v,1)>0)n++;}return n;}
var dom=[],ss=document.getElementsByTagName('script');
for(var m=0;m<ss.length;m++){var st=ss[m].textContent||'';if(st.indexOf('AF_initDataCallback')>=0)dom=dom.concat(grab(st));}
var series=[],pages=[],countries=[],devices=[],debug={};
fetch(location.href,{credentials:'include'}).then(function(r){return r.ok?r.text():'';}).catch(function(){return '';})
.then(function(h){
var blobs=dom.concat(h?grab(h):[]);
series=seriesIn(blobs);
if(!series.length)return 'stop';
pages=pagesIn(blobs).map(function(c){c.agree=agree(c);return c;}).sort(function(a,b){return b.agree-a.agree||b.rows.length-a.rows.length;}).slice(0,2);
if((pages.length&&pages[0].agree>0)||!table.length)return null;
return pageThrough().then(function(p){var list=[];for(var u in p.all)list.push([u,p.all[u]]);
if(list.length>=table.length){table=list;tableComplete=p.done;}debug.pagedRows=list.length;});})
.then(function(x){if(x==='stop')return 'stop';
return viaTab('COUNTRIES',function(l){return !isUrl(l)&&!DEVW.test(l);})
.then(function(c){if(c===null)debug.countriesTab='not found';countries=c||[];return viaTab('DEVICES',function(l){return DEVW.test(l);});})
.then(function(d){if(d===null)debug.devicesTab='not found';devices=d||[];
if(!devices.length)debug.devicesSeen=rowsNow().slice(0,5).map(function(r){return r[0];});
var p=tabEl('PAGES');if(p){try{p.click();}catch(x){}}});})
.then(function(x){
if(x==='stop'){if(w)w.close();stop('no daily AI impressions were found on this page. Reload it (F5), wait for the chart, and click the bookmark again. If it keeps failing, use Export > Download CSV and import the file instead.');return;}
var json=JSON.stringify({v:2,src:'gsc-ai-impressions',site:site,url:location.href,capturedAt:new Date().toISOString(),tiles:{impressions:tm[1].replace(/\s+/g,'')},series:series,pages:pages,table:table,tableComplete:tableComplete,countries:countries,devices:devices,debug:debug});
if(w&&!w.closed){w.location.href=DASH+'/#aistats='+encodeURIComponent(json);return;}
var ok=T+'copied. Open the dashboard (Overview tab) and paste it under "Paste AI impressions".';
function legacy(s){var ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();if(done)alert(ok);else prompt('Copy this text (Ctrl+C), then paste it into the dashboard:',s);}
try{navigator.clipboard.writeText(json).then(function(){alert(ok);},function(){legacy(json);});}catch(e){legacy(json);}
});
})();`;

/** The bookmark for this dashboard (it needs to know where to send the data). */
export const aiBookmarkletFor = (dashboardOrigin: string) =>
  "javascript:" + encodeURIComponent(SRC.replace("__DASH__", JSON.stringify(dashboardOrigin)));

/* Reading what the bookmark sent lives in lib/capture/parseAi.ts, shared with the server (Chrome extension). */
export { parseAiCapture, type AiCaptureResult } from "./capture/parseAi";
