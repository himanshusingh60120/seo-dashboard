// Once a week (checked every hour while Chrome is open), copies Search Console's Page indexing, Crawl stats and
// Generative AI reports for every property enabled in the dashboard and sends them to the dashboard, which checks the
// numbers and saves them in the Google Sheet. It uses this Chrome profile's Google sign-in and works in a small
// window of its own that closes when it's done.
// When installed from the dashboard's "Download the extension" button, config.json already holds the dashboard address
// and the person's key, so no setup is needed.
import { clickPurpose, openAiReport, scrapeAi, scrapeCrawl, scrapeIndexing } from "./scrapers.js";

const KINDS = ["indexing", "crawl", "ai"];
const LABEL = { indexing: "Page indexing", crawl: "Crawl stats", ai: "AI impressions" };
const WEEK = 6.5 * 24 * 3600e3; // a little under 7 days, so the weekly run doesn't drift later each week
const RETRY = 12 * 3600e3; // after a failure, try again 12 hours later
const GSC = "https://search.google.com/search-console";
const store = chrome.storage.local;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copies the dashboard address and key from config.json (in the downloaded zip) when it's new. */
async function seed() {
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" });
    if (!res.ok) return;
    const c = await res.json();
    const { configAt } = await store.get("configAt");
    if (c.dashUrl && c.key && c.createdAt !== configAt) {
      await store.set({ dashUrl: c.dashUrl, key: c.key, configAt: c.createdAt, email: c.email || "" });
    }
  } catch (e) {
    /* no config.json: set up by hand in the extension's settings */
  }
}

const schedule = () => {
  seed().finally(() => chrome.alarms.create("check", { periodInMinutes: 60, delayInMinutes: 2 }));
};
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "check") runAll(false).catch(() => {});
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "run") return false;
  runAll(true).then(
    () => reply({ ok: true }),
    (e) => reply({ ok: false, error: String(e?.message || e) })
  );
  return true;
});

async function api(method, path, body) {
  const { dashUrl, key } = await store.get(["dashUrl", "key"]);
  const res = await fetch(String(dashUrl).replace(/\/+$/, "") + path, {
    method,
    headers: { "Content-Type": "application/json", "x-capture-key": key },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Dashboard error ${res.status}`);
  return j;
}

async function setStatus(site, kind, patch) {
  const k = `status:${site}:${kind}`;
  const cur = (await store.get(k))[k] || {};
  await store.set({ [k]: { ...cur, ...patch } });
}

async function runAll(manual) {
  await seed();
  const { dashUrl, key, extra, running } = await store.get(["dashUrl", "key", "extra", "running"]);
  if (!dashUrl || !key) return;
  if (running && Date.now() - running < 45 * 60e3) return;

  let sites = [];
  try {
    sites = (await api("GET", "/api/capture/targets")).sites || [];
  } catch (e) {
    await store.set({ lastCheck: Date.now(), lastError: `Couldn't reach the dashboard: ${e.message}` });
    return;
  }
  for (const s of String(extra || "").split(/\s+/)) if (s && !sites.includes(s)) sites.push(s);

  const due = [];
  for (const site of sites) {
    for (const kind of KINDS) {
      const k = `status:${site}:${kind}`;
      const st = (await store.get(k))[k] || {};
      const okAgo = Date.now() - (st.okAt || 0);
      const triedAgo = Date.now() - (st.triedAt || 0);
      if (manual || (okAgo >= WEEK && (st.ok !== false || triedAgo >= RETRY))) due.push({ site, kind });
    }
  }
  await store.set({ lastCheck: Date.now(), lastError: "", sites });
  if (!due.length) return;

  await store.set({ running: Date.now() });
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  let win = null;
  try {
    win = await chrome.windows.create({ url: "about:blank", focused: false, state: "normal", width: 1280, height: 900 });
    const tabId = win.tabs[0].id;
    for (const { site, kind } of due) {
      await store.set({ running: Date.now(), now: `${LABEL[kind]} · ${site}` });
      await setStatus(site, kind, { triedAt: Date.now() });
      try {
        const r = await capture(tabId, site, kind);
        if (!r || r.error) throw new Error(r?.error || "Nothing was read.");
        const res = await api("POST", "/api/capture", { kind, capture: r.capture });
        if (!res.saved) throw new Error(res.problem || "The numbers didn't check out, so nothing was saved.");
        await setStatus(site, kind, { ok: true, okAt: Date.now(), message: res.summary || "Saved" });
      } catch (e) {
        await setStatus(site, kind, { ok: false, message: String(e?.message || e).slice(0, 400) });
      }
    }
  } finally {
    clearInterval(keepAlive);
    if (win) chrome.windows.remove(win.id).catch(() => {});
    await store.set({ running: 0, now: "" });
  }
}

async function go(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(800);
  for (let i = 0; i < 120; i++) {
    const t = await chrome.tabs.get(tabId);
    if (/^https:\/\/accounts\.google\.com\//.test(t.url || t.pendingUrl || "")) {
      throw new Error("This Chrome profile isn't signed in to Google. Sign in to Search Console here and try again.");
    }
    if (t.status === "complete") break;
    await sleep(500);
  }
  await sleep(1500);
}

async function run(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res && res.result !== undefined ? res.result : { error: "The page didn't return anything." };
}

async function capture(tabId, site, kind) {
  const id = encodeURIComponent(site);

  if (kind === "indexing") {
    await go(tabId, `${GSC}/index?resource_id=${id}&pages=ALL_URLS`);
    return run(tabId, scrapeIndexing, [site]);
  }

  if (kind === "crawl") {
    const main = `${GSC}/settings/crawl-stats?resource_id=${id}`;
    const lk = `crawlLinks:${site}`;
    const links = (await store.get(lk))[lk] || {};
    // Learn the Refresh and Discovery pages once, by clicking them under "By purpose".
    for (const [k, label] of [["refresh", "Refresh"], ["discovery", "Discovery"]]) {
      if (links[k]) continue;
      await go(tabId, main);
      const before = (await chrome.tabs.get(tabId)).url;
      if (!(await run(tabId, clickPurpose, [label]))) continue;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const u = (await chrome.tabs.get(tabId)).url || "";
        if (u !== before && /crawl-stats/.test(u)) {
          links[k] = u;
          break;
        }
      }
    }
    await store.set({ [lk]: links });
    await go(tabId, main);
    return run(tabId, scrapeCrawl, [site, links]);
  }

  // Generative AI report: its own page (Performance → Search results → Generative AI).
  const aiDirect = `${GSC}/performance/search-analytics/ai?resource_id=${id}`;
  const { aiUrl } = await store.get("aiUrl");
  const tries = [aiUrl ? aiUrl.replace("__SITE__", id) : "", aiDirect].filter((u, i, a) => u && a.indexOf(u) === i);
  for (const url of tries) {
    await go(tabId, url);
    const r = await run(tabId, scrapeAi, [site]);
    if (!r.notReport) return r;
  }
  // Fallback: open it from the Performance page (left-menu link or an "Open report" button).
  await go(tabId, `${GSC}/performance/search-analytics?resource_id=${id}`);
  const o = await run(tabId, openAiReport, []);
  if (!o || !o.clicked) {
    return { error: "The Generative AI report wasn't found for this property (it may have no AI impressions yet)." };
  }
  await sleep(4000);
  const r = await run(tabId, scrapeAi, [site]);
  if (r.capture) {
    const u = (await chrome.tabs.get(tabId)).url || "";
    if (/resource_id=/.test(u)) await store.set({ aiUrl: u.replace(/resource_id=[^&#]*/, "resource_id=__SITE__") });
  }
  return r;
}
