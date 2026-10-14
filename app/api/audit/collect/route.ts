// app/api/audit/collect/route.ts
// Audit step (server): issues visible in Search Console's own data for the chosen 7/15/30-day window,
// compared with the previous window of the same length, plus the Sitemaps report.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireAuditUser } from "@/lib/token";
import { assertSiteAccess, gscWindow, listSitemaps, searchAnalyticsAll, MAX_ROWS, type SARow, type SitemapInfo } from "@/lib/google";
import { parseDays } from "@/lib/dates";
import { brandFromSite } from "@/lib/url";
import { makeGroup, type Ev } from "@/lib/audit/rules";
import type { IssueGroup } from "@/lib/audit/catalog";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Thresholds grow with the window so a 30-day audit isn't flooded by tiny pages.
const LIMITS: Record<number, { minImpr: number; minClicks: number }> = {
  7: { minImpr: 20, minClicks: 5 },
  15: { minImpr: 40, minClicks: 10 },
  30: { minImpr: 80, minClicks: 20 },
};
const SA = "Google Search Console API (Search Analytics)";
const SM = "Google Search Console API (Sitemaps)";
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => r1(n * 100);
const median = (a: number[]) => {
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const by = (k: string) => (a: Ev, b: Ev) => Number(b[k] ?? 0) - Number(a[k] ?? 0);
const urlsOf = (e: Ev[]) => e.map((x) => String(x.url));

export async function POST(req: NextRequest) {
  try {
    await requireAuditUser(req);
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const siteUrl = String(body.siteUrl || "");
    await assertSiteAccess(token, siteUrl);
    const days = parseDays(String(body.days ?? ""));
    const L = LIMITS[days];
    const w = await gscWindow(token, siteUrl, days, "previous");

    const [cur, prev, qp, sitemaps] = await Promise.all([
      searchAnalyticsAll(token, siteUrl, { ...w.current, dimensions: ["page"] }),
      searchAnalyticsAll(token, siteUrl, { ...w.previous, dimensions: ["page"] }),
      searchAnalyticsAll(token, siteUrl, { ...w.current, dimensions: ["query", "page"] }, 25_000),
      listSitemaps(token, siteUrl).catch(() => null as SitemapInfo[] | null),
    ]);
    const issues: IssueGroup[] = [];
    const metrics = { window_days: days, current: `${w.current.startDate} to ${w.current.endDate}`, previous: `${w.previous.startDate} to ${w.previous.endDate}` };
    const curMap = new Map(cur.map((r) => [r.keys[0], r]));

    /* Pages: lost ≥50% of clicks / stopped showing / fell 5+ places */
    const drop: Ev[] = [];
    const lost: Ev[] = [];
    const fell: Ev[] = [];
    for (const p of prev) {
      const url = p.keys[0];
      const c = curMap.get(url);
      if (!c) {
        if (p.impressions >= L.minImpr) lost.push({ url, impressions_before: p.impressions, clicks_before: p.clicks, position_before: r1(p.position) });
        continue;
      }
      if (p.clicks >= L.minClicks && c.clicks <= p.clicks * 0.5) {
        drop.push({
          url, clicks_before: p.clicks, clicks_now: c.clicks, change_pct: pct((c.clicks - p.clicks) / p.clicks),
          position_before: r1(p.position), position_now: r1(c.position), impressions_before: p.impressions, impressions_now: c.impressions,
        });
      } else if (p.impressions >= L.minImpr && c.position - p.position >= 5) {
        fell.push({
          url, position_before: r1(p.position), position_now: r1(c.position),
          impressions_before: p.impressions, impressions_now: c.impressions, clicks_before: p.clicks, clicks_now: c.clicks,
        });
      }
    }
    drop.sort(by("clicks_before"));
    lost.sort(by("impressions_before"));
    fell.sort(by("impressions_before"));
    if (drop.length) issues.push(makeGroup("traffic_drop", urlsOf(drop), drop, SA, { ...metrics, min_clicks_before: L.minClicks }));
    // With 50,000+ pages, "not in the list" may only mean "below the cut-off", so it isn't reported.
    if (lost.length && cur.length < MAX_ROWS) issues.push(makeGroup("lost_visibility", urlsOf(lost), lost, SA, { ...metrics, min_impressions_before: L.minImpr }));
    if (fell.length) issues.push(makeGroup("position_drop", urlsOf(fell), fell, SA, { ...metrics, min_impressions_before: L.minImpr }));

    /* Low CTR vs the site's own median CTR at the same (rounded) position */
    const eligible = cur.filter((r) => r.impressions >= L.minImpr && r.position < 10.5);
    const buckets = new Map<number, number[]>();
    for (const r of eligible) {
      const b = Math.max(1, Math.round(r.position));
      const a = buckets.get(b);
      if (a) a.push(r.ctr);
      else buckets.set(b, [r.ctr]);
    }
    const low: Ev[] = [];
    for (const r of eligible) {
      const peers = buckets.get(Math.max(1, Math.round(r.position))) || [];
      if (peers.length < 5 || r.impressions < L.minImpr * 2) continue;
      const med = median(peers);
      if (med > 0 && r.ctr < med * 0.5) {
        low.push({ url: r.keys[0], position: r1(r.position), impressions: r.impressions, clicks: r.clicks, ctr_pct: pct(r.ctr), site_median_ctr_pct_at_this_position: pct(med), pages_in_benchmark: peers.length });
      }
    }
    low.sort(by("impressions"));
    if (low.length) issues.push(makeGroup("low_ctr", urlsOf(low), low, SA, metrics));

    /* Cannibalisation: non-branded queries where 2+ pages each get ≥15% of the query's impressions */
    const brand = brandFromSite(siteUrl);
    const byQuery = new Map<string, SARow[]>();
    for (const r of qp) {
      const q = r.keys[0];
      if (brand.length >= 3 && q.toLowerCase().replace(/\s+/g, "").includes(brand)) continue;
      const a = byQuery.get(q);
      if (a) a.push(r);
      else byQuery.set(q, [r]);
    }
    const cann: Ev[] = [];
    const cannUrls: string[] = [];
    for (const [q, rows] of byQuery) {
      const total = rows.reduce((s, r) => s + r.impressions, 0);
      if (total < L.minImpr * 2) continue;
      const comp = rows.filter((r) => r.impressions >= Math.max(10, total * 0.15)).sort((a, b) => b.impressions - a.impressions);
      if (comp.length < 2) continue;
      cann.push({
        query: q,
        total_impressions: total,
        pages: comp.slice(0, 4).map((r) => `${r.keys[1]} (${r.impressions} impressions, position ${r1(r.position)})`).join(" | "),
      });
      cannUrls.push(...comp.map((r) => r.keys[1]));
    }
    cann.sort(by("total_impressions"));
    if (cann.length) issues.push(makeGroup("cannibalization", cannUrls, cann.slice(0, 50), SA, { ...metrics, branded_queries_excluded: brand }, cann.length));

    /* Sitemaps report */
    if (sitemaps) {
      const ev = (s: SitemapInfo): Ev => ({
        url: s.path,
        errors: Number(s.errors || 0),
        warnings: Number(s.warnings || 0),
        last_downloaded: s.lastDownloaded ? s.lastDownloaded.slice(0, 10) : "never",
        last_submitted: s.lastSubmitted ? s.lastSubmitted.slice(0, 10) : null,
        pending: s.isPending ? "yes" : "no",
        submitted_urls: (s.contents || []).reduce((n, c) => n + Number(c.submitted || 0), 0),
      });
      if (!sitemaps.length) issues.push(makeGroup("no_sitemaps", [], [{ note: "Search Console lists no sitemaps for this property" }], SM, {}, 1));
      const errs = sitemaps.filter((s) => Number(s.errors) > 0);
      const warns = sitemaps.filter((s) => Number(s.warnings) > 0 && !(Number(s.errors) > 0));
      const stale = sitemaps.filter((s) => s.isPending || !s.lastDownloaded || Date.now() - Date.parse(s.lastDownloaded) > 30 * 864e5);
      if (errs.length) issues.push(makeGroup("sitemap_errors", errs.map((s) => s.path), errs.map(ev), SM));
      if (warns.length) issues.push(makeGroup("sitemap_warnings", warns.map((s) => s.path), warns.map(ev), SM));
      if (stale.length) issues.push(makeGroup("sitemap_stale", stale.map((s) => s.path), stale.map(ev), SM));
    }

    const byClicks = cur.slice().sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    return NextResponse.json({
      window: { days, current: w.current, previous: w.previous, dataThrough: w.dataThrough },
      issues,
      topPages: byClicks.slice(0, 500).map((r) => r.keys[0]),
      droppedPages: [...urlsOf(drop), ...urlsOf(lost), ...urlsOf(fell)].slice(0, 500),
      clicksByUrl: Object.fromEntries(byClicks.slice(0, 5000).map((r) => [r.keys[0], r.clicks])),
    });
  } catch (e) {
    return fail(e);
  }
}
