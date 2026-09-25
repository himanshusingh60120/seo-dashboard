import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { searchAnalytics, searchAnalyticsAll, normalizeHost, SARow } from "@/lib/google";
import { ranges, parseDays } from "@/lib/dates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUESTION = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will)\b/i;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

type Row = { key: string; clicks: number; impressions: number; ctr: number; position: number };
const toRow = (r: SARow): Row => ({
  key: r.keys[0],
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: r.ctr,
  position: r.position,
});

function bucketOf(pos: number) {
  if (pos <= 10) return "top10";
  if (pos <= 20) return "top20";
  if (pos <= 30) return "top30";
  return "beyond";
}

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const siteUrl = req.nextUrl.searchParams.get("site");
    if (!siteUrl) return NextResponse.json({ error: "Missing site" }, { status: 400 });
    const days = parseDays(req.nextUrl.searchParams.get("days"));
    const minImpr = Number(req.nextUrl.searchParams.get("minImpr") || 20);
    const dropBy = Number(req.nextUrl.searchParams.get("dropBy") || 5);
    const { current, previous } = ranges(days, "gsc");
    const brand = (req.nextUrl.searchParams.get("brand") || normalizeHost(siteUrl).split(".")[0]).toLowerCase();

    const [totCur, totPrev, trend, pagesCur, pagesPrev, qCur, qPrev] = await Promise.all([
      searchAnalytics(token, siteUrl, { ...current }),
      searchAnalytics(token, siteUrl, { ...previous }),
      searchAnalytics(token, siteUrl, { ...current, dimensions: ["date"], rowLimit: 500 }),
      searchAnalyticsAll(token, siteUrl, { ...current, dimensions: ["page"] }),
      searchAnalyticsAll(token, siteUrl, { ...previous, dimensions: ["page"] }),
      searchAnalyticsAll(token, siteUrl, { ...current, dimensions: ["query"] }),
      searchAnalyticsAll(token, siteUrl, { ...previous, dimensions: ["query"] }),
    ]);

    const t = (rows: SARow[]) =>
      rows[0]
        ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position }
        : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

    /* ---------- Pages & rank buckets ---------- */
    const prevPageMap = new Map(pagesPrev.map((r) => [r.keys[0], r]));
    const pages = pagesCur.map((r) => {
      const p = prevPageMap.get(r.keys[0]);
      return {
        ...toRow(r),
        prevPosition: p ? p.position : null,
        prevClicks: p ? p.clicks : 0,
        bucket: bucketOf(r.position),
      };
    });

    const bucketCounts = { top10: 0, top20: 0, top30: 0, beyond: 0 };
    pages.forEach((p) => (bucketCounts[p.bucket as keyof typeof bucketCounts] += 1));
    const bucketPages = (b: string) =>
      pages
        .filter((p) => p.bucket === b)
        .sort((a, z) => z.clicks - a.clicks || z.impressions - a.impressions)
        .slice(0, 1000);

    /* ---------- Pages that lost rank ---------- */
    const curPageSet = new Set(pagesCur.map((r) => r.keys[0]));
    const losers = pages
      .filter((p) => p.prevPosition !== null)
      .map((p) => ({ ...p, change: round(p.position - (p.prevPosition as number)) }))
      .filter((p) => p.change >= dropBy && (prevPageMap.get(p.key)?.impressions || 0) >= minImpr)
      .sort((a, z) => z.change - a.change)
      .slice(0, 300);
    const vanished = pagesPrev
      .filter((r) => !curPageSet.has(r.keys[0]) && r.impressions >= minImpr)
      .sort((a, z) => z.impressions - a.impressions)
      .slice(0, 100)
      .map((r) => ({ key: r.keys[0], prevPosition: r.position, prevImpressions: r.impressions, prevClicks: r.clicks }));

    /* ---------- Query summary ---------- */
    const prevQ = new Map(qPrev.map((r) => [r.keys[0], r]));
    const curQSet = new Set(qCur.map((r) => r.keys[0]));
    const queries = qCur.map((r) => {
      const p = prevQ.get(r.keys[0]);
      return { ...toRow(r), prevPosition: p ? p.position : null, prevImpressions: p ? p.impressions : 0 };
    });

    const qBuckets = { top3: 0, top10: 0, top20: 0, top30: 0, beyond: 0 };
    const lengths = { short: 0, medium: 0, long: 0 };
    let branded = { queries: 0, clicks: 0, impressions: 0 };
    let questions: typeof queries = [];
    for (const q of queries) {
      if (q.position <= 3) qBuckets.top3++;
      else if (q.position <= 10) qBuckets.top10++;
      else if (q.position <= 20) qBuckets.top20++;
      else if (q.position <= 30) qBuckets.top30++;
      else qBuckets.beyond++;
      const words = q.key.trim().split(/\s+/).length;
      if (words <= 2) lengths.short++;
      else if (words <= 4) lengths.medium++;
      else lengths.long++;
      if (brand.length >= 3 && q.key.toLowerCase().replace(/\s+/g, "").includes(brand)) {
        branded.queries++;
        branded.clicks += q.clicks;
        branded.impressions += q.impressions;
      }
      if (QUESTION.test(q.key)) questions.push(q);
    }

    const qClicks = queries.reduce((s, q) => s + q.clicks, 0);
    const qImpr = queries.reduce((s, q) => s + q.impressions, 0);
    const byClicks = [...queries].sort((a, z) => z.clicks - a.clicks).slice(0, 100);
    const byImpr = [...queries].sort((a, z) => z.impressions - a.impressions).slice(0, 100);
    const opportunities = queries
      .filter((q) => q.position > 3 && q.position <= 20 && q.impressions >= minImpr)
      .sort((a, z) => z.impressions - a.impressions)
      .slice(0, 100);
    const movers = queries
      .filter((q) => q.prevPosition !== null && q.impressions >= minImpr)
      .map((q) => ({ ...q, change: round(q.position - (q.prevPosition as number)) }));
    const rising = [...movers].filter((q) => q.change < 0).sort((a, z) => a.change - z.change).slice(0, 50);
    const falling = [...movers].filter((q) => q.change > 0).sort((a, z) => z.change - a.change).slice(0, 50);
    const newQueries = queries.filter((q) => !prevQ.has(q.key));
    const lostQueries = qPrev.filter((r) => !curQSet.has(r.keys[0]));
    questions = questions.sort((a, z) => z.impressions - a.impressions);

    const tc = t(totCur);
    const tp = t(totPrev);
    const pct = (a: number, b: number) => (b ? round(((a - b) / b) * 100) : 0);
    const narrative = [
      `The site appeared for ${queries.length.toLocaleString()} distinct search queries between ${current.startDate} and ${current.endDate}, collecting ${tc.impressions.toLocaleString()} impressions and ${tc.clicks.toLocaleString()} clicks.`,
      `Impressions are ${pct(tc.impressions, tp.impressions) >= 0 ? "up" : "down"} ${Math.abs(pct(tc.impressions, tp.impressions))}% and clicks ${pct(tc.clicks, tp.clicks) >= 0 ? "up" : "down"} ${Math.abs(pct(tc.clicks, tp.clicks))}% versus the previous ${days} days; average position moved from ${round(tp.position)} to ${round(tc.position)}.`,
      `${qBuckets.top3 + qBuckets.top10} queries rank on page one (${qBuckets.top3} of them in the top 3), ${qBuckets.top20} sit on page two and ${qBuckets.top30} on page three.`,
      branded.queries
        ? `Queries containing “${brand}” account for ${branded.queries} queries and ${qClicks ? round((branded.clicks / qClicks) * 100) : 0}% of query-level clicks.`
        : `No queries containing “${brand}” were found, so traffic here is almost entirely non-branded.`,
      `${newQueries.length} queries are new this period and ${lostQueries.length} from the previous period no longer show up.`,
      opportunities.length
        ? `${opportunities.length} queries rank between positions 4 and 20 with at least ${minImpr} impressions — the closest candidates for moving up. The largest is “${opportunities[0].key}” (${opportunities[0].impressions.toLocaleString()} impressions at position ${round(opportunities[0].position)}).`
        : `No queries between positions 4 and 20 reached ${minImpr} impressions.`,
      `${questions.length} queries are phrased as questions and ${lengths.long} are five words or longer.`,
    ];

    return NextResponse.json({
      range: current,
      previousRange: previous,
      totals: { current: tc, previous: tp },
      trend: trend.map((r) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      pageCount: pages.length,
      buckets: bucketCounts,
      bucketPages: { top10: bucketPages("top10"), top20: bucketPages("top20"), top30: bucketPages("top30") },
      losers,
      vanished,
      queries: {
        brand,
        count: queries.length,
        clicks: qClicks,
        impressions: qImpr,
        buckets: qBuckets,
        lengths,
        branded,
        narrative,
        byClicks,
        byImpressions: byImpr,
        opportunities,
        rising,
        falling,
        questions: questions.slice(0, 100),
        questionCount: questions.length,
        newCount: newQueries.length,
        newTop: newQueries.sort((a, z) => z.impressions - a.impressions).slice(0, 50),
        lostCount: lostQueries.length,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
