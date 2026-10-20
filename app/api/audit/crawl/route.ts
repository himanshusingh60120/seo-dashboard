// app/api/audit/crawl/route.ts
// One batch of the site crawler: robots.txt check, live hop-by-hop fetch, internal links.
// Only crawls Search Console properties this Google account has, and only URLs inside them.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { listSites } from "@/lib/google";
import { fail, pool } from "@/lib/api";
import { followChain } from "@/lib/liveCheck";
import { robotsVerdict } from "@/lib/robots";
import { isInternal, type CrawlResult } from "@/lib/auditRules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_URLS = 10;
const PARALLEL = 5;
const BUDGET_MS = 48000;

export async function POST(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const body = (await req.json()) as { siteUrl?: string; urls?: string[]; respectRobots?: boolean };
    const siteUrl = body.siteUrl;
    const urls = body.urls;
    if (!siteUrl || !Array.isArray(urls)) return NextResponse.json({ error: "Missing siteUrl or urls" }, { status: 400 });
    const sites = await listSites(token);
    if (!sites.some((s) => s.siteUrl === siteUrl)) throw new HttpError(403, "This property isn't in your Search Console account.");
    const respectRobots = body.respectRobots !== false;
    const deadline = Date.now() + BUDGET_MS;

    const results = await pool(urls.slice(0, MAX_URLS), PARALLEL, async (url): Promise<CrawlResult> => {
      if (!isInternal(url, siteUrl)) return { url, outside: true };
      if (deadline - Date.now() < 5000) return { url, skipped: true };
      const rv = await robotsVerdict(url).catch(() => null);
      if (respectRobots && rv && rv.allowed === false) return { url, blocked: true, rule: rv.rule };
      const live = await followChain(url, { deadline, withLinks: true });
      if (live.outOfTime) return { url, skipped: true };
      const finalInternal = isInternal(live.finalUrl, siteUrl);
      const links = finalInternal ? (live.links || []).filter((l) => isInternal(l, siteUrl)) : [];
      delete live.links;
      return { url, live, links, finalInternal, rule: rv ? rv.rule : "" };
    });
    return NextResponse.json({ results });
  } catch (e) {
    return fail(e);
  }
}
