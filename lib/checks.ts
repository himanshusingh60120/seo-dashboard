// lib/checks.ts
"use client";
// The one place the browser runs URL Inspection: calls the API, saves results, records status changes,
// and counts quota. The Indexing tab, the Live index monitor and the GSC audit all go through here.
// Google allows 2,000 inspections per property per day, shared by everyone. When the server's daily index checks are
// on for a property, they use up to their daily budget (1,800 by default), so the browser only counts on the rest.
import {
  appendEvents, applyInspections, loadIndexCache, saveIndexCache,
  type IndexCache, type IndexEvent, type InspectionRec,
} from "./indexCache";
import type { SitemapList } from "./sitemaps";

export const DAILY_INSPECTION_LIMIT = 2000;

/** Google's daily quotas reset at midnight Pacific time. */
const ptDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const qKey = (site: string) => `dash:quota:${site}:${ptDay()}`;

export function quotaUsed(site: string) {
  try {
    return Number(localStorage.getItem(qKey(site)) || 0);
  } catch {
    return 0;
  }
}
function setQuota(site: string, n: number) {
  try {
    localStorage.setItem(qKey(site), String(Math.min(n, DAILY_INSPECTION_LIMIT)));
  } catch {}
}

/* ---------- Inspections kept for the server's daily index checks ---------- */

type Reserved = { at: number; n: number };
const reserved = new Map<string, Reserved>();
const resKey = (site: string) => `dash:quota-reserved:${site}`;
const RES_FRESH_MS = 10 * 60_000;
const RES_KEEP_MS = 6 * 3_600_000;

/** Inspections the server's daily index checks use on this property each day (0 when they're off or unknown). */
export function reservedForServer(site: string) {
  const hit = reserved.get(site);
  if (hit) return hit.n;
  try {
    const v = JSON.parse(localStorage.getItem(resKey(site)) || "null") as Reserved | null;
    if (v && Date.now() - v.at < RES_KEEP_MS) {
      reserved.set(site, v);
      return v.n;
    }
  } catch {}
  return 0;
}

/** Asks the server whether daily index checks are on for this property (at most every 10 minutes). */
export async function refreshReserved(site: string): Promise<number> {
  const hit = reserved.get(site);
  if (hit && Date.now() - hit.at < RES_FRESH_MS) return hit.n;
  try {
    const r = await fetch(`/api/index-checks?site=${encodeURIComponent(site)}`, { cache: "no-store" });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const n = j?.configured && j?.job?.enabled ? Math.min(DAILY_INSPECTION_LIMIT, Math.max(0, Number(j.job.budget) || 0)) : 0;
    const v = { at: Date.now(), n };
    reserved.set(site, v);
    try {
      localStorage.setItem(resKey(site), JSON.stringify(v));
    } catch {}
    return n;
  } catch {
    return reservedForServer(site);
  }
}

/** Inspections this browser can use on the property today: Google's 2,000 minus what the server's checks use. */
export const dailyLimit = (site: string) => Math.max(0, DAILY_INSPECTION_LIMIT - reservedForServer(site));
export const quotaLeft = (site: string) => Math.max(0, dailyLimit(site) - quotaUsed(site));

export type InspectOutcome = {
  results: InspectionRec[];
  events: IndexEvent[];
  quotaExceeded: boolean;
  rateLimited: boolean;
  skipped: string[];
  cache: IndexCache;
};

export async function inspectAndStore(site: string, urls: string[]): Promise<InspectOutcome> {
  await refreshReserved(site);
  const list = urls.slice(0, Math.min(20, quotaLeft(site)));
  const base = (await loadIndexCache(site)) || { urls: [], sitemaps: [], inspected: {}, listedAt: "" };
  if (!list.length) {
    // Nothing left for the browser today: the rest is kept for the server's daily index checks.
    return { results: [], events: [], quotaExceeded: true, rateLimited: false, skipped: urls, cache: base };
  }
  const res = await fetch("/api/gsc/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteUrl: site, urls: list }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  const results: InspectionRec[] = data.results || [];
  setQuota(site, data.quotaExceeded ? DAILY_INSPECTION_LIMIT : quotaUsed(site) + results.length);
  const latest = (await loadIndexCache(site)) || base;
  const { cache, events } = applyInspections(latest, results);
  saveIndexCache(site, cache);
  await appendEvents(site, events);
  return { results, events, quotaExceeded: !!data.quotaExceeded, rateLimited: !!data.rateLimited, skipped: data.skipped || [], cache };
}

export type SitemapStatus = {
  path: string; errors: number; warnings: number; isPending: boolean;
  lastDownloaded: string; lastSubmitted: string; readByDashboard: number | null;
};

export type UrlListOptions = { sitemaps: string[]; includeSearch: boolean };
export type UrlListResult = {
  cache: IndexCache;
  message: string;
  errors: { sitemap: string; error: string }[];
  sitemapStatus: SitemapStatus[];
};

/** Every sitemap file found for the property, with URL counts, for the sitemap picker. */
export async function discoverSitemaps(site: string): Promise<SitemapList> {
  const res = await fetch(`/api/gsc/sitemap-urls?site=${encodeURIComponent(site)}&mode=list`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return { files: data.files || [], note: data.note || "" };
}

/**
 * Reads sitemaps on the server and saves the URL list (keeping earlier inspections).
 * With options: only the chosen sitemap files, plus pages with search impressions if asked.
 * Without options: every sitemap plus pages with impressions in the last 90 days.
 */
export async function loadUrlList(site: string, opts?: UrlListOptions): Promise<UrlListResult> {
  const res = opts
    ? await fetch("/api/gsc/sitemap-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ site, sitemaps: opts.sitemaps, includeSearch: opts.includeSearch }),
      })
    : await fetch(`/api/gsc/sitemap-urls?site=${encodeURIComponent(site)}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  const prev = await loadIndexCache(site);
  const cache: IndexCache = {
    urls: data.urls || [],
    sitemaps: data.sitemaps || [],
    inspected: prev?.inspected || {},
    listedAt: new Date().toISOString(),
  };
  saveIndexCache(site, cache, true);
  const fromMaps = cache.urls.filter((u) => u.sources.includes("sitemap")).length;
  const searchOnly = cache.urls.length - fromMaps;
  const errors: { sitemap: string; error: string }[] = data.errors || [];
  const problems = errors.length ? ` ${errors.length} sitemap problem(s): ${errors.slice(0, 5).map((e) => `${e.sitemap} (${e.error})`).join(", ")}.` : "";
  const outside = data.outsideProperty ? ` ${Number(data.outsideProperty).toLocaleString()} URL(s) outside this property were skipped.` : "";
  const message = opts
    ? `Loaded ${cache.urls.length.toLocaleString()} URLs: ${fromMaps.toLocaleString()} from ${cache.sitemaps.length} sitemap file(s) you chose` +
      (opts.includeSearch ? `, plus ${searchOnly.toLocaleString()} from search results (last 90 days)` : "") +
      "." + problems + outside
    : `Found ${cache.urls.length.toLocaleString()} URLs: ${fromMaps.toLocaleString()} from ${cache.sitemaps.length} sitemap file(s), ` +
      `the rest from search results (last 90 days).` + problems + outside;
  return { cache, message, errors, sitemapStatus: (data.sitemapStatus || []) as SitemapStatus[] };
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
