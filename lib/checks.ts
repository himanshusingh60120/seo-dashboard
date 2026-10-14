// lib/checks.ts
"use client";
// The one place the browser runs URL Inspection: calls the API, saves results, records status changes,
// and counts quota. The Indexing tab, the Live index monitor and the GSC audit all go through here.
import {
  appendEvents, applyInspections, loadIndexCache, saveIndexCache,
  type IndexCache, type IndexEvent, type InspectionRec,
} from "./indexCache";

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
export const quotaLeft = (site: string) => Math.max(0, DAILY_INSPECTION_LIMIT - quotaUsed(site));

export type InspectOutcome = {
  results: InspectionRec[];
  events: IndexEvent[];
  quotaExceeded: boolean;
  rateLimited: boolean;
  skipped: string[];
  cache: IndexCache;
};

export async function inspectAndStore(site: string, urls: string[]): Promise<InspectOutcome> {
  const res = await fetch("/api/gsc/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteUrl: site, urls: urls.slice(0, 20) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  const results: InspectionRec[] = data.results || [];
  setQuota(site, data.quotaExceeded ? DAILY_INSPECTION_LIMIT : quotaUsed(site) + results.length);
  const base = (await loadIndexCache(site)) || { urls: [], sitemaps: [], inspected: {}, listedAt: "" };
  const { cache, events } = applyInspections(base, results);
  saveIndexCache(site, cache);
  await appendEvents(site, events);
  return { results, events, quotaExceeded: !!data.quotaExceeded, rateLimited: !!data.rateLimited, skipped: data.skipped || [], cache };
}

export type SitemapStatus = {
  path: string; errors: number; warnings: number; isPending: boolean;
  lastDownloaded: string; lastSubmitted: string; readByDashboard: number | null;
};

/** Reads sitemaps + recent search pages on the server and saves the URL list (keeping earlier inspections). */
export async function loadUrlList(site: string) {
  const res = await fetch(`/api/gsc/sitemap-urls?site=${encodeURIComponent(site)}`, { cache: "no-store" });
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
  const errors: { sitemap: string; error: string }[] = data.errors || [];
  const message =
    `Found ${cache.urls.length.toLocaleString()} URLs: ${fromMaps.toLocaleString()} from ${cache.sitemaps.length} sitemap file(s), ` +
    `the rest from search results (last 90 days).` +
    (errors.length ? ` ${errors.length} sitemap problem(s): ${errors.slice(0, 5).map((e) => `${e.sitemap} (${e.error})`).join(", ")}.` : "") +
    (data.outsideProperty ? ` ${Number(data.outsideProperty).toLocaleString()} URL(s) outside this property were skipped.` : "");
  return { cache, message, errors, sitemapStatus: (data.sitemapStatus || []) as SitemapStatus[] };
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
