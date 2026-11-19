// lib/investigate.ts
// Server-only. The quick checks of the Site investigation tab: the same checks that were run by hand on aitech365,
// readmagazine and the other Data Demand sites, as code.
//   GA4: which property has the site's real traffic; bot signs (reading time, engagement, sudden jump, one country or
//        city, one device setup); visits recorded on other hostnames; sources with almost no engagement.
//   Search Console: clicks trend and when a fall started; Google clicks vs GA4 Organic Search.
//   Captures (Chrome extension): indexed pages falling and when; reasons that grew; crawl requests and response time.
//   Sitemaps: Google stopped reading them; numbered files submitted without the index; tag / template / author sitemaps;
//        no lastmod dates.
//   Addresses: http / https / www variants all ending on one address.
// Every finding becomes an issue group (lib/audit/rules.ts) with evidence and a "where_to_check" column, and dated
// changes go on a timeline so related problems can be read together. Nothing here is decided by AI.
import { batchReports } from "./ga4-report";
import { listGa4Properties, listSitemaps, listWebStreamHosts, normalizeHost, runReport, searchAnalyticsAll } from "./google";
import { getRobots, readText, safeFetch } from "./safeFetch";
import { loadCrawl, loadIdx } from "./reportStore";
import { readArchive } from "./archive";
import { GSC_TZ, addDays, todayIn } from "./dates";
import { propertyHost, registrableDomain } from "./url";
import { pool } from "./api";
import { makeGroup, type Ev } from "./audit/rules";
import type { IssueGroup } from "./audit/catalog";

export type TimelineEvent = { date: string; what: string; source: string; level: "problem" | "watch" | "info" };
export type InvestigationCheck = { name: string; result: string };
export type Investigation = {
  groups: IssueGroup[];
  timeline: TimelineEvent[];
  checks: InvestigationCheck[];
  ga4: { id: string; name: string; sessions28: number } | null;
  ranAt: string;
};

type Pt = { date: string; v: number };
type Cand = { id: string; label: string; sessions: number };

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const pc = (x: number) => `${Math.round(x * 100)}%`;
const ymd = (s: string) => (s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);
const sum = (a: number[]) => a.reduce((t, x) => t + x, 0);
const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ageDays = (iso: string, today: string) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 864e5);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const names = (list: string[]) => list.map((name) => ({ name }));
const bySessions = [{ metric: { metricName: "sessions" }, desc: true }];
const msg = (e: unknown) => (e instanceof Error ? e.message : "error");

/** The day where the 7-day average changed most (before vs after), when the change is at least `min` (0.4 = 40%). */
function breakPoint(series: Pt[], dir: "down" | "up", min = 0.4): { date: string; before: number; after: number } | null {
  let best: { date: string; before: number; after: number; r: number } | null = null;
  for (let i = 7; i <= series.length - 7; i++) {
    const before = avg(series.slice(i - 7, i).map((p) => p.v));
    const after = avg(series.slice(i, i + 7).map((p) => p.v));
    let r: number;
    if (dir === "down") {
      if (before <= 0) continue;
      r = (before - after) / before;
    } else {
      r = before > 0 ? (after - before) / before : after > 0 ? 99 : 0;
    }
    if (r >= min && (!best || r > best.r)) best = { date: series[i].date, before, after, r };
  }
  return best && { date: best.date, before: best.before, after: best.after };
}

/* ---------------- GA4 property with the site's real traffic ---------------- */

async function recentSessions(token: string, property: string) {
  try {
    const r = await runReport(token, property, { dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }], metrics: [{ name: "sessions" }] });
    return r.rows[0]?.mets[0] ?? 0;
  } catch {
    return -1;
  }
}

/** Candidates: the top bar's choice, GA4 properties with a web stream on this host, ones whose name contains the site's
 *  name, and the pairing recorded in _Archive. The one with the most sessions in the last 28 days is used. */
async function pairGa4(token: string, site: string, hint: string): Promise<{ best: Cand | null; scored: Cand[] }> {
  const host = normalizeHost(site);
  const key = squash(host.split(".")[0]);
  const props = await listGa4Properties(token).catch(() => [] as { id: string; name: string; account: string }[]);
  const withHosts = await pool(props, 8, async (p) => ({ ...p, hosts: await listWebStreamHosts(token, p.id) }));
  const ids = new Set<string>();
  if (hint) ids.add(hint);
  for (const g of withHosts) {
    if (g.hosts.some((h) => h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`))) ids.add(g.id);
    if (key.length >= 4 && squash(g.name).includes(key)) ids.add(g.id);
  }
  try {
    const saved = (await readArchive()).find((a) => a.site === site)?.ga4;
    if (saved) ids.add(saved);
  } catch {
    /* the saved history is optional here */
  }
  const label = (id: string) => {
    const g = props.find((p) => p.id === id);
    return g ? `${g.name} (${g.account})` : `GA4 property ${id}`;
  };
  const scored = await pool(Array.from(ids), 6, async (id): Promise<Cand> => ({ id, label: label(id), sessions: await recentSessions(token, id) }));
  scored.sort((a, b) => b.sessions - a.sessions);
  const best = scored.find((c) => c.sessions >= 0) || null;
  return { best, scored };
}

/* ---------------- Sitemap files ---------------- */

/** Sitemaps of thin list pages: tags, theme templates, authors, attachments. Matched on the file name. */
const THIN = /^(post_tag|tags?|tdb_templates|elementor[-_]library|authors?|attachment|format)[-_]?sitemap|sitemap[-_](tags?|authors?|attachments?)\b/i;
const kindOf = (u: string) => {
  const f = u.split("/").pop() || u;
  if (/tag/i.test(f)) return "tag pages";
  if (/template|elementor/i.test(f)) return "theme templates";
  if (/author/i.test(f)) return "author pages";
  return "other list pages";
};

async function fetchXml(url: string, allowHost: (h: string) => boolean): Promise<string | null> {
  try {
    const r = await safeFetch(url, { allowHost, accept: "application/xml,text/xml,*/*", timeoutMs: 10_000 });
    if (!r.res) return null;
    if (!r.res.ok) {
      await r.res.body?.cancel().catch(() => {});
      return null;
    }
    return await readText(r.res, 2_000_000);
  } catch {
    return null;
  }
}

function sitemapChildren(xml: string) {
  const out: { loc: string; lastmod: string }[] = [];
  for (const m of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = (m[1].match(/<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/i)?.[1] || "").trim();
    const lastmod = (m[1].match(/<lastmod>\s*([^<]*)<\/lastmod>/i)?.[1] || "").trim();
    if (loc) out.push({ loc, lastmod });
  }
  return out;
}

/* ---------------- The investigation ---------------- */

export async function investigate(o: { token: string; site: string; ga4Hint: string }): Promise<Investigation> {
  const { token, site } = o;
  const groups: IssueGroup[] = [];
  const timeline: TimelineEvent[] = [];
  const checks: InvestigationCheck[] = [];
  const today = todayIn(GSC_TZ);
  const host = propertyHost(site).replace(/^www\./, "");
  const domain = registrableDomain(host);
  const origin = site.startsWith("sc-domain:") ? `https://${host}` : new URL(site).origin;
  const allowHost = (h: string) => registrableDomain(h) === domain;
  const ctx: { pair?: { best: Cand | null; scored: Cand[] }; clicks28?: number; impr28?: number } = {};

  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, result: await fn() });
    } catch (e) {
      checks.push({ name, result: `Couldn't run: ${msg(e)}` });
    }
  };

  await Promise.all([
    /* ---- GA4 pairing ---- */
    step("GA4 property", async () => {
      const p = await pairGa4(token, site, o.ga4Hint);
      ctx.pair = p;
      if (!p.best) return "No GA4 property with data was found for this site.";
      const hint = p.scored.find((c) => c.id === o.ga4Hint);
      if (o.ga4Hint && p.best.id !== o.ga4Hint && hint && hint.sessions < p.best.sessions * 0.1) {
        groups.push(
          makeGroup(
            "ga4_pairing",
            [],
            p.scored.map((c) => ({
              ga4_property: c.label,
              sessions_28_days: c.sessions,
              chosen_in_top_bar: c.id === o.ga4Hint ? "yes" : "",
              used_here: c.id === p.best!.id ? "yes" : "",
              where_to_check: `GA4 → Admin → Property details (property ${c.id})`,
            })),
            "GA4 Admin API + Data API",
            {},
            1
          )
        );
      }
      return `Using ${p.best.label}: ${n0(p.best.sessions)} sessions in the last 28 days${p.scored.length > 1 ? ` (${p.scored.length} candidates compared)` : ""}.`;
    }),

    /* ---- Search Console clicks trend ---- */
    step("Search Console trend", async () => {
      const end = addDays(today, -1);
      const start = addDays(end, -89);
      const rows = await searchAnalyticsAll(token, site, { startDate: start, endDate: end, dimensions: ["date"], dataState: "all" }, 200);
      const by = new Map(rows.map((r) => [r.keys[0], r]));
      const clicks: Pt[] = [];
      const imps: Pt[] = [];
      for (let d = start; d <= end; d = addDays(d, 1)) {
        clicks.push({ date: d, v: by.get(d)?.clicks ?? 0 });
        imps.push({ date: d, v: by.get(d)?.impressions ?? 0 });
      }
      const c28 = sum(clicks.slice(-28).map((p) => p.v));
      const cPrev = sum(clicks.slice(-56, -28).map((p) => p.v));
      const i28 = sum(imps.slice(-28).map((p) => p.v));
      ctx.clicks28 = c28;
      ctx.impr28 = i28;
      if (cPrev >= 50 && c28 <= cPrev * 0.7) {
        const bp = breakPoint(clicks, "down");
        groups.push(
          makeGroup(
            "clicks_decline",
            [],
            [{
              last_28_days_clicks: c28, previous_28_days_clicks: cPrev, change: pc((c28 - cPrev) / cPrev), impressions_28_days: i28,
              sharpest_fall_starts: bp?.date ?? "gradual", where_to_check: "Search Console → Performance → Search results → last 3 months",
            }],
            "Google Search Console API (Search Analytics)",
            {},
            1
          )
        );
        if (bp) timeline.push({ date: bp.date, what: `Google clicks fell (7-day average ${n0(bp.before)} → ${n0(bp.after)} a day)`, source: "Search Console", level: "problem" });
      }
      return `${n0(c28)} clicks and ${n0(i28)} impressions in the last 28 days (previous 28 days: ${n0(cPrev)} clicks).`;
    }),

    /* ---- Sitemaps in Search Console ---- */
    step("Sitemaps in Search Console", async () => {
      const list = await listSitemaps(token, site);
      if (!list.length) return "No sitemap submitted (also reported below).";
      const reads = list.map((s) => (s.lastDownloaded || "").slice(0, 10)).filter(Boolean).sort();
      const newest = reads[reads.length - 1] || "";
      if (!newest || ageDays(newest, today) > 14) {
        groups.push(
          makeGroup(
            "sitemaps_unread",
            list.map((s) => s.path),
            list.map((s) => ({
              url: s.path, last_read_by_google: (s.lastDownloaded || "").slice(0, 10) || "never", submitted: (s.lastSubmitted || "").slice(0, 10),
              errors: Number(s.errors || 0), where_to_check: "Search Console → Indexing → Sitemaps",
            })),
            "Google Search Console API (Sitemaps)"
          )
        );
      }
      const old = list.filter((s) => s.lastDownloaded && ageDays(s.lastDownloaded, today) > 7);
      if (old.length) {
        const d = old.map((s) => s.lastDownloaded!.slice(0, 10)).sort().pop()!;
        timeline.push({ date: d, what: `Google last read ${old.length} of ${list.length} sitemap(s) on or before this date`, source: "Sitemaps", level: "watch" });
      }
      const hasIndex = list.some((s) => s.isSitemapsIndex || /sitemap[_-]?index|\/sitemap\.xml$/i.test(s.path));
      const numbered = list.filter((s) => /\d+\.xml(\.gz)?$/i.test(s.path) && !s.isSitemapsIndex);
      if (!hasIndex && numbered.length >= 3) {
        groups.push(
          makeGroup(
            "sitemap_index_missing",
            numbered.map((s) => s.path),
            numbered.slice(0, 25).map((s) => ({
              url: s.path, submitted: (s.lastSubmitted || "").slice(0, 10), last_read_by_google: (s.lastDownloaded || "").slice(0, 10) || "never",
              where_to_check: "Search Console → Indexing → Sitemaps",
            })),
            "Google Search Console API (Sitemaps)"
          )
        );
      }
      return `${list.length} sitemap(s) submitted; Google last read one on ${newest || "never"}.`;
    }),

    /* ---- Sitemap files on the site ---- */
    step("Sitemap files on the site", async () => {
      const robots = await getRobots(origin);
      const cands = Array.from(new Set([...(robots?.sitemaps || []), `${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`]));
      let index: { url: string; children: { loc: string; lastmod: string }[] } | null = null;
      for (const u of cands) {
        const xml = await fetchXml(u, allowHost);
        if (xml && /<sitemapindex\b/i.test(xml)) {
          index = { url: u, children: sitemapChildren(xml) };
          break;
        }
      }
      if (!index) return "No sitemap index found in robots.txt, /sitemap_index.xml or /sitemap.xml.";
      const idx = index;
      const thin = idx.children.filter((c) => THIN.test(c.loc.split("/").pop() || ""));
      if (thin.length) {
        groups.push(
          makeGroup(
            "sitemap_thin_sections",
            thin.map((c) => c.loc),
            thin.slice(0, 25).map((c) => ({ url: c.loc, lists: kindOf(c.loc), sitemap_index: idx.url, where_to_check: `Open ${idx.url}` })),
            "Live check by this dashboard (sitemap index)",
            { thin_sitemaps: thin.length, all_sitemaps: idx.children.length }
          )
        );
      }
      const sample = idx.children.find((c) => /post/i.test(c.loc) && !THIN.test(c.loc.split("/").pop() || "")) || idx.children.find((c) => !THIN.test(c.loc.split("/").pop() || ""));
      let pagesUndated = false;
      if (sample) {
        const xml = await fetchXml(sample.loc, allowHost);
        if (xml && /<url\b/i.test(xml) && !/<lastmod>/i.test(xml)) pagesUndated = true;
      }
      const indexUndated = idx.children.length > 0 && idx.children.every((c) => !c.lastmod);
      if (pagesUndated || indexUndated) {
        const u = sample?.loc || idx.url;
        groups.push(
          makeGroup(
            "sitemap_no_lastmod",
            [u],
            [{ url: u, sitemap_index: idx.url, index_has_dates: indexUndated ? "no" : "yes", page_urls_have_dates: pagesUndated ? "no" : "yes", where_to_check: "Open the sitemap and look for <lastmod>" }],
            "Live check by this dashboard (sitemap files)",
            {},
            1
          )
        );
      }
      return `${idx.children.length} sitemap file(s) in ${idx.url}${thin.length ? `, ${thin.length} of them list tag, template or author pages` : ""}.`;
    }),

    /* ---- http / https / www variants ---- */
    step("Address variants", async () => {
      const variants = [`http://${host}/`, `https://${host}/`, `http://www.${host}/`, `https://www.${host}/`];
      const res = await pool(variants, 4, async (v) => {
        try {
          const r = await safeFetch(v, { allowHost, timeoutMs: 8000 });
          await r.res?.body?.cancel().catch(() => {});
          return { v, final: r.finalUrl, status: r.res?.status ?? r.chain[r.chain.length - 1]?.status ?? 0, hops: Math.max(0, r.chain.length - 1), loop: r.loop, err: "" };
        } catch (e) {
          return { v, final: "", status: 0, hops: 0, loop: false, err: msg(e) };
        }
      });
      const originOf = (u: string) => {
        try {
          return new URL(u).origin;
        } catch {
          return "";
        }
      };
      const counts = new Map<string, number>();
      for (const r of res) if (r.status === 200) counts.set(originOf(r.final), (counts.get(originOf(r.final)) || 0) + 1);
      const main = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      const bad = res.filter(
        (r) => !/DNS lookup failed/i.test(r.err) && (r.loop || (r.status && r.status !== 200) || (r.status === 200 && originOf(r.final) !== main) || r.hops > 1)
      );
      if (bad.length) {
        groups.push(
          makeGroup(
            "host_variants",
            bad.map((r) => r.v),
            res.map((r) => ({
              address: r.v,
              ends_on: r.final || "",
              status: r.status || r.err || "no answer",
              redirect_hops: r.hops,
              problem: r.loop
                ? "redirect loop"
                : r.status && r.status !== 200
                  ? `ends with ${r.status}`
                  : r.status === 200 && originOf(r.final) !== main
                    ? `answers on a second address (main: ${main})`
                    : r.hops > 1
                      ? `${r.hops} redirects instead of 1`
                      : "",
              where_to_check: `Paste ${r.v} into httpstatus.io`,
            })),
            "Live check by this dashboard",
            { main_address: main }
          )
        );
      }
      return main ? `Main address: ${main}${bad.length ? ` · ${bad.length} variant(s) need fixing` : " · every variant leads there"}.` : "None of the address variants answered with a page.";
    }),

    /* ---- Page indexing captures ---- */
    step("Page indexing (captures)", async () => {
      const store = await loadIdx(site);
      const view = store.views.ALL_URLS || store.views.ALL_SUBMITTED_URLS;
      if (!view || !Object.keys(view.days).length) return "No Page indexing captures yet: run the Chrome extension on this property.";
      const dates = Object.keys(view.days).sort();
      const last = dates[dates.length - 1];
      const latest = view.days[last];
      if (ageDays(last, today) > 10) {
        groups.push(makeGroup("captures_stale", [], [{ report: "Page indexing", latest_data: last, days_old: ageDays(last, today), where_to_check: "Weekly captures tab, or run the extension" }], "Search Console Page indexing report (extension capture)", {}, 1));
      }
      const recent = dates.filter((d) => ageDays(d, last) <= 120);
      const peakDate = recent.reduce((b, d) => (view.days[d].indexed > view.days[b].indexed ? d : b), recent[0]);
      const peak = view.days[peakDate].indexed;
      if (peak >= 50 && latest.indexed <= peak * 0.7) {
        const bp = breakPoint(recent.map((d) => ({ date: d, v: view.days[d].indexed })), "down", 0.2);
        groups.push(
          makeGroup(
            "index_drop",
            [],
            [{
              highest_indexed: peak, on: peakDate, indexed_now: latest.indexed, as_of: last, change: pc((latest.indexed - peak) / peak),
              not_indexed_now: latest.notIndexed, sharpest_fall_starts: bp?.date ?? "gradual", where_to_check: "Search Console → Indexing → Pages",
            }],
            "Search Console Page indexing report (extension capture)",
            {},
            1
          )
        );
        timeline.push({ date: bp?.date || peakDate, what: `Indexed pages started falling (${n0(peak)} → ${n0(latest.indexed)})`, source: "Page indexing", level: "problem" });
      }
      const totals = recent.map((d) => ({ date: d, v: view.days[d].indexed + view.days[d].notIndexed }));
      const jump = breakPoint(totals, "up", 0.5);
      if (jump) timeline.push({ date: jump.date, what: `Google suddenly knew many more URLs (${n0(jump.before)} → ${n0(jump.after)})`, source: "Page indexing", level: "info" });

      let reasonsNote = "";
      const hk = Object.keys(view.reasonsHistory).sort();
      const asOf = view.reasonsAsOf;
      if (asOf && hk.length >= 2) {
        const base = [...hk].reverse().find((k) => ageDays(k, asOf) >= 21) || hk[0];
        if (base !== asOf) {
          const now = view.reasonsHistory[asOf] || {};
          const then = view.reasonsHistory[base] || {};
          const grew: Ev[] = Object.entries(now)
            .filter(([r, p]) => p - (then[r] || 0) >= 50 && p >= (then[r] || 0) * 1.5)
            .map(([r, p]) => ({ reason: r, pages_now: p, pages_before: then[r] || 0, compared_with: base, as_of: asOf, where_to_check: "Search Console → Indexing → Pages → Why pages aren't indexed" }));
          if (grew.length) groups.push(makeGroup("index_reasons_growth", [], grew, "Search Console Page indexing report (extension capture)", {}, grew.length));
          reasonsNote = ` · ${grew.length} reason(s) grew since ${base}`;
        }
      }
      return `${n0(latest.indexed)} indexed, ${n0(latest.notIndexed)} not indexed as of ${last} (peak ${n0(peak)} on ${peakDate})${reasonsNote}.`;
    }),

    /* ---- Crawl stats captures ---- */
    step("Crawl stats (captures)", async () => {
      const cs = await loadCrawl(site);
      const t = cs.series.total, r = cs.series.refresh, d = cs.series.discovery;
      const all = new Set<string>([...Object.keys(t?.days || {}), ...Object.keys(r?.days || {}), ...Object.keys(d?.days || {})]);
      const req: Pt[] = [];
      const ms: Pt[] = [];
      for (const date of Array.from(all).sort()) {
        const td = t?.days[date], rd = r?.days[date], dd = d?.days[date];
        const q = td ? td.requests : rd && dd ? rd.requests + dd.requests : null;
        if (q != null) req.push({ date, v: q });
        if (td?.ms != null) ms.push({ date, v: td.ms });
      }
      if (!req.length) return "No Crawl stats captures yet: run the Chrome extension on this property.";
      const last = req[req.length - 1].date;
      if (ageDays(last, today) > 10) {
        groups.push(makeGroup("captures_stale", [], [{ report: "Crawl stats", latest_data: last, days_old: ageDays(last, today), where_to_check: "Weekly captures tab, or run the extension" }], "Search Console Crawl stats report (extension capture)", {}, 1));
      }
      let note = "";
      if (req.length >= 42) {
        const a14 = avg(req.slice(-14).map((p) => p.v));
        const p28 = avg(req.slice(-42, -14).map((p) => p.v));
        note = `${n0(a14)} crawl requests a day lately vs ${n0(p28)} before`;
        if (p28 >= 20 && a14 <= p28 * 0.6) {
          const bp = breakPoint(req, "down");
          groups.push(
            makeGroup("crawl_drop", [], [{ requests_per_day_last_14: Math.round(a14), requests_per_day_before: Math.round(p28), change: pc((a14 - p28) / p28), fall_starts: bp?.date ?? "gradual", where_to_check: "Settings → Crawl stats" }], "Search Console Crawl stats report (extension capture)", {}, 1)
          );
          if (bp) timeline.push({ date: bp.date, what: `Googlebot crawled less (${n0(bp.before)} → ${n0(bp.after)} requests a day)`, source: "Crawl stats", level: "problem" });
        }
      }
      if (ms.length >= 42) {
        const m14 = avg(ms.slice(-14).map((p) => p.v));
        const m28 = avg(ms.slice(-42, -14).map((p) => p.v));
        if (m14 > 500 && m14 >= m28 * 1.5) {
          const bp = breakPoint(ms, "up", 0.5);
          groups.push(
            makeGroup("crawl_slow", [], [{ avg_response_ms_last_14: Math.round(m14), avg_response_ms_before: Math.round(m28), slowdown_starts: bp?.date ?? "gradual", where_to_check: "Settings → Crawl stats → Average response time" }], "Search Console Crawl stats report (extension capture)", {}, 1)
          );
          if (bp) timeline.push({ date: bp.date, what: `Server got slower for Googlebot (${n0(bp.before)} → ${n0(bp.after)} ms)`, source: "Crawl stats", level: "watch" });
        }
      }
      return `Crawl stats through ${last}${note ? ` · ${note}` : ""}.`;
    }),
  ]);

  /* ---- GA4 traffic quality (needs the pairing) and search vs traffic (needs both) ---- */
  const best = ctx.pair?.best || null;
  let sessions28 = 0;
  if (best) {
    await step("GA4 traffic quality", async () => {
      const L28 = { startDate: "28daysAgo", endDate: "yesterday" };
      const H = { startDate: "90daysAgo", endDate: "yesterday" };
      const [[daily, channels, countries, hostsR, sources], [cities, tech]] = await Promise.all([
        batchReports(token, best.id, [
          { dateRanges: [H], dimensions: names(["date"]), metrics: names(["sessions", "engagedSessions", "userEngagementDuration"]), limit: 100 },
          { dateRanges: [L28], dimensions: names(["sessionDefaultChannelGroup"]), metrics: names(["sessions", "engagedSessions"]), limit: 50 },
          { dateRanges: [L28], dimensions: names(["country"]), metrics: names(["sessions", "engagedSessions"]), orderBys: bySessions, limit: 8 },
          { dateRanges: [L28], dimensions: names(["hostName"]), metrics: names(["sessions"]), orderBys: bySessions, limit: 25 },
          { dateRanges: [L28], dimensions: names(["sessionSource", "sessionMedium"]), metrics: names(["sessions", "engagedSessions", "userEngagementDuration"]), orderBys: bySessions, limit: 25 },
        ]),
        batchReports(token, best.id, [
          { dateRanges: [L28], dimensions: names(["city"]), metrics: names(["sessions", "engagedSessions"]), orderBys: bySessions, limit: 8 },
          { dateRanges: [L28], dimensions: names(["operatingSystem", "browser"]), metrics: names(["sessions", "engagedSessions"]), orderBys: bySessions, limit: 8 },
        ]),
      ]);
      const pts = (daily || [])
        .map((r) => ({ date: ymd(String(r.date)), s: Number(r.sessions) || 0, e: Number(r.engagedSessions) || 0, t: Number(r.userEngagementDuration) || 0 }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const last28 = pts.slice(-28);
      const S = sum(last28.map((p) => p.s));
      const E = sum(last28.map((p) => p.e));
      const T = sum(last28.map((p) => p.t));
      sessions28 = S;
      const engRate = S ? E / S : 0;
      const avgT = S ? T / S : 0;
      const base = median(pts.slice(0, Math.max(0, pts.length - 30)).map((p) => p.s));
      const recentMed = median(pts.slice(-14).map((p) => p.s));
      const spike = base > 0 ? recentMed >= base * 3 && recentMed >= 100 : recentMed >= 500;
      const jump = breakPoint(pts.map((p) => ({ date: p.date, v: p.s })), "up", 1);

      const share = (x: number) => (S ? x / S : 0);
      const rate = (r: Record<string, any>) => (Number(r.sessions) ? Number(r.engagedSessions || 0) / Number(r.sessions) : 0);
      const signals: Ev[] = [];
      const add = (signal: string, value: string, normal: string) => signals.push({ signal, value, usual_for_real_readers: normal, where_to_check: "GA4 → Explore → Free form (last 28 days)" });
      if (S >= 500 && avgT < 3) add("Almost no reading time", `${avgT.toFixed(1)} s per session`, "30 s or more");
      if (S >= 500 && engRate < 0.2) add("Very low engagement rate", pc(engRate), "40–70%");
      if (spike) add("Sudden traffic jump", `${n0(recentMed)} sessions a day now vs ${n0(base)} before${jump ? ` (from ${jump.date})` : ""}`, "gradual change");
      const topC = countries?.[0];
      if (topC && share(Number(topC.sessions)) >= 0.6 && rate(topC) < 0.25) {
        add("One country dominates", `${topC.country}: ${pc(share(Number(topC.sessions)))} of sessions, ${pc(rate(topC))} engaged`, "a mix of countries, normal engagement");
      }
      const topCity = cities?.[0];
      if (topCity && share(Number(topCity.sessions)) >= 0.4 && rate(topCity) < 0.25) {
        add("One city dominates", `${topCity.city}: ${pc(share(Number(topCity.sessions)))} of sessions, ${pc(rate(topCity))} engaged`, "spread across cities");
      }
      const topTech = tech?.[0];
      if (topTech && share(Number(topTech.sessions)) >= 0.6 && rate(topTech) < 0.25) {
        add("One device setup dominates", `${topTech.operatingSystem} / ${topTech.browser}: ${pc(share(Number(topTech.sessions)))} of sessions`, "a mix of devices and browsers");
      }
      if (signals.length >= 2) {
        groups.push(makeGroup("bot_traffic", [], signals, "Google Analytics 4 Data API", { sessions_28_days: S, engaged_sessions_28_days: E }, signals.length));
      }
      if (spike && jump) timeline.push({ date: jump.date, what: `GA4 sessions jumped (${n0(jump.before)} → ${n0(jump.after)} a day)`, source: "GA4", level: signals.length >= 2 ? "problem" : "watch" });

      const foreign = (hostsR || []).filter((r) => {
        const h = String(r.hostName || "").toLowerCase();
        return h && h !== "(not set)" && registrableDomain(h.replace(/^www\./, "")) !== domain && Number(r.sessions) >= Math.max(10, S * 0.01);
      });
      if (foreign.length) {
        groups.push(
          makeGroup(
            "foreign_hostnames",
            [],
            foreign.map((r) => ({ hostname: String(r.hostName), sessions: Number(r.sessions), share: pc(share(Number(r.sessions))), where_to_check: "GA4 → Explore → Free form → dimension Hostname" })),
            "Google Analytics 4 Data API",
            {},
            foreign.length
          )
        );
      }

      const weak = (sources || []).filter((r) => share(Number(r.sessions)) >= 0.03 && rate(r) < 0.1);
      if (weak.length) {
        groups.push(
          makeGroup(
            "low_quality_sources",
            [],
            weak.map((r) => ({
              source_medium: `${r.sessionSource} / ${r.sessionMedium}`,
              sessions: Number(r.sessions),
              share: pc(share(Number(r.sessions))),
              engagement_rate: pc(rate(r)),
              avg_seconds: Number(r.sessions) ? Math.round((Number(r.userEngagementDuration) || 0) / Number(r.sessions)) : 0,
              where_to_check: "GA4 → Reports → Acquisition → Traffic acquisition → Session source / medium",
            })),
            "Google Analytics 4 Data API",
            {},
            weak.length
          )
        );
      }

      const organic = Number((channels || []).find((r) => r.sessionDefaultChannelGroup === "Organic Search")?.sessions || 0);
      const c28 = ctx.clicks28;
      const i28 = ctx.impr28;
      if (c28 != null && i28 != null) {
        let suggests = "";
        if (S >= 5000 && i28 < 1000) suggests = "Plenty of traffic but almost no visibility in Google Search";
        else if (Math.max(organic, c28) >= 300 && (organic > c28 * 4 || c28 > organic * 4)) {
          suggests = organic > c28 ? "GA4 counts far more search visits than Google reports clicks" : "Google reports far more clicks than GA4 counts search visits";
        }
        if (suggests) {
          groups.push(
            makeGroup(
              "search_vs_traffic",
              [],
              [{ gsc_clicks_28_days: c28, gsc_impressions_28_days: i28, ga4_sessions_28_days: S, ga4_organic_search_sessions: organic, what_it_suggests: suggests, where_to_check: "Search Console → Performance and GA4 → Traffic acquisition, same dates" }],
              "Search Console API + GA4 Data API",
              {},
              1
            )
          );
        }
      }
      return `${n0(S)} sessions in 28 days · ${pc(engRate)} engaged · ${avgT.toFixed(1)} s average reading time · ${n0(organic)} from Organic Search${signals.length ? ` · ${signals.length} bot sign(s)` : ""}.`;
    });
  } else {
    checks.push({ name: "GA4 traffic quality", result: "Skipped: no GA4 property with data for this site." });
  }

  timeline.sort((a, b) => a.date.localeCompare(b.date));
  return {
    groups,
    timeline,
    checks,
    ga4: best ? { id: best.id, name: best.label, sessions28: sessions28 || best.sessions } : null,
    ranAt: new Date().toISOString(),
  };
}
