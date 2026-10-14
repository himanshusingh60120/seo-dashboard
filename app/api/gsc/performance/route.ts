// app/api/gsc/performance/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import {
  assertSiteAccess, gscWindow, searchAnalytics, searchAnalyticsAll, saEndpoint, saRequest, MAX_ROWS,
  type SABody, type SARow, type SearchType,
} from "@/lib/google";
import { Recorder, gscPerformanceUrl, GSC_EXPLORER } from "@/lib/provenance";
import { compareName, parseCompare, parseDays } from "@/lib/dates";
import { brandFromSite } from "@/lib/url";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUESTION = /^(how|what|why|when|where|who|which|can|does|do|is|are|should|will)\b/i;
const TYPE_LABEL: Record<string, string> = { web: "Web", image: "Image", video: "Video", news: "News" };
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const int = (v: string | null, d: number, min: number, max: number) => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};

type Row = { key: string; clicks: number; impressions: number; ctr: number; position: number };
const toRow = (r: SARow): Row => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
const bucketOf = (pos: number) => (pos <= 10 ? "top10" : pos <= 20 ? "top20" : pos <= 30 ? "top30" : "beyond");

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const token = await getGoogleAccessToken(req);
    const siteUrl = p.get("site") || "";
    await assertSiteAccess(token, siteUrl);
    const days = parseDays(p.get("days"));
    const compare = parseCompare(p.get("compare"), days);
    const type = (TYPE_LABEL[p.get("type") || ""] ? p.get("type") : "web") as SearchType;
    const minImpr = int(p.get("minImpr"), 20, 1, 1_000_000);
    const dropBy = int(p.get("dropBy"), 5, 1, 100);
    // Windows end on the latest day with final data for this property (looked up, not guessed).
    const { current, previous, dataThrough } = await gscWindow(token, siteUrl, days, compare, type);
    const brand = (p.get("brand") ?? brandFromSite(siteUrl)).toLowerCase().replace(/\s+/g, "");

    const rec = new Recorder();
    const system = `Google Search Console API (Search Analytics, ${TYPE_LABEL[type]})`;
    const explorer = { explorerUrl: GSC_EXPLORER, explorerLabel: "Rerun this request in Google's API Explorer" };
    const how = (r: { startDate: string; endDate: string }, extra = "") =>
      `Search Console → Performance → Search results. Set Search type to ${TYPE_LABEL[type]} and the date range to ${r.startDate} – ${r.endDate} (custom).${extra}`;

    const one = (id: string, label: string, body: SABody, breakdown?: "query" | "page" | "date", verifyHow?: string) =>
      rec.call(
        {
          id, label, system, endpoint: saEndpoint(siteUrl), request: saRequest(body),
          range: { startDate: body.startDate, endDate: body.endDate },
          verifyUrl: gscPerformanceUrl(siteUrl, body, breakdown), verifyLabel: "Open the same report in Search Console",
          verifyHow: verifyHow ?? how(body), ...explorer,
        },
        () => searchAnalytics(token, siteUrl, body),
        (rows) => rows
      );

    const all = (id: string, label: string, body: SABody, breakdown: "query" | "page") =>
      rec.call(
        {
          id, label, system, endpoint: saEndpoint(siteUrl),
          request: { ...saRequest({ ...body, rowLimit: 25000, startRow: 0 }), _note: "Repeated with startRow 25000 until fewer rows come back (max 50,000)." },
          range: { startDate: body.startDate, endDate: body.endDate },
          verifyUrl: gscPerformanceUrl(siteUrl, body, breakdown), verifyLabel: "Open the same report in Search Console",
          verifyHow: how(body, ` Open the ${breakdown === "page" ? "Pages" : "Queries"} tab. The interface shows at most 1,000 rows; the API returns up to 50,000.`),
          ...explorer,
        },
        () => searchAnalyticsAll(token, siteUrl, body),
        (rows) => rows
      );

    const curBody = { ...current, type };
    const prevBody = { ...previous, type };
    const [totCur, totPrev, trend, pagesCur, pagesPrev, qCur, qPrev] = await Promise.all([
      one("gsc.totals.current", `Site totals, ${current.startDate} – ${current.endDate}`, curBody, undefined, how(current, " The four totals at the top should match.")),
      one("gsc.totals.previous", `Site totals, ${previous.startDate} – ${previous.endDate}`, prevBody),
      one("gsc.trend", "Clicks, impressions, CTR and position by day", { ...curBody, dimensions: ["date"], rowLimit: 500 }, "date"),
      all("gsc.pages.current", `Pages, ${current.startDate} – ${current.endDate}`, { ...curBody, dimensions: ["page"] }, "page"),
      all("gsc.pages.previous", `Pages, ${previous.startDate} – ${previous.endDate}`, { ...prevBody, dimensions: ["page"] }, "page"),
      all("gsc.queries.current", `Queries, ${current.startDate} – ${current.endDate}`, { ...curBody, dimensions: ["query"] }, "query"),
      all("gsc.queries.previous", `Queries, ${previous.startDate} – ${previous.endDate}`, { ...prevBody, dimensions: ["query"] }, "query"),
    ]);
    const capped = {
      pages: pagesCur.length >= MAX_ROWS || pagesPrev.length >= MAX_ROWS,
      queries: qCur.length >= MAX_ROWS || qPrev.length >= MAX_ROWS,
    };

    const t = (rows: SARow[]) =>
      rows[0]
        ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position }
        : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

    /* ---------- Pages & rank buckets ---------- */
    const prevPageMap = new Map(pagesPrev.map((r) => [r.keys[0], r]));
    const pages = pagesCur.map((r) => {
      const pr = prevPageMap.get(r.keys[0]);
      return { ...toRow(r), prevPosition: pr ? pr.position : null, prevClicks: pr ? pr.clicks : 0, bucket: bucketOf(r.position) };
    });
    const bucketCounts = { top10: 0, top20: 0, top30: 0, beyond: 0 };
    pages.forEach((pg) => (bucketCounts[pg.bucket as keyof typeof bucketCounts] += 1));
    const bucketPages = (b: string) =>
      pages.filter((pg) => pg.bucket === b).sort((a, z) => z.clicks - a.clicks || z.impressions - a.impressions).slice(0, 1000);

    /* ---------- Pages that lost rank / stopped showing ---------- */
    const curPageSet = new Set(pagesCur.map((r) => r.keys[0]));
    const losers = pages
      .filter((pg) => pg.prevPosition !== null)
      .map((pg) => ({ ...pg, change: round(pg.position - (pg.prevPosition as number)) }))
      .filter((pg) => pg.change >= dropBy && (prevPageMap.get(pg.key)?.impressions || 0) >= minImpr)
      .sort((a, z) => z.change - a.change)
      .slice(0, 300);
    // With 50,000+ pages, a page missing from the list may only have fallen below the cut-off, so this isn't reported.
    const vanished = capped.pages
      ? []
      : pagesPrev
          .filter((r) => !curPageSet.has(r.keys[0]) && r.impressions >= minImpr)
          .sort((a, z) => z.impressions - a.impressions)
          .slice(0, 100)
          .map((r) => ({ key: r.keys[0], prevPosition: r.position, prevImpressions: r.impressions, prevClicks: r.clicks }));

    /* ---------- Query summary ---------- */
    const prevQ = new Map(qPrev.map((r) => [r.keys[0], r]));
    const curQSet = new Set(qCur.map((r) => r.keys[0]));
    const queries = qCur.map((r) => {
      const pr = prevQ.get(r.keys[0]);
      return { ...toRow(r), prevPosition: pr ? pr.position : null, prevImpressions: pr ? pr.impressions : 0 };
    });
    const qBuckets = { top3: 0, top10: 0, top20: 0, top30: 0, beyond: 0 };
    const lengths = { short: 0, medium: 0, long: 0 };
    const branded = { queries: 0, clicks: 0, impressions: 0 };
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
      `Search Console data is complete through ${dataThrough}. The site appeared for ${queries.length.toLocaleString()} distinct ${TYPE_LABEL[type].toLowerCase()} search queries between ${current.startDate} and ${current.endDate}, collecting ${tc.impressions.toLocaleString()} impressions and ${tc.clicks.toLocaleString()} clicks.`,
      `Impressions are ${pct(tc.impressions, tp.impressions) >= 0 ? "up" : "down"} ${Math.abs(pct(tc.impressions, tp.impressions))}% and clicks ${pct(tc.clicks, tp.clicks) >= 0 ? "up" : "down"} ${Math.abs(pct(tc.clicks, tp.clicks))}% versus ${compareName(days, compare)} (${previous.startDate} to ${previous.endDate}); average position moved from ${round(tp.position)} to ${round(tc.position)}.`,
      `${qBuckets.top3 + qBuckets.top10} queries rank on page one (${qBuckets.top3} of them in the top 3), ${qBuckets.top20} sit on page two and ${qBuckets.top30} on page three.`,
      branded.queries
        ? `Queries containing “${brand}” account for ${branded.queries} queries and ${qClicks ? round((branded.clicks / qClicks) * 100) : 0}% of query-level clicks.`
        : `No queries containing “${brand}” were found, so traffic here is almost entirely non-branded.`,
      `${newQueries.length} queries are new this period and ${lostQueries.length} from the previous period no longer show up.`,
      opportunities.length
        ? `${opportunities.length} queries rank between positions 4 and 20 with at least ${minImpr} impressions — the closest candidates for moving up. The largest is “${opportunities[0].key}” (${opportunities[0].impressions.toLocaleString()} impressions at position ${round(opportunities[0].position)}).`
        : `No queries between positions 4 and 20 reached ${minImpr} impressions.`,
      `${questions.length} queries are phrased as questions and ${lengths.long} are five words or longer.`,
      ...(capped.queries ? ["The query lists hit the API's 50,000-row limit, so the least-searched queries are left out of the counts above."] : []),
    ];

    const P = ["gsc.pages.current"];
    const PP = ["gsc.pages.current", "gsc.pages.previous"];
    const Q = ["gsc.queries.current"];
    const QQ = ["gsc.queries.current", "gsc.queries.previous"];
    rec.computed("calc.buckets", "Pages by ranking band", "Each page is placed by its average position for the period: 1–10, 11–20, 21–30 or beyond 30. This is the same “Position” Search Console shows in the Pages tab.", P);
    rec.computed("calc.losers", "Pages that lost rankings", `Pages in both periods whose average position got worse by ${dropBy} or more places and had at least ${minImpr} impressions in the previous period. Change = position now − position before.`, PP);
    rec.computed("calc.vanished", "Pages no longer showing", capped.pages ? "Not calculated: the page list hit the API's 50,000-row limit, so a missing page may only have fallen below the cut-off." : `Pages with at least ${minImpr} impressions in the previous period that don't appear at all in this period.`, PP);
    rec.computed("calc.queryBuckets", "Queries by position", "Each query is placed by its average position: 1–3, 4–10, 11–20, 21–30 or beyond 30.", Q);
    rec.computed("calc.queryLengths", "Queries by length", "Word count of each query: 1–2, 3–4, or 5 and more words.", Q);
    rec.computed("calc.branded", "Branded queries", `Queries containing “${brand}” (the site's registrable domain name; spaces removed before matching). Share = clicks on those queries ÷ total clicks across all queries returned.`, Q);
    rec.computed("calc.newLost", "New and lost queries", "New = in this period's Queries report but not the previous one. Lost = in the previous period's report but not this one.", QQ);
    rec.computed("calc.opportunities", "Queries close to page one", `Queries at average position above 3 and up to 20, with at least ${minImpr} impressions, sorted by impressions.`, Q);
    rec.computed("calc.movers", "Rising and falling queries", `Queries in both periods with at least ${minImpr} impressions now. Change = position now − position before; negative is an improvement.`, QQ);
    rec.computed("calc.questions", "Question queries", "Queries starting with how, what, why, when, where, who, which, can, does, do, is, are, should or will.", Q);
    rec.computed("calc.narrative", "Query summary", "Sentences written from the totals and query lists above; every number in them comes from those sources.", ["gsc.totals.current", "gsc.totals.previous", ...QQ]);

    return NextResponse.json({
      sources: rec.sources,
      range: current,
      previousRange: previous,
      compare,
      searchType: type,
      dataThrough,
      capped,
      totals: { current: tc, previous: tp },
      trend: trend.map((r) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      pageCount: pages.length,
      buckets: bucketCounts,
      bucketPages: { top10: bucketPages("top10"), top20: bucketPages("top20"), top30: bucketPages("top30") },
      losers,
      vanished,
      queries: {
        brand, count: queries.length, clicks: qClicks, impressions: qImpr, buckets: qBuckets, lengths, branded, narrative,
        byClicks, byImpressions: byImpr, opportunities, rising, falling,
        questions: questions.slice(0, 100), questionCount: questions.length,
        newCount: newQueries.length, newTop: newQueries.sort((a, z) => z.impressions - a.impressions).slice(0, 50),
        lostCount: lostQueries.length,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
