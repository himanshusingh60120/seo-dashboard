// app/api/gsc/sitemaps/route.ts
// Sitemaps submitted in Search Console, with when Google last read each one.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { assertSiteAccess, listSitemaps, type SitemapInfo } from "@/lib/google";
import { Recorder } from "@/lib/provenance";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const submittedOf = (s: SitemapInfo) => {
  const c = s.contents || [];
  if (!c.length) return null;
  const web = c.filter((x) => !x.type || x.type === "web");
  return (web.length ? web : c).reduce((n, x) => n + (Number(x.submitted) || 0), 0);
};

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, site);
    const rec = new Recorder();
    const list = await rec.call(
      {
        id: "gsc.sitemaps",
        label: "Sitemaps submitted in Search Console",
        system: "Google Search Console API (Sitemaps)",
        endpoint: `GET https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`,
        verifyUrl: `https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(site)}`,
        verifyLabel: "Open Sitemaps in Search Console",
        verifyHow: "Search Console → Indexing → Sitemaps. The “Last read” column is the same date as “Last read by Google” here.",
      },
      () => listSitemaps(token, site),
      (rows) => rows
    );
    return NextResponse.json({
      sources: rec.sources,
      fetchedAt: new Date().toISOString(),
      sitemaps: list.map((s) => ({
        path: s.path,
        lastDownloaded: s.lastDownloaded || "",
        lastSubmitted: s.lastSubmitted || "",
        isPending: !!s.isPending,
        isIndex: !!s.isSitemapsIndex,
        errors: Number(s.errors || 0),
        warnings: Number(s.warnings || 0),
        submitted: submittedOf(s),
      })),
    });
  } catch (e) {
    return fail(e);
  }
}
