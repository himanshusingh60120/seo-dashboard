// app/api/audit/crawl/route.ts
// Audit step (server): the deep crawl. Fetches up to 8 pages of the property and returns each page's status,
// redirect hops and the internal links on it, so the browser can follow links site-wide and record which page
// links where. Same safety as /api/audit/http: audit account only, own hosts only, public IPs only (safeFetch),
// and robots.txt is respected the way Googlebot reads it.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireAuditUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { BlockedUrlError, getRobots, readText, robotsAllows, safeFetch } from "@/lib/safeFetch";
import { normalizeUrl, propertyHost, urlInProperty } from "@/lib/url";
import { fail, pool } from "@/lib/api";
import type { CrawlRow } from "@/lib/audit/crawl";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_URLS = 8;
const MAX_LINKS = 2000;
const BUDGET_MS = 40_000;

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? m[1] ?? m[2] ?? m[3] ?? "" : "";
};

/** Every <a href> on the page that points inside the property, normalised like the rest of the dashboard. */
function linksOn(html: string, pageUrl: string, siteUrl: string): string[] {
  let base = pageUrl;
  const b = html.match(/<base\b[^>]*>/i);
  if (b) {
    const h = attr(b[0], "href");
    if (h) {
      try { base = new URL(h, pageUrl).toString(); } catch { /* keep the page URL */ }
    }
  }
  const out = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    if (out.size >= MAX_LINKS) break;
    const href = attr(tag, "href").trim().replace(/&amp;/g, "&");
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    try {
      const u = normalizeUrl(new URL(href, base).toString());
      if (urlInProperty(siteUrl, u)) out.add(u);
    } catch { /* unparsable href */ }
  }
  return Array.from(out);
}

export async function POST(req: NextRequest) {
  try {
    await requireAuditUser(req);
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const siteUrl = String(body.siteUrl || "");
    await assertSiteAccess(token, siteUrl);
    const host = propertyHost(siteUrl);
    const allowHost = siteUrl.startsWith("sc-domain:")
      ? (h: string) => h === host || h.endsWith(`.${host}`)
      : (h: string) => h === host;
    const list: string[] = Array.isArray(body.urls) ? body.urls.map(String) : [];
    const urls = Array.from(new Set(list.map(normalizeUrl))).filter((u) => urlInProperty(siteUrl, u)).slice(0, MAX_URLS);
    const deadline = Date.now() + BUDGET_MS;

    const rows = await pool(urls, MAX_URLS, async (url): Promise<CrawlRow> => {
      const row: CrawlRow = {
        url, status: 0, chain: "", finalUrl: url, redirects: 0, loop: false,
        robotsBlocked: false, inconclusive: false, error: "", links: [], skipped: false,
      };
      if (Date.now() > deadline) return { ...row, skipped: true };
      try {
        const u = new URL(url);
        const robots = await getRobots(u.origin);
        if (robots && !robotsAllows(robots, u.pathname + u.search)) return { ...row, robotsBlocked: true };
        const r = await safeFetch(url, { allowHost, timeoutMs: 8000 });
        row.chain = r.chain.map((h) => h.status).join(" → ");
        row.finalUrl = r.finalUrl;
        row.redirects = Math.max(0, r.chain.length - 1);
        row.loop = r.loop;
        if (!r.res) {
          row.status = r.chain[r.chain.length - 1]?.status || 0;
          row.error = r.loop ? "Redirect loop" : "More than 5 redirects";
          return row;
        }
        const res = r.res;
        row.status = res.status;
        // 403/429/503 to an automated checker is often bot protection, not what Googlebot sees.
        row.inconclusive = res.status === 403 || res.status === 429 || res.status === 503;
        if (res.status === 200 && (res.headers.get("content-type") || "").includes("html") && urlInProperty(siteUrl, r.finalUrl)) {
          row.links = linksOn(await readText(res, 1_500_000), r.finalUrl, siteUrl);
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } catch (e) {
        row.error = e instanceof Error ? (e.name === "TimeoutError" ? "Timed out after 8 s" : e.message) : "Request failed";
        row.inconclusive = !(e instanceof BlockedUrlError);
      }
      return row;
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return fail(e);
  }
}
