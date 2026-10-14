// app/api/audit/http/route.ts
// Audit step (server): live checks of up to 25 URLs of the property — status, redirects, noindex, canonical,
// robots.txt. Free; SSRF-safe (own hosts only, public IPs only).
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireAuditUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { checkPage } from "@/lib/safeFetch";
import { propertyHost, urlInProperty } from "@/lib/url";
import type { HttpRow } from "@/lib/audit/rules";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const urls = Array.from(new Set(list)).filter((u) => urlInProperty(siteUrl, u)).slice(0, 25);
    const rows = await pool(urls, 6, async (url): Promise<HttpRow> => {
      const p = await checkPage(url, { allowHost, robots: true });
      return {
        url,
        status: p.status,
        chain: p.chain.map((h) => h.status).join(" → "),
        finalUrl: p.finalUrl,
        redirects: p.redirects,
        loop: p.loop,
        inconclusive: p.inconclusive,
        noindex: p.noindex,
        canonical: p.canonical,
        canonicalElsewhere: p.canonicalElsewhere,
        robotsBlocked: p.robotsBlocked,
        error: p.error,
      };
    });
    return NextResponse.json({ rows });
  } catch (e) {
    return fail(e);
  }
}
