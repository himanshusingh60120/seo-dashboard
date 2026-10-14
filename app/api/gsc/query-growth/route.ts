// app/api/gsc/query-growth/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { assertSiteAccess, gscWindow, searchAnalytics, searchAnalyticsAll, MAX_ROWS, SARow, SABody, saRequest, saEndpoint } from "@/lib/google";
import { brandFromSite } from "@/lib/url";
import { Recorder, gscPerformanceUrl, GSC_EXPLORER } from "@/lib/provenance";
import { parseDays, parseCompare, periodName, compareName } from "@/lib/dates";
import { buildGrowthReport, growthCalcSources, QueryPair, Totals } from "@/lib/queryGrowth";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const int = (v: string | null, d: number, min: number, max: number) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};

/**
 * Consolidated query growth: every query Search Console returns for this period and the comparison period,
 * matched query by query. The report itself is built by lib/queryGrowth.ts (the same code used for imports).
 */
export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const p = req.nextUrl.searchParams;
    const siteUrl = p.get("site");
    if (!siteUrl) return NextResponse.json({ error: "Missing site" }, { status: 400 });
    await assertSiteAccess(token, siteUrl);

    const days = parseDays(p.get("days"));
    const compare = parseCompare(p.get("compare"), days);
    const minImpr = int(p.get("minImpr"), 20, 1, 1_000_000);
    // "shop.acme-shoes.co.in" → "acmeshoes" (the registrable domain), which matches "acme shoes" once spaces are removed
    const brand = p.get("brand") ?? brandFromSite(siteUrl);
    // Windows end on the latest day with final data for this property (looked up, not guessed)
    const { current, previous, dataThrough } = await gscWindow(token, siteUrl, days, compare);

    const rec = new Recorder();
    const system = "Google Search Console API (Search Analytics)";
    const explorer = { explorerUrl: GSC_EXPLORER, explorerLabel: "Rerun this request in Google's API Explorer" };

    const totals = (id: string, label: string, body: SABody) =>
      rec.call(
        {
          id, label, system, endpoint: saEndpoint(siteUrl), request: saRequest(body), range: body,
          verifyUrl: gscPerformanceUrl(siteUrl, body),
          verifyLabel: "Open the same report in Search Console",
          verifyHow: `Search Console → Performance → Search results. Set the date range to ${body.startDate} – ${body.endDate} (custom), search type Web. The totals at the top should match.`,
          ...explorer,
        },
        () => searchAnalytics(token, siteUrl, body),
        (rows) => rows
      );

    const queries = (id: string, label: string, body: SABody & { dimensions: string[] }) =>
      rec.call(
        {
          id, label, system, endpoint: saEndpoint(siteUrl),
          request: { ...saRequest({ ...body, rowLimit: 25000, startRow: 0 }), _note: "Repeated with startRow 25000 until fewer rows come back (max 50,000)." },
          range: { startDate: body.startDate, endDate: body.endDate },
          verifyUrl: gscPerformanceUrl(siteUrl, body, "query"),
          verifyLabel: "Open the same report in Search Console",
          verifyHow: `Search Console → Performance → Search results → Queries, date range ${body.startDate} – ${body.endDate}. The interface shows at most 1,000 rows; the API returns up to 50,000 per period, so more queries appear here.`,
          ...explorer,
        },
        () => searchAnalyticsAll(token, siteUrl, body),
        (rows) => rows
      );

    const [totCur, totPrev, qCur, qPrev] = await Promise.all([
      totals("growth.totals.current", `Site totals, ${current.startDate} – ${current.endDate}`, { ...current }),
      totals("growth.totals.previous", `Site totals, ${previous.startDate} – ${previous.endDate}`, { ...previous }),
      queries("growth.queries.current", `Every query, ${current.startDate} – ${current.endDate}`, { ...current, dimensions: ["query"] }),
      queries("growth.queries.previous", `Every query, ${previous.startDate} – ${previous.endDate}`, { ...previous, dimensions: ["query"] }),
    ]);

    const t = (rows: SARow[]): Totals =>
      rows[0]
        ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position }
        : { clicks: 0, impressions: 0, ctr: 0, position: null };
    const per = (r: SARow) => ({ clicks: r.clicks, impressions: r.impressions, position: r.position });

    const merged = new Map<string, QueryPair>();
    for (const r of qCur) merged.set(r.keys[0], { query: r.keys[0], cur: per(r), prev: null });
    for (const r of qPrev) {
      const m = merged.get(r.keys[0]);
      if (m) m.prev = per(r);
      else merged.set(r.keys[0], { query: r.keys[0], cur: null, prev: per(r) });
    }

    const capped = qCur.length >= MAX_ROWS || qPrev.length >= MAX_ROWS;
    const report = buildGrowthReport({
      origin: "live",
      subject: siteUrl,
      currentLabel: `the ${periodName(days)} (${current.startDate} to ${current.endDate})`,
      previousLabel: `${compareName(days, compare)} (${previous.startDate} to ${previous.endDate})`,
      currentRange: current,
      previousRange: previous,
      siteTotals: { current: t(totCur), previous: t(totPrev) },
      brand,
      minImpr,
      pairs: Array.from(merged.values()),
      coverage:
        `Live from the Search Console API (data complete through ${dataThrough}): ${qCur.length.toLocaleString()} queries this period and ${qPrev.length.toLocaleString()} in the comparison period. ` +
        (capped ? "The API returns at most 50,000 queries per period, so the least-searched queries are left out. " : "") +
        "Totals are Search Console's site totals, which also count rare queries Google hides for privacy.",
    });

    growthCalcSources(
      ["growth.totals.current", "growth.totals.previous", "growth.queries.current", "growth.queries.previous"],
      minImpr,
      report.brand
    ).forEach((s) => rec.add(s));

    return NextResponse.json({ sources: rec.sources, report });
  } catch (e) {
    return fail(e);
  }
}
