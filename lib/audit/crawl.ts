// lib/audit/crawl.ts
// Shared (browser + server), no network. Turns deep-crawl results and saved URL Inspection results into issue
// groups and Googlebot crawl-activity figures. Every count comes from the crawl or from Google's data.
import type { Inspection } from "../types";
import type { IssueGroup } from "./catalog";
import { makeGroup } from "./rules";
import { normalizeUrl, urlInProperty } from "../url";

export type CrawlRow = {
  url: string;
  status: number;
  chain: string;
  finalUrl: string;
  redirects: number;
  loop: boolean;
  robotsBlocked: boolean;
  inconclusive: boolean;
  error: string;
  /** Internal links on the page (normalised); only for 200 HTML pages inside the property. */
  links: string[];
  /** The server ran out of time before fetching this URL; the browser retries it. */
  skipped: boolean;
};
export type CrawlPage = Omit<CrawlRow, "links" | "skipped">;
export type Inlink = { count: number; from: string[] };

export type BrokenRow = { url: string; status: string; linked_from: string; links_to_it: number; in_sitemap: string; note: string };
export type RedirectRow = { url: string; chain: string; final_url: string; linked_from: string; links_to_it: number };
export type SourceRow = { url: string; source: string; source_type: string; still_linked: string; google_last_crawl: string; inspected: string };
export type CrawlReport = {
  fetched: number;
  queuedLeft: number;
  limit: number;
  ok: number;
  redirecting: number;
  broken: number;
  blocked: number;
  inconclusive: number;
  brokenRows: BrokenRow[];
  redirectRows: RedirectRow[];
  sourceRows: SourceRow[];
};

const DAY = 864e5;
const SOURCES_KEPT = 20;
export { SOURCES_KEPT };

export const is404 = (r: Inspection) =>
  r.pageFetchState === "NOT_FOUND" || r.pageFetchState === "SOFT_404" || /not found \(404\)|soft 404/i.test(r.coverageState || "");

const isBroken = (p: CrawlPage) => p.loop || (p.status >= 400 && !p.inconclusive);

/** Crawl order: pages Google says link to 404 URLs first, then the homepage, top pages and sitemap URLs. */
export function planCrawl(siteUrl: string, inspections: Inspection[], topPages: string[], sitemapUrls: string[]) {
  const inProp = (u: string) => urlInProperty(siteUrl, u);
  const wantByRef = new Map<string, Set<string>>();
  inspections.filter(is404).forEach((r) => {
    const target = normalizeUrl(r.url);
    (r.referringUrls || []).forEach((ref) => {
      const k = normalizeUrl(ref);
      if (!inProp(k)) return;
      const s = wantByRef.get(k) || new Set<string>();
      s.add(target);
      wantByRef.set(k, s);
    });
  });
  const home = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice(10)}/` : siteUrl;
  const seeds = Array.from(
    new Set([...Array.from(wantByRef.keys()), normalizeUrl(home), ...topPages.map(normalizeUrl), ...sitemapUrls.map(normalizeUrl)])
  ).filter(inProp);
  return { seeds, wantByRef };
}

export function crawlResults(o: {
  siteUrl: string;
  pages: Map<string, CrawlPage>;
  inlinks: Map<string, Inlink>;
  inspections: Inspection[];
  /** "<referring page>\n<404 URL>" pairs where the crawl found the link on the page. */
  found: Set<string>;
  /** Referring pages the crawl fetched. */
  refChecked: Set<string>;
  sitemap: Set<string>;
  limit: number;
  queuedLeft: number;
}): { report: CrawlReport; groups: IssueGroup[] } {
  const sm = new Set(Array.from(o.sitemap).map(normalizeUrl));
  const brokenRows: BrokenRow[] = [];
  const redirectRows: RedirectRow[] = [];
  const brokenUrls: string[] = [];
  const redirectUrls: string[] = [];
  let ok = 0;
  let redirecting = 0;
  let broken = 0;
  let blocked = 0;
  let inconclusive = 0;

  o.pages.forEach((p, url) => {
    const inl = o.inlinks.get(url);
    const inSm = sm.has(url);
    if (p.robotsBlocked) {
      blocked++;
      return;
    }
    if (isBroken(p)) {
      broken++;
      const from = inl ? inl.from : [];
      if (!from.length && !inSm) return; // a seed nothing links to
      brokenUrls.push(url);
      const base = {
        url,
        status: p.loop ? "redirect loop" : String(p.status),
        links_to_it: inl ? inl.count : 0,
        in_sitemap: inSm ? "yes" : "no",
        note: p.error || (p.redirects ? `redirects: ${p.chain}` : ""),
      };
      if (from.length) from.forEach((src) => brokenRows.push({ ...base, linked_from: src }));
      else brokenRows.push({ ...base, linked_from: "(only in your sitemap)" });
      return;
    }
    if (p.inconclusive || !p.status) {
      inconclusive++;
      return;
    }
    if (p.redirects > 0) {
      redirecting++;
      if (inl && inl.from.length) {
        redirectUrls.push(url);
        inl.from.forEach((src) => redirectRows.push({ url, chain: p.chain, final_url: p.finalUrl, linked_from: src, links_to_it: inl.count }));
      }
      return;
    }
    if (p.status === 200) ok++;
  });

  // Where Google's 404 URLs are linked from, and whether the link is still there today
  const sourceRows: SourceRow[] = [];
  const confirmed: string[] = [];
  o.inspections.filter(is404).forEach((r) => {
    const u = normalizeUrl(r.url);
    const common = {
      url: r.url,
      google_last_crawl: r.lastCrawlTime ? r.lastCrawlTime.slice(0, 10) : "",
      inspected: (r.checkedAt || "").slice(0, 10),
    };
    let live = false;
    const refs = r.referringUrls || [];
    const maps = r.sitemaps || [];
    refs.forEach((ref) => {
      const k = normalizeUrl(ref);
      const internal = urlInProperty(o.siteUrl, k);
      let still: string;
      if (!internal) still = "Other website: you can't edit it; 301 the URL if it still has value";
      else if (!o.refChecked.has(k)) still = "Not checked: page not reached within the crawl limit";
      else {
        const pg = o.pages.get(k);
        if (pg && pg.robotsBlocked) still = "Not checked: robots.txt blocks this page";
        else if (pg && pg.status !== 200) still = `No: this page itself now returns ${pg.status || "no response"}`;
        else if (o.found.has(`${k}\n${u}`)) {
          still = "Yes: the link is on this page now";
          live = true;
        } else still = "No: the link has been removed";
      }
      sourceRows.push({ ...common, source: ref, source_type: internal ? "Page on your site" : "Other website", still_linked: still });
    });
    maps.forEach((s) => {
      const listed = sm.has(u);
      if (listed) live = true;
      sourceRows.push({
        ...common,
        source: s,
        source_type: "Sitemap (Google's record)",
        still_linked: listed ? "Yes: your current sitemaps still list it" : "No: not in your current sitemaps",
      });
    });
    if (!refs.length && !maps.length) {
      sourceRows.push({ ...common, source: "", source_type: "None reported by Google", still_linked: "Nothing links to it as far as Google knows: leaving the 404 is fine" });
    }
    if (live) confirmed.push(r.url);
  });

  const byLinks = <T extends { links_to_it: number }>(a: T, b: T) => b.links_to_it - a.links_to_it;
  const groups: IssueGroup[] = [];
  if (brokenUrls.length) {
    groups.push(makeGroup("broken_links", brokenUrls, brokenRows.slice().sort(byLinks), "Deep crawl by this dashboard", { pages_crawled: o.pages.size }));
  }
  if (redirectUrls.length) {
    groups.push(makeGroup("links_to_redirects", redirectUrls, redirectRows.slice().sort(byLinks), "Deep crawl by this dashboard", { pages_crawled: o.pages.size }));
  }
  if (confirmed.length) {
    groups.push(
      makeGroup("http_404_sources", confirmed, sourceRows.filter((r) => r.still_linked.startsWith("Yes")), "Google URL Inspection (referring pages) + deep crawl")
    );
  }

  return {
    report: { fetched: o.pages.size, queuedLeft: o.queuedLeft, limit: o.limit, ok, redirecting, broken, blocked, inconclusive, brokenRows, redirectRows, sourceRows },
    groups,
  };
}

/* ---------- Googlebot crawl activity (from URL Inspection's lastCrawlTime) ---------- */

/** Per URL: every distinct last-crawl time this dashboard has seen, when it was first recorded, and whether it was once never crawled. */
export type CrawlHistory = Record<string, { times: string[]; seenAt: string; neverAt?: string }>;

export function mergeHistory(prev: CrawlHistory | null, inspections: Inspection[]): CrawlHistory {
  const out: CrawlHistory = { ...(prev || {}) };
  inspections.forEach((r) => {
    const old = out[r.url];
    const e: CrawlHistory[string] = { times: old ? old.times.slice() : [], seenAt: old ? old.seenAt : r.checkedAt };
    if (old && old.neverAt) e.neverAt = old.neverAt;
    if (r.lastCrawlTime) {
      if (e.times.indexOf(r.lastCrawlTime) < 0) {
        e.times.push(r.lastCrawlTime);
        e.times.sort();
        if (e.times.length > 30) e.times = e.times.slice(-30);
      }
    } else if (!e.times.length && !e.neverAt) e.neverAt = r.checkedAt;
    out[r.url] = e;
  });
  return out;
}

export type ActivityRow = { url: string; last_crawl: string; days_ago: number | null; crawls_seen: number; crawled_as: string; coverage: string };
export type Activity = {
  inspected: number;
  never: number;
  d1: number;
  d7: number;
  d30: number;
  d90: number;
  older: number;
  mobile: number;
  desktop: number;
  recrawled: number;
  firstCrawl: number;
  since: string;
  rows: ActivityRow[];
};

export function crawlActivity(inspections: Inspection[], h: CrawlHistory): Activity {
  const now = Date.now();
  const a: Activity = {
    inspected: inspections.length, never: 0, d1: 0, d7: 0, d30: 0, d90: 0, older: 0,
    mobile: 0, desktop: 0, recrawled: 0, firstCrawl: 0, since: "", rows: [],
  };
  let since = "";
  Object.keys(h).forEach((u) => {
    const s = h[u].seenAt;
    if (s && (!since || s < since)) since = s;
  });
  a.since = since.slice(0, 10);
  inspections.forEach((r) => {
    const e = h[r.url];
    const seen = e ? e.times.length : r.lastCrawlTime ? 1 : 0;
    if (e && e.times.length >= 2) a.recrawled++;
    if (e && e.neverAt && e.times.length) a.firstCrawl++;
    if (r.crawledAs === "MOBILE") a.mobile++;
    else if (r.crawledAs === "DESKTOP") a.desktop++;
    let days: number | null = null;
    if (!r.lastCrawlTime) a.never++;
    else {
      days = Math.max(0, Math.floor((now - Date.parse(r.lastCrawlTime)) / DAY));
      if (days < 1) a.d1++;
      else if (days < 7) a.d7++;
      else if (days < 30) a.d30++;
      else if (days < 90) a.d90++;
      else a.older++;
    }
    a.rows.push({
      url: r.url,
      last_crawl: r.lastCrawlTime ? r.lastCrawlTime.slice(0, 16).replace("T", " ") : "never",
      days_ago: days,
      crawls_seen: seen,
      crawled_as: r.crawledAs ? r.crawledAs.toLowerCase() : "",
      coverage: r.coverageState,
    });
  });
  return a;
}
