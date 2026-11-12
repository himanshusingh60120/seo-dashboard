// The readers that run inside Search Console tabs. Chrome copies each function into the page, so each one is
// self-contained. They mirror the dashboard's bookmarks and return { capture } or { error }.

/* ---------------- Page indexing ---------------- */
export async function scrapeIndexing(site) {
  const VIEWS = ["ALL_URLS", "ALL_SUBMITTED_URLS", "ALL_NON_SUBMITTED_URLS"];
  const cur = "ALL_URLS";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => (n < 10 ? "0" : "") + n;
  const iso = (d) => d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());

  function grab(t) {
    const out = [];
    let k = 0;
    while ((k = t.indexOf("data:", k)) >= 0) {
      let s = k + 5;
      while (t.charAt(s) === " ") s++;
      const c0 = t.charAt(s);
      if (c0 !== "[" && c0 !== "{") { k = s; continue; }
      let d = 0, q = null, e = s;
      for (; e < t.length; e++) {
        const c = t.charAt(e);
        if (q) { if (c === "\\") { e++; continue; } if (c === q) q = null; continue; }
        if (c === '"') { q = c; continue; }
        if (c === "[" || c === "{") d++;
        else if (c === "]" || c === "}") { d--; if (d === 0) break; }
      }
      try { out.push(JSON.parse(t.slice(s, e + 1))); } catch (x) {}
      k = e + 1;
    }
    return out;
  }
  function seriesIn(blobs) {
    const found = [], keys = {};
    let seen = 0;
    function scan(x, depth) {
      if (x === null || typeof x !== "object" || depth > 14 || seen > 300000) return;
      seen++;
      if (Array.isArray(x)) {
        if (x.length >= 7 && x.length <= 2000) {
          const rows = [];
          for (const r of x) {
            if (Array.isArray(r) && typeof r[0] === "number" && r[0] > 1.4e12 && r[0] < 2.2e12 && Array.isArray(r[1]) && r[1].length >= 2) {
              rows.push([iso(new Date(r[0]))].concat(r[1].map((v) => { const n = Number(v); return isFinite(n) ? n : null; })));
            }
          }
          if (rows.length >= 7 && rows.length >= x.length * 0.8) {
            const key = JSON.stringify(rows[rows.length - 1]) + rows.length;
            if (!keys[key]) { keys[key] = 1; found.push(rows); }
            return;
          }
        }
        for (const y of x) scan(y, depth + 1);
      } else {
        for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k)) scan(x[k], depth + 1);
      }
    }
    for (const b of blobs) scan(b, 0);
    return found.slice(0, 6);
  }
  function vis(e) {
    try { const v = e.ownerDocument.defaultView; return e.getClientRects().length > 0 && v.getComputedStyle(e).visibility !== "hidden"; } catch (x) { return false; }
  }
  function reasonRows(doc) {
    const out = [], trs = doc.querySelectorAll("tr,[role=row]");
    for (let t = 0; t < trs.length && out.length < 80; t++) {
      if (!vis(trs[t])) continue;
      const cells = trs[t].querySelectorAll("td,[role=cell],[role=gridcell]");
      if (cells.length < 3) continue;
      const a = (cells[0].innerText || "").trim(), n = (cells[cells.length - 1].innerText || "").replace(/[,\s]/g, "");
      if (a && /^\d+$/.test(n)) out.push([a, (cells[1].innerText || "").trim(), (cells[2].innerText || "").trim(), Number(n)]);
    }
    return out;
  }
  function tilesOf(s) {
    const a = s.match(/Not indexed\s+([\d.,]+\s*[kKmMB]?)/), b = s.match(/(?:^|\n)Indexed\s+([\d.,]+\s*[kKmMB]?)/);
    return { ni: a ? a[1].replace(/\s+/g, "") : "", idx: b ? b[1].replace(/\s+/g, "") : "" };
  }
  function scriptsOf(doc) {
    let h = "";
    for (const sc of doc.getElementsByTagName("script")) { const t = sc.textContent || ""; if (t.indexOf("AF_initDataCallback") >= 0) h += t + "\n"; }
    return h;
  }
  const urlFor = (v) => "https://search.google.com/search-console/index?resource_id=" + encodeURIComponent(site) + "&pages=" + v;
  async function viaFetch(v) {
    let h = "";
    try { const r = await fetch(urlFor(v), { credentials: "include" }); h = r.ok ? await r.text() : ""; } catch (e) {}
    return h ? seriesIn(grab(h)) : [];
  }
  function viaFrame(v) {
    return new Promise((res) => {
      const f = document.createElement("iframe");
      let done = false, n = 0;
      f.style.cssText = "position:fixed;left:-13000px;top:0;width:1300px;height:2400px;border:0;";
      const fin = (x) => { if (done) return; done = true; try { f.remove(); } catch (e) {} res(x); };
      f.onload = () => {
        (function wait() {
          n++;
          let d = null;
          try { d = f.contentDocument; } catch (e) {}
          if (!d || !d.body) { if (n > 8) { fin(null); return; } setTimeout(wait, 250); return; }
          const rows = reasonRows(d), tl = tilesOf(d.body.innerText || "");
          if ((rows.length && tl.ni && tl.idx) || n > 100) fin({ reasons: rows, tiles: tl, series: seriesIn(grab(scriptsOf(d))) });
          else setTimeout(wait, 250);
        })();
      };
      f.src = urlFor(v);
      document.body.appendChild(f);
      setTimeout(() => fin(null), 35000);
    });
  }

  for (let i = 0; i < 60; i++) {
    const tl = tilesOf(document.body.innerText || "");
    if (tl.ni && tl.idx) break;
    await sleep(500);
  }
  if (!/\/search-console\/index/.test(location.pathname) || !tilesOf(document.body.innerText || "").idx) {
    return { error: "The Page indexing report didn't load. Check that this Google account can open the property in Search Console." };
  }
  const views = {};
  for (const v of VIEWS) {
    if (v === cur) {
      views[v] = { tiles: tilesOf(document.body.innerText || ""), series: await viaFetch(v), reasons: reasonRows(document), from: "page" };
      continue;
    }
    const r = await viaFrame(v);
    if (r && r.series.length) { views[v] = { tiles: r.tiles, series: r.series, reasons: r.reasons, from: "frame" }; continue; }
    views[v] = { tiles: r ? r.tiles : { ni: "", idx: "" }, series: await viaFetch(v), reasons: r ? r.reasons : [], from: r ? "frame" : "fetch" };
  }
  if (!Object.values(views).some((x) => x.series.length)) return { error: "No daily Indexed / Not indexed numbers were found on the report." };
  return { capture: { v: 1, src: "gsc-page-indexing", site, current: cur, capturedAt: new Date().toISOString(), views } };
}

/* ---------------- Crawl stats ---------------- */
export function clickPurpose(label) {
  const re = new RegExp("^" + label + "\\b", "i");
  const visible = (e) => e.getClientRects().length > 0;
  for (const row of document.querySelectorAll("tr,[role=row]")) {
    const first = row.querySelector("td,[role=cell],[role=gridcell]");
    if (first && visible(row) && re.test((first.innerText || "").trim())) { (row.querySelector("a,[role=link]") || row).click(); return true; }
  }
  for (const e of document.querySelectorAll("a,[role=link],[role=button]")) {
    const t = (e.innerText || "").trim();
    if (visible(e) && re.test(t) && t.length < 60) { e.click(); return true; }
  }
  return false;
}

export async function scrapeCrawl(site, known) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) { if (/Total crawl requests/.test(document.body.innerText || "")) break; await sleep(500); }
  const txt = document.body.innerText || "";
  if (!/Total crawl requests/.test(txt)) return { error: "The Crawl stats report didn't load. Check that this Google account can open the property in Search Console." };

  const pad = (n) => (n < 10 ? "0" : "") + n;
  const iso = (d) => d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  const isNum = (n) => typeof n === "number" && isFinite(n);
  function dateOf(v) {
    if (typeof v === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      if (/^\d{8}$/.test(v) || /^\d{10}$/.test(v) || /^\d{13}$/.test(v)) v = Number(v);
      else return null;
    }
    if (isNum(v)) {
      if (v > 19000000 && v < 21000000) { const s = String(v); return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8); }
      if (v > 1.4e12 && v < 2.2e12) return iso(new Date(v));
      if (v > 1.4e9 && v < 2.2e9) return iso(new Date(v * 1000));
      return null;
    }
    if (Array.isArray(v) && v.length >= 3 && v.length <= 4 && isNum(v[0]) && v[0] > 2000 && v[0] < 2100 && v[1] >= 1 && v[1] <= 12 && v[2] >= 1 && v[2] <= 31) return v[0] + "-" + pad(v[1]) + "-" + pad(v[2]);
    return null;
  }
  function flat(x, depth, out) {
    if (Array.isArray(x) && depth < 4) { const d = dateOf(x); if (d) { out.push({ d }); return; } for (const y of x) flat(y, depth + 1, out); }
    else out.push({ v: x });
  }
  function rowOf(el) {
    if (!Array.isArray(el)) return null;
    const parts = []; flat(el, 0, parts);
    let date = null; const nums = [];
    for (const p of parts) {
      if (p.d) { if (!date) date = p.d; continue; }
      const v = p.v;
      if (!date) { const dd = dateOf(v); if (dd) { date = dd; continue; } }
      if (isNum(v)) nums.push(v);
      else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) nums.push(Number(v));
    }
    return date && nums.length ? [date].concat(nums) : null;
  }
  function seriesIn(blobs) {
    const found = []; let seen = 0;
    function scan(x, path, depth) {
      if (x === null || typeof x !== "object" || depth > 14 || seen > 300000) return;
      seen++;
      if (Array.isArray(x)) {
        if (x.length >= 7 && x.length <= 1500) {
          const rows = [], dates = {};
          for (const y of x) { const r = rowOf(y); if (r && !dates[r[0]]) { dates[r[0]] = 1; rows.push(r); } }
          if (rows.length >= 7 && rows.length >= x.length * 0.8) { found.push({ path, rows }); return; }
        }
        x.forEach((y, j) => scan(y, path + "." + j, depth + 1));
      } else {
        for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k)) scan(x[k], path + "." + k, depth + 1);
      }
    }
    blobs.forEach((b, i) => scan(b, "ds" + i, 0));
    found.sort((a, b) => b.rows.length - a.rows.length);
    return found.slice(0, 6);
  }
  function grab(t) {
    const out = []; let k = 0;
    while ((k = t.indexOf("data:", k)) >= 0) {
      let s = k + 5;
      while (t.charAt(s) === " ") s++;
      const c0 = t.charAt(s);
      if (c0 !== "[" && c0 !== "{") { k = s; continue; }
      let d = 0, q = null, e = s;
      for (; e < t.length; e++) {
        const c = t.charAt(e);
        if (q) { if (c === "\\") { e++; continue; } if (c === q) q = null; continue; }
        if (c === '"') { q = c; continue; }
        if (c === "[" || c === "{") d++;
        else if (c === "]" || c === "}") { d--; if (d === 0) break; }
      }
      try { out.push(JSON.parse(t.slice(s, e + 1))); } catch (x) {}
      k = e + 1;
    }
    return out;
  }

  const tile = (re) => { const m = txt.match(re); return m ? m[1].replace(/\s+/g, "") : ""; };
  const tiles = {
    requests: tile(/Total crawl requests\s+([\d.,]+\s*(?:bn|[kKmMB])?)/),
    bytes: tile(/Total download size \(bytes\)\s+([\d.,]+\s*(?:bn|[kKmMB])?)/),
    ms: tile(/Average response time \(ms\)\s+([\d.,]+)/),
  };
  const cm = txt.match(/Crawl requests:\s*([^\n]+)/);
  const hereLabel = cm ? cm[1].trim() : "";
  const hereKind = !cm ? "total" : /^refresh/i.test(hereLabel) ? "refresh" : /^discover/i.test(hereLabel) ? "discovery" : "other";
  const links = Object.assign({}, known || {});
  const LS = "dashCrawlLinks:" + site;
  try { Object.assign(links, JSON.parse(localStorage.getItem(LS) || "{}") || {}); } catch (e) {}
  if (hereKind === "refresh" || hereKind === "discovery") links[hereKind] = location.href;
  for (const a of document.querySelectorAll("a[href]")) {
    const at = (a.innerText || "").trim(), ah = a.href;
    if (ah.indexOf("crawl") < 0) continue;
    if (/^Refresh\b/i.test(at)) links.refresh = ah;
    else if (/^Discovery\b/i.test(at)) links.discovery = ah;
  }
  try { localStorage.setItem(LS, JSON.stringify(links)); } catch (e) {}

  let dom = [];
  for (const sc of document.getElementsByTagName("script")) { const st = sc.textContent || ""; if (st.indexOf("AF_initDataCallback") >= 0) dom = dom.concat(grab(st)); }
  const domSeries = seriesIn(dom);
  const mainUrl = "https://search.google.com/search-console/settings/crawl-stats?resource_id=" + encodeURIComponent(site);
  const jobs = [{ kind: "total", label: "All crawl requests", url: hereKind === "total" ? location.href : mainUrl }];
  if (links.refresh) jobs.push({ kind: "refresh", label: "Refresh", url: links.refresh });
  if (links.discovery) jobs.push({ kind: "discovery", label: "Discovery", url: links.discovery });
  if (hereKind === "other") jobs.push({ kind: "other", label: hereLabel, url: location.href });
  const missing = [];
  if (!links.refresh) missing.push("refresh");
  if (!links.discovery) missing.push("discovery");

  const load = async (j) => {
    let h = "";
    try { const r = await fetch(j.url, { credentials: "include" }); h = r.ok ? await r.text() : ""; } catch (e) {}
    let sr = h ? seriesIn(grab(h)) : [];
    if (j.kind === hereKind) { j.tiles = tiles; if (!sr.length) sr = domSeries; }
    j.series = sr;
    return j;
  };
  const pages = (await Promise.all(jobs.map(load))).filter((p) => p.series.length);
  if (!pages.length) return { error: "No daily crawl data was found on the Crawl stats report." };
  return { capture: { v: 2, src: "gsc-crawl-stats", site, capturedAt: new Date().toISOString(), pages, missing } };
}

/* ---------------- Generative AI report ---------------- */
export async function openAiReport() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => e.getClientRects().length > 0;
  for (let i = 0; i < 60; i++) {
    // 1. Left menu: Performance → Search results → Generative AI
    for (const e of document.querySelectorAll("a[href],[role=link],[role=menuitem]")) {
      const href = e.getAttribute("href") || "";
      const t = (e.innerText || "").trim();
      if (visible(e) && (/\/search-analytics\/ai\b/.test(href) || /^generative ai$/i.test(t))) {
        e.click();
        return { clicked: true };
      }
    }
    // 2. Older layout: an "Open report" button in the generative AI box on the Performance page
    for (const e of document.querySelectorAll("a,button,[role=button],[role=link]")) {
      const label = ((e.innerText || "") + " " + (e.getAttribute("aria-label") || "")).trim();
      if (!/open report/i.test(label) || !visible(e)) continue;
      let box = e.parentElement;
      for (let k = 0; k < 8 && box; k++, box = box.parentElement) {
        const t = box.innerText || "";
        if (t.length > 800) break;
        if (/generative ai/i.test(t)) {
          e.click();
          return { clicked: true };
        }
      }
    }
    await sleep(500);
  }
  return { clicked: false };
}

export async function scrapeAi(site) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80; i++) {
    const t = document.body.innerText || "";
    if (/Total impressions/.test(t) && !/Total clicks/.test(t)) break;
    await sleep(500);
  }
  const txt = document.body.innerText || "";
  if (/Total clicks/.test(txt) || !/Generative AI/i.test(txt)) return { error: "This isn't the Generative AI features report.", notReport: true };
  const tm = txt.match(/Total impressions\s+([\d.,]+\s*(?:bn|[kKmMB])?)/);
  if (!tm) return { error: "The report's Total impressions didn't load.", notReport: true };

  const pad = (n) => (n < 10 ? "0" : "") + n;
  const iso = (d) => d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  const isNum = (n) => typeof n === "number" && isFinite(n);
  function dateOf(v) {
    if (typeof v === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
      if (/^\d{8}$/.test(v) || /^\d{10}$/.test(v) || /^\d{13}$/.test(v)) v = Number(v);
      else return null;
    }
    if (isNum(v)) {
      if (v > 19000000 && v < 21000000) { const s = String(v); return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8); }
      if (v > 1.4e12 && v < 2.2e12) return iso(new Date(v));
      if (v > 1.4e9 && v < 2.2e9) return iso(new Date(v * 1000));
      return null;
    }
    if (Array.isArray(v) && v.length >= 3 && v.length <= 4 && isNum(v[0]) && v[0] > 2000 && v[0] < 2100 && v[1] >= 1 && v[1] <= 12 && v[2] >= 1 && v[2] <= 31) return v[0] + "-" + pad(v[1]) + "-" + pad(v[2]);
    return null;
  }
  function flat(x, depth, out) {
    if (Array.isArray(x) && depth < 4) { const d = dateOf(x); if (d) { out.push({ d }); return; } for (const y of x) flat(y, depth + 1, out); }
    else out.push({ v: x });
  }
  function rowOf(el) {
    if (!Array.isArray(el)) return null;
    const parts = []; flat(el, 0, parts);
    let date = null; const nums = [];
    for (const p of parts) {
      if (p.d) { if (!date) date = p.d; continue; }
      const v = p.v;
      if (!date) { const dd = dateOf(v); if (dd) { date = dd; continue; } }
      if (isNum(v)) nums.push(v);
      else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) nums.push(Number(v));
    }
    return date && nums.length ? [date].concat(nums) : null;
  }
  function urlRow(el) {
    if (!Array.isArray(el)) return null;
    const parts = []; flat(el, 0, parts);
    let url = null; const nums = [];
    for (const p of parts) {
      const v = p.v;
      if (!url && typeof v === "string" && /^https?:\/\/\S+$/.test(v)) { url = v; continue; }
      if (isNum(v)) nums.push(v);
      else if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) nums.push(Number(v));
    }
    return url && nums.length ? [url].concat(nums) : null;
  }
  function seriesIn(blobs) {
    const found = []; let seen = 0;
    function scan(x, path, depth) {
      if (x === null || typeof x !== "object" || depth > 14 || seen > 300000) return;
      seen++;
      if (Array.isArray(x)) {
        if (x.length >= 7 && x.length <= 1500) {
          const rows = [], dates = {};
          for (const y of x) { const r = rowOf(y); if (r && !dates[r[0]]) { dates[r[0]] = 1; rows.push(r); } }
          if (rows.length >= 7 && rows.length >= x.length * 0.8) { found.push({ path, rows }); return; }
        }
        x.forEach((y, j) => scan(y, path + "." + j, depth + 1));
      } else {
        for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k)) scan(x[k], path + "." + k, depth + 1);
      }
    }
    blobs.forEach((b, i) => scan(b, "ds" + i, 0));
    found.sort((a, b) => b.rows.length - a.rows.length);
    return found.slice(0, 6);
  }
  function pagesIn(blobs) {
    const found = []; let seen = 0;
    function scan(x, path, depth) {
      if (x === null || typeof x !== "object" || depth > 14 || seen > 300000) return;
      seen++;
      if (Array.isArray(x)) {
        if (x.length >= 2 && x.length <= 25000) {
          const rows = [], urls = {};
          for (const y of x) { const r = urlRow(y); if (r && !urls[r[0]]) { urls[r[0]] = 1; rows.push(r); } }
          if (rows.length >= 2 && rows.length >= x.length * 0.8) { found.push({ path, rows: rows.slice(0, 5000) }); return; }
        }
        x.forEach((y, j) => scan(y, path + "." + j, depth + 1));
      } else {
        for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k)) scan(x[k], path + "." + k, depth + 1);
      }
    }
    blobs.forEach((b, i) => scan(b, "ds" + i, 0));
    return found;
  }
  function grab(t) {
    const out = []; let k = 0;
    while ((k = t.indexOf("data:", k)) >= 0) {
      let s = k + 5;
      while (t.charAt(s) === " ") s++;
      const c0 = t.charAt(s);
      if (c0 !== "[" && c0 !== "{") { k = s; continue; }
      let d = 0, q = null, e = s;
      for (; e < t.length; e++) {
        const c = t.charAt(e);
        if (q) { if (c === "\\") { e++; continue; } if (c === q) q = null; continue; }
        if (c === '"') { q = c; continue; }
        if (c === "[" || c === "{") d++;
        else if (c === "]" || c === "}") { d--; if (d === 0) break; }
      }
      try { out.push(JSON.parse(t.slice(s, e + 1))); } catch (x) {}
      k = e + 1;
    }
    return out;
  }
  function vis(e) { try { return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; } catch (x) { return false; } }
  function rowsNow() {
    const out = [], trs = document.querySelectorAll("tr,[role=row]");
    for (let t = 0; t < trs.length && out.length < 1000; t++) {
      if (!vis(trs[t])) continue;
      const cells = trs[t].querySelectorAll("td,[role=cell],[role=gridcell]");
      if (cells.length < 2) continue;
      const a = (cells[0].innerText || "").trim(), n = (cells[cells.length - 1].innerText || "").replace(/[,\s]/g, "");
      if (a && /^\d+$/.test(n)) out.push([a, Number(n)]);
    }
    return out;
  }
  const DEVW = /\b(desktop|mobile|tablet)\b/i;
  const isUrl = (l) => /^https?:\/\/\S+$/.test(l);
  const urlRowsNow = () => rowsNow().filter((r) => isUrl(r[0]));
  function press(e) {
    ["mousedown", "mouseup", "click"].forEach((t) => { try { e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (x) {} });
  }
  function tabEl(name) {
    for (const e of document.querySelectorAll("[role=tab]")) if (vis(e) && (e.innerText || "").trim().toUpperCase() === name) return e;
    for (const e of document.querySelectorAll("button,a,span,div")) if (e.children.length <= 2 && vis(e) && (e.innerText || "").trim().toUpperCase() === name) return e;
    return null;
  }
  function viaTab(name, ok) {
    if (!tabEl(name)) return Promise.resolve(null);
    let n = 0;
    return sleep(700).then(() => new Promise((res) => {
      (function wait() {
        if (n % 8 === 0) { const t = tabEl(name); if (t) { try { t.click(); } catch (x) {} } }
        n++;
        const rows = rowsNow().filter((r) => ok(r[0]));
        if (rows.length) { sleep(400).then(() => res(rowsNow().filter((r) => ok(r[0])))); return; }
        if (n > 60) { res([]); return; }
        setTimeout(wait, 250);
      })();
    }));
  }
  function btnBy(re) {
    for (const e of document.querySelectorAll("[aria-label]")) if (vis(e) && re.test(e.getAttribute("aria-label") || "")) return e;
    return null;
  }
  function setPageSize() {
    return new Promise((res) => {
      let lab = null;
      for (const e of document.querySelectorAll("div,span,label")) {
        if (e.children.length === 0 && vis(e) && /^Rows per page/i.test((e.innerText || "").trim())) { lab = e; break; }
      }
      if (!lab) { res(); return; }
      let box = lab.parentElement, dd = null;
      for (let k = 0; k < 3 && box && !dd; k++) { dd = box.querySelector("select,[role=listbox],[aria-haspopup]"); box = box.parentElement; }
      if (!dd) { res(); return; }
      if (dd.tagName === "SELECT") {
        let mx = null;
        for (const o of dd.options) if (!mx || Number(o.value) > Number(mx.value)) mx = o;
        if (mx) { dd.value = mx.value; dd.dispatchEvent(new Event("change", { bubbles: true })); }
        sleep(1500).then(res);
        return;
      }
      press(dd);
      sleep(600).then(() => {
        let best = null, bv = 0;
        for (const o of document.querySelectorAll("[role=option]")) {
          if (!vis(o)) continue;
          const v = parseInt((o.innerText || "").replace(/[^\d]/g, ""), 10);
          if (v > bv && v <= 1000) { bv = v; best = o; }
        }
        if (best) { press(best); sleep(2000).then(res); }
        else { try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (x) {} res(); }
      });
    });
  }
  function pageThrough() {
    const all = {};
    const take = () => { const rows = urlRowsNow(); for (const r of rows) all[r[0]] = r[1]; return rows.length ? rows[0][0] : ""; };
    return setPageSize().then(() => new Promise((res) => {
      let first = take(), pages = 0;
      (function next() {
        const b = btnBy(/next page/i);
        if (Object.keys(all).length >= 1000 || !b || b.disabled || b.getAttribute("aria-disabled") === "true") { res({ all, done: true }); return; }
        if (pages >= 200) { res({ all, done: false }); return; }
        try { b.click(); } catch (x) { res({ all, done: false }); return; }
        pages++;
        let tries = 0;
        (function wait() {
          const f = urlRowsNow(), sig = f.length ? f[0][0] : "";
          if (sig && sig !== first) sleep(200).then(() => { first = take(); next(); });
          else if (++tries > 40) res({ all, done: false });
          else setTimeout(wait, 150);
        })();
      })();
    }));
  }

  let table = urlRowsNow(), tableComplete = false;
  const tmap = {};
  for (const r of table) tmap[r[0]] = r[1];
  const agree = (c) => { let n = 0; for (const r of c.rows) { const v = tmap[r[0]]; if (v != null && r.indexOf(v, 1) > 0) n++; } return n; };
  let dom = [];
  for (const sc of document.getElementsByTagName("script")) { const st = sc.textContent || ""; if (st.indexOf("AF_initDataCallback") >= 0) dom = dom.concat(grab(st)); }
  let h = "";
  try { const r = await fetch(location.href, { credentials: "include" }); h = r.ok ? await r.text() : ""; } catch (e) {}
  const blobs = dom.concat(h ? grab(h) : []);
  const series = seriesIn(blobs);
  if (!series.length) return { error: "No daily AI impressions were found on the report." };
  const pages = pagesIn(blobs).map((c) => { c.agree = agree(c); return c; }).sort((a, b) => b.agree - a.agree || b.rows.length - a.rows.length).slice(0, 2);
  const debug = {};
  if (!(pages.length && pages[0].agree > 0) && table.length) {
    const p = await pageThrough();
    const list = Object.keys(p.all).map((u) => [u, p.all[u]]);
    if (list.length >= table.length) { table = list; tableComplete = p.done; }
    debug.pagedRows = list.length;
  }
  const c = await viaTab("COUNTRIES", (l) => !isUrl(l) && !DEVW.test(l));
  if (c === null) debug.countriesTab = "not found";
  const d = await viaTab("DEVICES", (l) => DEVW.test(l));
  if (d === null) debug.devicesTab = "not found";
  const countries = c || [], devices = d || [];
  if (!devices.length) debug.devicesSeen = rowsNow().slice(0, 5).map((r) => r[0]);
  const pt = tabEl("PAGES");
  if (pt) { try { pt.click(); } catch (x) {} }
  return {
    capture: {
      v: 2, src: "gsc-ai-impressions", site, url: location.href, capturedAt: new Date().toISOString(),
      tiles: { impressions: tm[1].replace(/\s+/g, "") }, series, pages, table, tableComplete, countries, devices, debug,
    },
  };
}
