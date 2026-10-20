// app/api/audit/check/route.ts
// Evidence per URL: Google's URL Inspection record (coverage state, last crawl, canonicals,
// sitemaps, referring URLs), a live hop-by-hop fetch, the robots.txt rule that applies, and a
// re-fetch of up to 3 referring pages on your site to confirm the link is still there.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import { inspectUrl } from "@/lib/google";
import { fail, pool } from "@/lib/api";
import { followChain } from "@/lib/liveCheck";
import { robotsVerdict } from "@/lib/robots";
import { isInternal, normUrl, sameUrlLoose, type AuditCheck, type GoogleView, type RefCheck } from "@/lib/auditRules";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_URLS = 5;
const BUDGET_MS = 48000;
const VERIFY_REFS = 3;

type Insp = Awaited<ReturnType<typeof inspectUrl>>;

function googleView(x: Insp): GoogleView {
  const r = (x.raw || {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  return {
    verdict: x.verdict,
    coverageState: x.coverageState,
    indexingState: x.indexingState,
    lastCrawlTime: x.lastCrawlTime,
    googleCanonical: x.googleCanonical,
    userCanonical: str(r.userCanonical),
    pageFetchState: str(r.pageFetchState),
    robotsTxtState: str(r.robotsTxtState),
    crawledAs: str(r.crawledAs),
    sitemaps: arr(r.sitemap),
    referringUrls: arr(r.referringUrls),
    link: x.link,
  };
}

export async function POST(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const body = (await req.json()) as { siteUrl?: string; urls?: string[]; live?: boolean; verifyRefs?: boolean };
    const siteUrl = body.siteUrl;
    const urls = body.urls;
    if (!siteUrl || !Array.isArray(urls)) return NextResponse.json({ error: "Missing siteUrl or urls" }, { status: 400 });
    const live = body.live !== false;
    const verifyRefs = body.verifyRefs !== false;
    const deadline = Date.now() + BUDGET_MS;
    let quotaExceeded = false;

    const results = await pool(urls.slice(0, MAX_URLS), MAX_URLS, async (url): Promise<AuditCheck | null> => {
      const internal = isInternal(url, siteUrl);
      const inspP = inspectUrl(token, siteUrl, url)
        .then((x) => ({ ok: true as const, x }))
        .catch((e: unknown) => {
          const quota = e instanceof HttpError && e.status === 429;
          if (quota) quotaExceeded = true;
          return { ok: false as const, error: e instanceof Error ? e.message : "URL Inspection failed", quota };
        });
      const robotsP = internal ? robotsVerdict(url).catch(() => null) : Promise.resolve(null);
      // Don't fetch URLs robots.txt blocks for Googlebot
      const liveP = robotsP.then((rv) => (live && internal && !(rv && rv.allowed === false) ? followChain(url, { deadline }) : null));
      const [insp, liveRes, robots] = await Promise.all([inspP, liveP, robotsP]);
      if (!insp.ok && insp.quota) return null; // not checked; stays queued for tomorrow
      const google = insp.ok ? googleView(insp.x) : null;

      let refs: RefCheck[] = [];
      if (google && live && verifyRefs) {
        const target = normUrl(url);
        const own = google.referringUrls.filter((r) => isInternal(r, siteUrl)).slice(0, VERIFY_REFS);
        refs = await Promise.all(
          own.map(async (ref): Promise<RefCheck> => {
            const page = await followChain(ref, { deadline, withLinks: true });
            if (!page.links) return { url: ref, status: "unreachable", http: page.finalStatus, note: page.error || `HTTP ${page.finalStatus}` };
            const exact = page.links.find((h) => h === target);
            if (exact) return { url: ref, status: "links", exact: true, http: page.finalStatus, href: exact };
            const similar = page.links.find((h) => sameUrlLoose(h, url));
            if (similar) return { url: ref, status: "links", exact: false, http: page.finalStatus, href: similar };
            return { url: ref, status: "no_link", http: page.finalStatus };
          })
        );
      }
      if (liveRes) delete liveRes.links;
      return {
        url,
        checkedAt: new Date().toISOString(),
        google,
        googleError: insp.ok ? undefined : insp.error,
        live: liveRes,
        robots,
        refs,
      };
    });

    return NextResponse.json({ results: results.filter(Boolean), quotaExceeded });
  } catch (e) {
    return fail(e);
  }
}
