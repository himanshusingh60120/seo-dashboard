// app/api/gsc/sitemap-urls/route.ts
// Builds the URL list: every sitemap Search Console knows + robots.txt "Sitemap:" lines + /sitemap.xml
// (following sitemap indexes, .gz supported), plus every page with impressions in the last 90 days.
// URLs are normalised and de-duplicated; URLs outside the property are skipped. Fetches only go to your own
// domains or to sitemap hosts listed in Search Console, and never to private addresses.
import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "zlib";
import { getGoogleAccessToken } from "@/lib/token";
import { assertSiteAccess, latestFinalDate, listSitemaps, searchAnalyticsAll, MAX_ROWS } from "@/lib/google";
import { getRobots, safeFetch } from "@/lib/safeFetch";
import { addDays } from "@/lib/dates";
import { normalizeUrl, propertyHost, registrableDomain, urlInProperty } from "@/lib/url";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_URLS = 100_000;
const MAX_FILES = 2000;
const PARALLEL = 8;
/** Stop reading sitemaps after this long so the request ends inside Vercel's 60-second limit. */
const BUDGET_MS = 35_000;
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

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const siteUrl = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, siteUrl);

    const host = propertyHost(siteUrl).replace(/^www\./, "");
    const domain = registrableDomain(host);
    const listed = await listSitemaps(token, siteUrl).catch(() => []);
    const trusted = new Set(listed.map((s) => hostOf(s.path)).filter(Boolean));
    const allowHost = (h: string) => registrableDomain(h) === domain || trusted.has(h);
    const origins = siteUrl.startsWith("sc-domain:") ? [`https://${host}`, `https://www.${host}`] : [new URL(siteUrl).origin];
    const robotsMaps = (await Promise.all(origins.map((o) => getRobots(o)))).flatMap((r) => r?.sitemaps || []);
    const queue = Array.from(new Set([...listed.map((s) => s.path), ...robotsMaps]));
    const optional = new Set<string>();
    for (const o of origins) {
      const f = `${o}/sitemap.xml`;
      if (!queue.includes(f)) {
        queue.push(f);
        optional.add(f);
      }
    }

    const seen = new Set<string>();
    const read: { path: string; urls: number }[] = [];
    const urls = new Map<string, { url: string; sources: Set<string>; lastmod?: string }>();
    const errors: { sitemap: string; error: string }[] = [];
    let outside = 0;
    let timedOut = false;
    const add = (raw: string, source: string, lastmod?: string) => {
      const url = normalizeUrl(raw);
      if (!urlInProperty(siteUrl, url)) {
        outside++;
        return;
      }
      const e = urls.get(url) || { url, sources: new Set<string>() };
      e.sources.add(source);
      if (lastmod && (!e.lastmod || lastmod > e.lastmod)) e.lastmod = lastmod;
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
            const xml = await readXml(sm, allowHost);
            if (/<sitemapindex\b/i.test(xml)) {
              for (const m of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
                const loc = tag(m[1], "loc");
                if (loc && !seen.has(loc)) queue.push(loc);
              }
              read.push({ path: sm, urls: 0 });
            } else {
              let n = 0;
              for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
                const loc = tag(m[1], "loc");
                if (loc) {
                  add(loc, "sitemap", tag(m[1], "lastmod") || undefined);
                  n++;
                }
              }
              read.push({ path: sm, urls: n });
            }
          } catch (e) {
            if (!optional.has(sm)) errors.push({ sitemap: sm, error: e instanceof Error ? e.message : "Failed" });
          }
        })
      );
    }
    const unread = queue.filter((q) => !seen.has(q)).length;
    if (timedOut || unread) {
      errors.push({ sitemap: `${unread} more sitemap file(s)`, error: timedOut ? "not read: 35-second time limit" : "not read: file or URL limit reached" });
    }

    // Every page with impressions in the last 90 days (ending on the latest final day).
    const end = await latestFinalDate(token, siteUrl);
    const perf = await searchAnalyticsAll(token, siteUrl, { startDate: addDays(end, -89), endDate: end, dimensions: ["page"] }, MAX_ROWS);
    for (const r of perf) add(r.keys[0], "search");

    return NextResponse.json({
      sitemaps: read.map((r) => r.path),
      sitemapStatus: listed.map((s) => ({
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
        .map((e) => ({ url: e.url, sources: Array.from(e.sources), ...(e.lastmod ? { lastmod: e.lastmod } : {}) })),
    });
  } catch (e) {
    return fail(e);
  }
}
