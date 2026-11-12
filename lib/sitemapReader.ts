// lib/sitemapReader.ts
// Reads a property's sitemaps: every file found in Search Console, robots.txt "Sitemap:" lines, /sitemap.xml and
// files inside sitemap indexes. Used by the sitemap-urls API route and the daily index-check job.
// URLs are normalised and de-duplicated; URLs outside the property are skipped. Fetches only go to your own
// domains or to sitemap hosts listed in Search Console, and never to private addresses.
import { gunzipSync } from "zlib";
import { latestFinalDate, listSitemaps, searchAnalyticsAll, MAX_ROWS, type SitemapInfo } from "./google";
import { getRobots, safeFetch } from "./safeFetch";
import { addDays } from "./dates";
import { normalizeUrl, propertyHost, registrableDomain, urlInProperty } from "./url";
import type { SitemapFile, SitemapList } from "./sitemaps";

const MAX_URLS = 100_000;
export const MAX_FILES = 2000;
const PARALLEL = 8;
/** Stop reading after this long so the request ends inside Vercel's time limit. */
const BUDGET_MS = 35_000;
const LIST_BUDGET_MS = 40_000;
const MAX_BYTES = 60 * 1024 * 1024;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENT[e.toLowerCase()] ?? m;
    try {
      return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    } catch {
      return m;
    }
  });

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?\\s*([\\s\\S]*?)\\s*(?:\\]\\]>)?\\s*</${name}>`, "i"));
  return m ? decode(m[1].trim()) : "";
};

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

async function readXml(url: string, allowHost: (h: string) => boolean) {
  const r = await safeFetch(url, { allowHost, accept: "application/xml,text/xml,*/*", timeoutMs: 12_000 });
  if (!r.res) throw new Error(r.loop ? "redirect loop" : "too many redirects");
  if (!r.res.ok) {
    await r.res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${r.res.status}`);
  }
  const buf = Buffer.from(await r.res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("file larger than 60 MB");
  const gz = url.toLowerCase().endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b);
  return (gz ? gunzipSync(buf) : buf).toString("utf8");
}

type Loc = { loc: string; lastmod?: string };
type Parsed = { kind: "index"; children: Loc[] } | { kind: "urlset"; urls: Loc[]; count: number };

/** `full` = extract every page URL; otherwise only count them (faster, for the picker). */
function parse(xml: string, full: boolean): Parsed {
  if (/<sitemapindex\b/i.test(xml)) {
    const children: Loc[] = [];
    for (const m of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
      const loc = tag(m[1], "loc");
      if (loc) children.push({ loc, lastmod: tag(m[1], "lastmod") || undefined });
    }
    return { kind: "index", children };
  }
  if (!full) return { kind: "urlset", urls: [], count: (xml.match(/<url\b[^>]*>/gi) || []).length };
  const urls: Loc[] = [];
  for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const loc = tag(m[1], "loc");
    if (loc) urls.push({ loc, lastmod: tag(m[1], "lastmod") || undefined });
  }
  return { kind: "urlset", urls, count: urls.length };
}

const submittedOf = (s: SitemapInfo) => {
  const c = s.contents || [];
  if (!c.length) return null;
  const web = c.filter((x) => !x.type || x.type === "web");
  return (web.length ? web : c).reduce((n, x) => n + (Number(x.submitted) || 0), 0);
};

/** Top-level sitemap files for the property and the hosts we're allowed to fetch from. */
async function siteContext(token: string, siteUrl: string) {
  const host = propertyHost(siteUrl).replace(/^www\./, "");
  const domain = registrableDomain(host);
  const listed = await listSitemaps(token, siteUrl).catch(() => [] as SitemapInfo[]);
  const trusted = new Set(listed.map((s) => hostOf(s.path)).filter(Boolean));
  const allowHost = (h: string) => registrableDomain(h) === domain || trusted.has(h);
  const origins = siteUrl.startsWith("sc-domain:") ? [`https://${host}`, `https://www.${host}`] : [new URL(siteUrl).origin];
  const robotsMaps = (await Promise.all(origins.map((o) => getRobots(o)))).flatMap((r) => r?.sitemaps || []);
  const from = new Map<string, string>();
  for (const s of listed) from.set(s.path, "Search Console");
  for (const r of robotsMaps) if (!from.has(r)) from.set(r, "robots.txt");
  const optional = new Set<string>();
  for (const o of origins) {
    const f = `${o}/sitemap.xml`;
    if (!from.has(f)) {
      from.set(f, "/sitemap.xml");
      optional.add(f);
    }
  }
  return { listed, allowHost, from, optional };
}

/** Every sitemap file we can find, with URL counts, for the picker. */
export async function discover(token: string, siteUrl: string): Promise<SitemapList> {
  const ctx = await siteContext(token, siteUrl);
  const gsc = new Map(ctx.listed.map((s) => [s.path, s] as const));
  const files = new Map<string, SitemapFile>();
  const entry = (url: string, parent: string | null, foundIn: string, lastmod?: string) => {
    if (files.has(url)) return;
    const g = gsc.get(url);
    files.set(url, {
      url, parent, foundIn, type: "unread", urls: null, children: null,
      submitted: g ? submittedOf(g) : null,
      ...(lastmod ? { lastmod } : {}),
    });
  };
  for (const [url, foundIn] of ctx.from) entry(url, null, foundIn);

  const queue = Array.from(ctx.from.keys());
  const seen = new Set<string>();
  const started = Date.now();
  let timedOut = false;
  while (queue.length && seen.size < MAX_FILES) {
    if (Date.now() - started > LIST_BUDGET_MS) {
      timedOut = true;
      break;
    }
    const batch: string[] = [];
    while (queue.length && batch.length < PARALLEL) {
      const u = queue.shift()!;
      if (!seen.has(u)) {
        seen.add(u);
        batch.push(u);
      }
    }
    await Promise.all(
      batch.map(async (u) => {
        const f = files.get(u);
        if (!f) return;
        try {
          const p = parse(await readXml(u, ctx.allowHost), false);
          if (p.kind === "index") {
            f.type = "index";
            f.children = p.children.length;
            for (const c of p.children) {
              if (!files.has(c.loc)) {
                entry(c.loc, u, "", c.lastmod);
                queue.push(c.loc);
              }
            }
          } else {
            f.type = "urlset";
            f.urls = p.count;
          }
        } catch (e) {
          if (ctx.optional.has(u)) files.delete(u); // a missing /sitemap.xml is normal
          else {
            f.type = "error";
            f.error = e instanceof Error ? e.message : "Failed";
          }
        }
      })
    );
  }
  const unread = Array.from(files.values()).filter((f) => f.type === "unread").length;
  const note = unread
    ? `${unread.toLocaleString()} sitemap file(s) weren't opened ${timedOut ? "within the time limit" : "(file limit reached)"}, so their URL counts are unknown. You can still choose them.`
    : "";
  return { files: Array.from(files.values()), note };
}

export type CollectedUrl = { url: string; sources: string[]; lastmod?: string; sitemap?: string };

/** URL list from the chosen sitemap files (or all of them when `chosen` is null), plus search pages if asked. */
export async function collect(token: string, siteUrl: string, chosen: string[] | null, includeSearch: boolean) {
  const ctx = await siteContext(token, siteUrl);
  const queue = chosen ? [...chosen] : Array.from(ctx.from.keys());
  const optional = chosen ? new Set<string>() : ctx.optional;

  const seen = new Set<string>();
  const read: { path: string; urls: number }[] = [];
  const urls = new Map<string, { url: string; sources: Set<string>; lastmod?: string; sitemap?: string }>();
  const errors: { sitemap: string; error: string }[] = [];
  let outside = 0;
  let timedOut = false;
  const add = (raw: string, source: string, lastmod?: string, sitemap?: string) => {
    const url = normalizeUrl(raw);
    if (!urlInProperty(siteUrl, url)) {
      outside++;
      return;
    }
    const e = urls.get(url) || { url, sources: new Set<string>() };
    e.sources.add(source);
    if (lastmod && (!e.lastmod || lastmod > e.lastmod)) e.lastmod = lastmod;
    if (sitemap && !e.sitemap) e.sitemap = sitemap;
    urls.set(url, e);
  };

  const started = Date.now();
  while (queue.length && seen.size < MAX_FILES && urls.size < MAX_URLS) {
    if (Date.now() - started > BUDGET_MS) {
      timedOut = true;
      break;
    }
    const batch: string[] = [];
    while (queue.length && batch.length < PARALLEL) {
      const sm = queue.shift()!;
      if (!seen.has(sm)) {
        seen.add(sm);
        batch.push(sm);
      }
    }
    await Promise.all(
      batch.map(async (sm) => {
        try {
          const p = parse(await readXml(sm, ctx.allowHost), true);
          if (p.kind === "index") {
            for (const c of p.children) if (!seen.has(c.loc)) queue.push(c.loc);
            read.push({ path: sm, urls: 0 });
          } else {
            for (const u of p.urls) add(u.loc, "sitemap", u.lastmod, sm);
            read.push({ path: sm, urls: p.urls.length });
          }
        } catch (e) {
          if (!optional.has(sm)) errors.push({ sitemap: sm, error: e instanceof Error ? e.message : "Failed" });
        }
      })
    );
  }
  const unread = queue.filter((q) => !seen.has(q)).length;
  if (timedOut || unread) {
    errors.push({
      sitemap: `${unread} more sitemap file(s)`,
      error: timedOut ? "not read: 35-second time limit" : "not read: file or URL limit reached",
    });
  }

  if (includeSearch) {
    // Every page with impressions in the last 90 days (ending on the latest final day).
    const end = await latestFinalDate(token, siteUrl);
    const perf = await searchAnalyticsAll(token, siteUrl, { startDate: addDays(end, -89), endDate: end, dimensions: ["page"] }, MAX_ROWS);
    for (const r of perf) add(r.keys[0], "search");
  }

  return {
    sitemaps: read.map((r) => r.path),
    sitemapStatus: ctx.listed.map((s) => ({
      path: s.path,
      errors: Number(s.errors || 0),
      warnings: Number(s.warnings || 0),
      isPending: !!s.isPending,
      lastDownloaded: s.lastDownloaded || "",
      lastSubmitted: s.lastSubmitted || "",
      readByDashboard: read.find((r) => r.path === s.path)?.urls ?? null,
    })),
    errors,
    outsideProperty: outside,
    urls: Array.from(urls.values())
      .slice(0, MAX_URLS)
      .map(
        (e): CollectedUrl => ({
          url: e.url,
          sources: Array.from(e.sources),
          ...(e.lastmod ? { lastmod: e.lastmod } : {}),
          ...(e.sitemap ? { sitemap: e.sitemap } : {}),
        })
      ),
  };
}
