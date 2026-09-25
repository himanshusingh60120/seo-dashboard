import { NextRequest, NextResponse } from "next/server";
import { gunzipSync } from "zlib";
import { getGoogleAccessToken } from "@/lib/token";
import { listSitemaps, searchAnalyticsAll } from "@/lib/google";
import { ranges } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_URLS = 50000;
const MAX_SITEMAPS = 60;

async function fetchXml(url: string) {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SearchDashboard/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGz = url.endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b);
  return (isGz ? gunzipSync(buf) : buf).toString("utf8");
}

const locs = (xml: string) =>
  Array.from(xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)).map((m) =>
    m[1].replace(/&amp;/g, "&")
  );

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const siteUrl = req.nextUrl.searchParams.get("site");
    if (!siteUrl) return NextResponse.json({ error: "Missing site" }, { status: 400 });

    const sitemaps = await listSitemaps(token, siteUrl);
    const queue = sitemaps.map((s) => s.path);
    const seenMaps = new Set<string>();
    const urls = new Map<string, Set<string>>();
    const errors: { sitemap: string; error: string }[] = [];

    while (queue.length && seenMaps.size < MAX_SITEMAPS && urls.size < MAX_URLS) {
      const sm = queue.shift()!;
      if (seenMaps.has(sm)) continue;
      seenMaps.add(sm);
      try {
        const xml = await fetchXml(sm);
        const found = locs(xml);
        if (/<sitemapindex/i.test(xml)) queue.push(...found);
        else for (const u of found) {
          if (!urls.has(u)) urls.set(u, new Set());
          urls.get(u)!.add("sitemap");
        }
      } catch (e) {
        errors.push({ sitemap: sm, error: e instanceof Error ? e.message : "Failed" });
      }
    }

    // Also include every page that earned impressions in the last 90 days
    const { current } = ranges(90, "gsc");
    const perf = await searchAnalyticsAll(token, siteUrl, { ...current, dimensions: ["page"] }, 25000);
    for (const r of perf) {
      const u = r.keys[0];
      if (!urls.has(u)) urls.set(u, new Set());
      urls.get(u)!.add("search");
    }

    return NextResponse.json({
      sitemaps: Array.from(seenMaps),
      errors,
      urls: Array.from(urls.entries())
        .slice(0, MAX_URLS)
        .map(([url, src]) => ({ url, sources: Array.from(src) })),
    });
  } catch (e) {
    return fail(e);
  }
}
