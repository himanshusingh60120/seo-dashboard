// app/api/gsc/indexed-pages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { assertSiteAccess, latestFinalDate, searchAnalyticsAll, MAX_ROWS, saRequest, saEndpoint, type SABody, type SARow } from "@/lib/google";
import { addDays } from "@/lib/dates";
import { Recorder, gscPerformanceUrl, GSC_EXPLORER } from "@/lib/provenance";
import { fail } from "@/lib/api";
import { INDEXED_PAGE_DAYS, DEFAULT_INDEXED_PAGE_DAYS, bandOf, type IndexedPage, type IndexedPagesResponse } from "@/lib/indexedPages";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every page with at least one Google Search impression in the period.
 * A page can only be shown in results while it is indexed, so this is the full list of
 * indexed pages that ranked, fetched in one go without using the URL Inspection quota.
 */
export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const p = req.nextUrl.searchParams;
    const siteUrl = p.get("site");
    if (!siteUrl) return NextResponse.json({ error: "Missing site" }, { status: 400 });
    await assertSiteAccess(token, siteUrl);

    const n = Number(p.get("days"));
    const days = (INDEXED_PAGE_DAYS as readonly number[]).includes(n) ? n : DEFAULT_INDEXED_PAGE_DAYS;
    const end = await latestFinalDate(token, siteUrl);
    const range = { startDate: addDays(end, -(days - 1)), endDate: end };
    const recentRange = days > 7 ? { startDate: addDays(end, -6), endDate: end } : null;

    const rec = new Recorder();
    const system = "Google Search Console API (Search Analytics)";
    const explorer = { explorerUrl: GSC_EXPLORER, explorerLabel: "Rerun this request in Google's API Explorer" };

    const list = (id: string, label: string, body: SABody & { dimensions: string[] }, verifyHow: string) =>
      rec.call(
        {
          id,
          label,
          system,
          endpoint: saEndpoint(siteUrl),
          request: { ...saRequest({ ...body, rowLimit: 25000, startRow: 0 }), _note: "Repeated with startRow 25000 until fewer rows come back (max 50,000)." },
          range: { startDate: body.startDate, endDate: body.endDate },
          verifyUrl: gscPerformanceUrl(siteUrl, body, "page"),
          verifyLabel: "Open the same report in Search Console",
          verifyHow,
          ...explorer,
        },
        () => searchAnalyticsAll(token, siteUrl, body),
        (rows) => rows
      );

    const uiLimit = "The Search Console interface shows at most 1,000 rows (export included); the API returns up to 50,000, so this list can be longer.";
    const [pageRows, pairRows, recentRows] = await Promise.all([
      list(
        "indexedPages.pages",
        `Every page with impressions, ${range.startDate} – ${range.endDate}`,
        { ...range, dimensions: ["page"] },
        `Search Console → Performance → Search results → Pages tab. Date range ${range.startDate} – ${range.endDate} (custom), search type Web. ${uiLimit}`
      ),
      list(
        "indexedPages.topQuery",
        `Page × query pairs (each page's top query), ${range.startDate} – ${range.endDate}`,
        { ...range, dimensions: ["page", "query"] },
        `Search Console → Performance → Search results, same dates. Click a page in the Pages tab, then open the Queries tab: the query with the most clicks is the top query shown here.`
      ),
      recentRange
        ? list(
            "indexedPages.recent",
            `Pages with impressions in the last 7 days, ${recentRange.startDate} – ${recentRange.endDate}`,
            { ...recentRange, dimensions: ["page"] },
            `Search Console → Performance → Search results → Pages tab, date range ${recentRange.startDate} – ${recentRange.endDate}, search type Web. ${uiLimit}`
          )
        : Promise.resolve<SARow[]>([]),
    ]);

    // Top query per page: most clicks, then most impressions
    const top = new Map<string, { q: string; clicks: number; impressions: number }>();
    for (const r of pairRows) {
      const [page, q] = r.keys;
      const cur = top.get(page);
      if (!cur || r.clicks > cur.clicks || (r.clicks === cur.clicks && r.impressions > cur.impressions)) {
        top.set(page, { q, clicks: r.clicks, impressions: r.impressions });
      }
    }
    const recent = new Set(recentRows.map((r) => r.keys[0]));

    const pages: IndexedPage[] = pageRows.map((r) => {
      const url = r.keys[0];
      const position = Math.round(r.position * 10) / 10;
      const t = top.get(url);
      return {
        url,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position,
        band: bandOf(position),
        topQuery: t?.q ?? "",
        topQueryClicks: t?.clicks ?? 0,
        recent: recentRange ? recent.has(url) : null,
      };
    });

    const capped = pageRows.length >= MAX_ROWS;
    rec.computed(
      "indexedPages.count",
      "Pages with impressions (indexed and ranking)",
      `Number of distinct page URLs returned by Search Analytics with dimension "page" for ${range.startDate} – ${range.endDate}, search type Web, final data only. ` +
        "Google can only show a page in search results while it is indexed, so every URL was indexed when it received impressions. " +
        "Indexed pages with no impressions in the period are not included, and Search Console credits impressions to the canonical URL Google chose." +
        (capped ? " The API returns at most 50,000 pages, so the least-seen pages are left out." : ""),
      ["indexedPages.pages"]
    );
    rec.computed(
      "indexedPages.bands",
      "Pages by average position",
      "Each page's average position (weighted by impressions across all its queries), rounded, grouped into 1–3, 4–10, 11–20, 21–30 and 31+.",
      ["indexedPages.pages"]
    );
    if (recentRange) {
      rec.computed(
        "indexedPages.recentCount",
        "Pages also shown in the last 7 days",
        `Pages from the main list that also had impressions between ${recentRange.startDate} and ${recentRange.endDate}.`,
        ["indexedPages.pages", "indexedPages.recent"]
      );
    }

    const body: IndexedPagesResponse = {
      sources: rec.sources,
      days,
      range,
      recentRange,
      dataThrough: end,
      pages,
      capped,
      topQueryCovered: pages.filter((pg) => pg.topQuery).length,
      topQueryCapped: pairRows.length >= MAX_ROWS,
    };
    return NextResponse.json(body);
  } catch (e) {
    return fail(e);
  }
}
