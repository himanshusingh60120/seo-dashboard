// app/api/gsc/page-queries/route.ts
// Every query one page ranked for, this period and the comparison period, matched query by query.
// Used by the Rankings tab when a page is clicked. Same Search Analytics data as the Performance report
// with a Page filter, so no URL Inspection quota is used.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError } from "@/lib/token";
import {
  assertSiteAccess, saEndpoint, saRequest, searchAnalytics, searchAnalyticsAll,
  type SABody, type SARow, type SearchType,
} from "@/lib/google";
import { GSC_EXPLORER, Recorder, gscPerformanceUrl, type Sources } from "@/lib/provenance";
import { urlInProperty } from "@/lib/url";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_LABEL: Record<string, string> = { web: "Web", image: "Image", video: "Video", news: "News" };
const MAX_QUERIES = 25_000;
const MAX_NOW = 4_000;
const MAX_LOST = 1_000;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

type Range = { startDate: string; endDate: string };
export type PageTotals = { clicks: number; impressions: number; ctr: number; position: number };
export type PageQueryRow = {
  query: string;
  status: "both" | "new" | "lost";
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  prevClicks: number;
  prevImpressions: number;
  prevPosition: number | null;
  /** Position now minus position before: negative is an improvement. */
  change: number | null;
};
export type PageQueriesResponse = {
  sources: Sources;
  page: string;
  searchType: string;
  range: Range;
  previousRange: Range;
  totals: { current: PageTotals; previous: PageTotals };
  rows: PageQueryRow[];
  counts: { now: number; new: number; lost: number };
  queryClicks: number;
  capped: boolean;
};

function rangeOf(p: URLSearchParams, a: string, b: string): Range {
  const startDate = p.get(a) || "";
  const endDate = p.get(b) || "";
  if (!DATE.test(startDate) || !DATE.test(endDate) || startDate > endDate) throw new HttpError(400, "Invalid date range");
  return { startDate, endDate };
}

const totalsOf = (rows: SARow[]): PageTotals =>
  rows[0]
    ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: rows[0].ctr, position: rows[0].position }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const token = await getGoogleAccessToken(req);
    const siteUrl = p.get("site") || "";
    await assertSiteAccess(token, siteUrl);
    const page = (p.get("page") || "").trim();
    if (!urlInProperty(siteUrl, page)) throw new HttpError(400, "That page isn't part of this Search Console property.");
    const current = rangeOf(p, "start", "end");
    const previous = rangeOf(p, "pstart", "pend");
    const type = (TYPE_LABEL[p.get("type") || ""] ? p.get("type") : "web") as SearchType;
    const base = { type, dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: page }] }] };

    const rec = new Recorder();
    const system = `Google Search Console API (Search Analytics, ${TYPE_LABEL[type]})`;
    const how = (r: Range) =>
      `Search Console → Performance → Search results. Set Search type to ${TYPE_LABEL[type]} and the date range to ${r.startDate} – ${r.endDate} (custom). ` +
      `Add a filter: Page → Exact URL → ${page}. Then open the Queries tab.`;
    const meta = (id: string, label: string, r: Range, request: unknown) => ({
      id, label, system, endpoint: saEndpoint(siteUrl), request, range: r,
      verifyUrl: gscPerformanceUrl(siteUrl, r, "query"),
      verifyLabel: "Open Performance in Search Console",
      verifyHow: how(r),
      explorerUrl: GSC_EXPLORER,
      explorerLabel: "Rerun this request in Google's API Explorer",
    });

    const totals = (id: string, r: Range) => {
      const body: SABody = { ...r, ...base };
      return rec.call(meta(id, `Page totals, ${r.startDate} – ${r.endDate}`, r, saRequest(body)), () => searchAnalytics(token, siteUrl, body), (rows) => rows);
    };
    const queries = (id: string, r: Range) => {
      const body: SABody = { ...r, ...base, dimensions: ["query"] };
      return rec.call(
        meta(id, `Queries for this page, ${r.startDate} – ${r.endDate}`, r, {
          ...saRequest({ ...body, rowLimit: 25000, startRow: 0 }),
          _note: "Repeated with startRow 25000 until fewer rows come back.",
        }),
        () => searchAnalyticsAll(token, siteUrl, body, MAX_QUERIES),
        (rows) => rows
      );
    };

    const [tc, tp, qc, qp] = await Promise.all([
      totals("pq.totals.current", current),
      totals("pq.totals.previous", previous),
      queries("pq.queries.current", current),
      queries("pq.queries.previous", previous),
    ]);

    const before = new Map(qp.map((r) => [r.keys[0], r]));
    const seen = new Set<string>();
    const now: PageQueryRow[] = qc.map((r) => {
      const q = r.keys[0];
      seen.add(q);
      const b = before.get(q);
      return {
        query: q,
        status: b ? "both" : "new",
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: round(r.position),
        prevClicks: b?.clicks ?? 0,
        prevImpressions: b?.impressions ?? 0,
        prevPosition: b ? round(b.position) : null,
        change: b ? round(r.position - b.position) : null,
      };
    });
    const lost: PageQueryRow[] = qp
      .filter((b) => !seen.has(b.keys[0]))
      .map((b) => ({
        query: b.keys[0], status: "lost", clicks: 0, impressions: 0, ctr: 0, position: null,
        prevClicks: b.clicks, prevImpressions: b.impressions, prevPosition: round(b.position), change: null,
      }));
    now.sort((a, z) => z.clicks - a.clicks || z.impressions - a.impressions);
    lost.sort((a, z) => z.prevClicks - a.prevClicks || z.prevImpressions - a.prevImpressions);

    rec.computed(
      "pq.status",
      "New, lost and moving queries",
      "Queries are matched by their exact text across the two periods. New = in this period's list only. Lost = in the previous period's list only. " +
        "Change = average position now minus before; negative is an improvement. Google hides rare queries for privacy, so the listed queries don't add up to the page totals.",
      ["pq.queries.current", "pq.queries.previous"]
    );

    const body: PageQueriesResponse = {
      sources: rec.sources,
      page,
      searchType: type,
      range: current,
      previousRange: previous,
      totals: { current: totalsOf(tc), previous: totalsOf(tp) },
      rows: [...now.slice(0, MAX_NOW), ...lost.slice(0, MAX_LOST)],
      counts: { now: now.length, new: now.filter((r) => r.status === "new").length, lost: lost.length },
      queryClicks: now.reduce((s, r) => s + r.clicks, 0),
      capped: qc.length >= MAX_QUERIES || qp.length >= MAX_QUERIES,
    };
    return NextResponse.json(body);
  } catch (e) {
    return fail(e);
  }
}
