// components/IndexedRanking.tsx
"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isIndexedVerdict, type IndexCache, type InspectionRec } from "@/lib/indexCache";
import { normalizeUrl } from "@/lib/url";
import { BANDS, DEFAULT_INDEXED_PAGE_DAYS, INDEXED_PAGE_DAYS, daysLabel, type IndexedPage, type IndexedPagesResponse } from "@/lib/indexedPages";
import { Bars, DataTable, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, num, pct, pos, useSources, type Col, type KpiItem } from "./ui";

type Row = IndexedPage & { recentLabel: string; inSitemap: string; inspection: string };
type View = "all" | (typeof BANDS)[number] | "stale" | "noclicks" | "flagged";
type Counts = { indexed: string; notIndexed: string; asOf: string };

const EMPTY: Counts = { indexed: "", notIndexed: "", asOf: "" };
const countsKey = (site: string) => `dash:gscPageIndexing:${site}`;

function readCounts(site: string): Counts {
  try {
    const v = JSON.parse(localStorage.getItem(countsKey(site)) || "null");
    if (v && typeof v === "object") return { indexed: String(v.indexed ?? ""), notIndexed: String(v.notIndexed ?? ""), asOf: String(v.asOf ?? "") };
  } catch {}
  return EMPTY;
}

function writeCounts(site: string, c: Counts) {
  try {
    localStorage.setItem(countsKey(site), JSON.stringify(c));
  } catch {}
}

/** "10,955", "10955" or "11k" → number. */
function parseCount(v: string): number | null {
  const s = v.trim().toLowerCase().replace(/[,\s]/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(k)?$/);
  return m ? Math.round(Number(m[1]) * (m[2] ? 1000 : 1)) : null;
}

export default function IndexedRanking({ site, cache }: { site: string; cache: IndexCache | null }) {
  const outer = useSources();
  const [days, setDays] = useState<number>(DEFAULT_INDEXED_PAGE_DAYS);
  const [data, setData] = useState<IndexedPagesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("all");
  const [counts, setCounts] = useState<Counts>(EMPTY);
  const req = useRef(0);

  useEffect(() => {
    req.current++;
    setData(null);
    setError(null);
    setLoading(false);
    setView("all");
    setCounts(readCounts(site));
  }, [site]);

  const load = async (d: number) => {
    const id = ++req.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/gsc/indexed-pages?site=${encodeURIComponent(site)}&days=${d}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
      if (id === req.current) {
        setData(j as IndexedPagesResponse);
        setView("all");
      }
    } catch (e) {
      if (id === req.current) setError(e instanceof Error ? e.message : "Could not load pages");
    }
    if (id === req.current) setLoading(false);
  };

  const changeDays = (d: number) => {
    setDays(d);
    if (data || error) load(d);
  };

  const updateCounts = (patch: Partial<Counts>) => {
    const next = { ...counts, ...patch };
    setCounts(next);
    writeCounts(site, next);
  };

  const merged = useMemo(() => ({ ...outer, ...(data?.sources || {}) }), [outer, data]);

  // Sitemap membership and saved URL Inspection results from the section above
  const local = useMemo(() => {
    const sitemap = new Set<string>();
    const inspected = new Map<string, InspectionRec>();
    for (const u of cache?.urls || []) if (u.sources.includes("sitemap")) sitemap.add(normalizeUrl(u.url));
    for (const [u, r] of Object.entries(cache?.inspected || {})) inspected.set(normalizeUrl(u), r);
    return { sitemap, inspected, listed: !!cache?.urls.length };
  }, [cache]);

  const rows = useMemo<Row[]>(
    () =>
      (data?.pages || []).map((p) => {
        const k = normalizeUrl(p.url);
        const r = local.inspected.get(k);
        const inspection =
          !r || !r.verdict || r.verdict === "ERROR" ? "Not inspected" : isIndexedVerdict(r.verdict) ? "Indexed" : `Not indexed: ${r.coverageState}`;
        return {
          ...p,
          recentLabel: p.recent == null ? "—" : p.recent ? "Yes" : "No",
          inSitemap: local.listed ? (local.sitemap.has(k) ? "Yes" : "No") : "—",
          inspection,
        };
      }),
    [data, local]
  );

  const stats = useMemo(() => {
    const band = new Map<string, number>(BANDS.map((b) => [b, 0]));
    let recent = 0;
    let clicked = 0;
    let flagged = 0;
    for (const r of rows) {
      band.set(r.band, (band.get(r.band) || 0) + 1);
      if (r.recent) recent++;
      if (r.clicks > 0) clicked++;
      if (r.inspection.startsWith("Not indexed")) flagged++;
    }
    return { band, recent, clicked, flagged, pageOne: (band.get("1–3") || 0) + (band.get("4–10") || 0) };
  }, [rows]);

  const viewRows = useMemo(() => {
    if (view === "all") return rows;
    if (view === "stale") return rows.filter((r) => r.recent === false);
    if (view === "noclicks") return rows.filter((r) => r.clicks === 0);
    if (view === "flagged") return rows.filter((r) => r.inspection.startsWith("Not indexed"));
    return rows.filter((r) => r.band === view);
  }, [rows, view]);

  const gscIndexed = parseCount(counts.indexed);
  const gscNot = parseCount(counts.notIndexed);
  const period = data ? `last ${daysLabel(data.days)}` : "";
  const ranking = rows.length;
  const diff = gscIndexed != null ? ranking - gscIndexed : 0;
  const stale = data?.recentRange ? ranking - stats.recent : null;

  let compare: ReactNode = null;
  if (data && gscIndexed != null && gscIndexed > 0) {
    compare =
      diff > 0
        ? `Search Console reports ${num(gscIndexed)} indexed pages${counts.asOf ? ` (as of ${counts.asOf})` : ""}, but ${num(ranking)} pages had impressions in the ${period}: ${num(diff)} more. ` +
          "That's normal for longer periods. Pages that ranked earlier and have since been dropped, redirected or removed still count here, while the Page indexing report is a snapshot of today." +
          (stale != null ? ` ${num(stale)} of these pages have had no impressions in the last 7 days.` : "") +
          (data.days > 7 ? ' Choose "Last 7 days" for a figure closer to today.' : "")
        : `Search Console reports ${num(gscIndexed)} indexed pages${counts.asOf ? ` (as of ${counts.asOf})` : ""}; ${num(ranking)} pages (${pct(ranking / gscIndexed, 0)}) had impressions in the ${period}. ` +
          `About ${num(-diff)} indexed pages didn't appear in search results in this period, so they aren't in this list. ` +
          'To find them, inspect URLs in the section above, or export "View data about indexed pages" in Search Console (up to 1,000 examples).';
  }

  const kpis: KpiItem[] = [
    {
      label: "Indexed (Search Console)",
      value: gscIndexed != null ? num(gscIndexed) : "—",
      sub: gscIndexed != null ? `Page indexing report${counts.asOf ? `, as of ${counts.asOf}` : ""}` : "enter it above (no API)",
    },
  ];
  if (gscNot != null) kpis.push({ label: "Not indexed (Search Console)", value: num(gscNot), sub: "Page indexing report" });
  kpis.push({ label: "Pages with impressions", value: num(ranking), sub: `${period}, Web search`, source: ["indexedPages.count"] });
  if (gscIndexed != null) {
    kpis.push(
      diff > 0
        ? { label: "More than indexed now", value: num(diff), sub: "ranked earlier, may have dropped since" }
        : { label: "Indexed, no impressions", value: num(-diff), sub: "approx.: indexed minus ranking" }
    );
  }
  if (data?.recentRange) {
    kpis.push({ label: "Shown in last 7 days", value: num(stats.recent), sub: `${data.recentRange.startDate} to ${data.recentRange.endDate}`, source: ["indexedPages.recentCount"] });
  }
  kpis.push({ label: "Average position 1–10", value: num(stats.pageOne), sub: "roughly page one", source: ["indexedPages.bands"] });
  kpis.push({ label: "Pages with clicks", value: num(stats.clicked), source: ["indexedPages.pages"] });

  const cols: Col<Row>[] = [
    { key: "url", label: "URL", url: true },
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr) },
    { key: "position", label: "Avg position", num: true, render: (r) => pos(r.position) },
    { key: "band", label: "Band" },
    { key: "topQuery", label: "Top query", render: (r) => r.topQuery || <span className="muted">—</span> },
  ];
  if (data?.recentRange) cols.push({ key: "recentLabel", label: "Last 7 days" });
  cols.push(
    { key: "inSitemap", label: "In sitemap" },
    {
      key: "inspection",
      label: "URL Inspection",
      render: (r) =>
        r.inspection === "Not inspected" ? (
          <span className="muted">Not inspected</span>
        ) : (
          <span className={`pill ${r.inspection === "Indexed" ? "ok" : "no"}`}>{r.inspection}</span>
        ),
    }
  );

  const options: { id: View; label: string }[] = [
    { id: "all", label: `All (${num(ranking)})` },
    ...BANDS.map((b) => ({ id: b as View, label: `Position ${b} (${num(stats.band.get(b) || 0)})` })),
  ];
  if (stale != null) options.push({ id: "stale", label: `Not shown in last 7 days (${num(stale)})` });
  options.push({ id: "noclicks", label: `No clicks (${num(ranking - stats.clicked)})` });
  if (stats.flagged) options.push({ id: "flagged", label: `Not indexed per URL Inspection (${num(stats.flagged)})` });

  return (
    <SourcesProvider value={merged}>
      <Section
        title="Indexed and ranking pages"
        source={data ? ["indexedPages.count"] : undefined}
        lede="Every page that appeared in Google Search results in the chosen period, with clicks, impressions, average position and top query. Loaded all at once from Search Console's performance data; no URL Inspection quota is used."
      >
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>How this data is collected, and why this way</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            <li>
              <strong>Google has no API for the Page indexing report.</strong> The indexed and not-indexed totals under Indexing → Pages in
              Search Console can't be read by this dashboard or any other app. Enter them below to compare.
            </li>
            <li>
              <strong>The only page-level index check, the URL Inspection API, allows 2,000 URLs per property per day.</strong> On a large site,
              checking every known page takes weeks. The section above uses it for confirmed statuses.
            </li>
            <li>
              <strong>So this list uses Search Console's performance data</strong>, the same data as Performance → Search results → Pages, search
              type Web. Google can only show a page in results while it is indexed, so every URL here was indexed when it got impressions. All
              pages load in one request, up to 50,000.
            </li>
            <li>
              <strong>Why it won't exactly match the Page indexing report:</strong> indexed pages with no impressions in the period aren't listed;
              over longer periods, pages that have since dropped out still count; impressions are credited to the canonical URL Google chose; and
              the Page indexing report is a snapshot that updates every few days.
            </li>
            <li>
              <strong>Average position</strong> is averaged over every query the page appeared for, weighted by impressions. A page averaging 15
              can still be in the top 3 for some queries.
            </li>
          </ul>
        </div>

        <div className="panel">
          <PanelTitle>Search Console's Page indexing numbers</PanelTitle>
          <p className="muted" style={{ marginTop: 0 }}>
            Copy these from Search Console → Indexing → Pages. Hover over the latest bar in the chart for exact figures (rounded values like
            “11k” also work). Saved in this browser for this property.
          </p>
          <div className="row">
            <label className="control">
              Indexed
              <input inputMode="numeric" placeholder="e.g. 10,955" value={counts.indexed} onChange={(e) => updateCounts({ indexed: e.target.value })} />
            </label>
            <label className="control">
              Not indexed
              <input inputMode="numeric" placeholder="e.g. 29,581" value={counts.notIndexed} onChange={(e) => updateCounts({ notIndexed: e.target.value })} />
            </label>
            <label className="control">
              As of
              <input type="date" value={counts.asOf} onChange={(e) => updateCounts({ asOf: e.target.value })} />
            </label>
          </div>
          {((counts.indexed && gscIndexed == null) || (counts.notIndexed && gscNot == null)) && (
            <p className="notice error" style={{ marginBottom: 0 }}>Enter numbers only, for example 10,955 or 11k.</p>
          )}
        </div>

        <div className="panel" style={{ marginTop: 16 }}>
          <div className="row">
            <button className="btn primary" onClick={() => load(days)} disabled={loading}>
              {loading ? "Loading pages…" : data ? "Reload" : "Load indexed & ranking pages"}
            </button>
            <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              Period
              <select value={days} onChange={(e) => changeDays(Number(e.target.value))} disabled={loading}>
                {INDEXED_PAGE_DAYS.map((d) => (
                  <option key={d} value={d}>Last {daysLabel(d)}</option>
                ))}
              </select>
            </label>
          </div>
          {loading && <p className="muted" style={{ marginBottom: 0 }}>Fetching every page with impressions from Search Console. Large sites can take up to a minute.</p>}
          {error && <p className="notice error" style={{ marginBottom: 0 }}>{error}</p>}
          {data && !loading && (
            <p className="muted" style={{ marginBottom: 0 }}>
              {data.range.startDate} to {data.range.endDate} · Search Console data complete through {data.dataThrough} · search type Web.
            </p>
          )}
        </div>

        {data && (
          <>
            <div style={{ marginTop: 16 }}>
              <Kpis items={kpis} />
            </div>

            {compare && <p className="notice" style={{ marginTop: 16 }}>{compare}</p>}
            {data.capped && (
              <p className="notice error" style={{ marginTop: 16 }}>
                The API's limit of 50,000 pages was reached, so the least-seen pages are missing. Choose a shorter period for a complete list.
              </p>
            )}

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={["indexedPages.bands"]}>Pages by average position</PanelTitle>
              <Bars items={BANDS.map((b) => ({ label: `Position ${b}`, value: stats.band.get(b) || 0 }))} />
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <SubTabs value={view} onChange={setView} options={options} />
              <DataTable
                key={view}
                rows={viewRows}
                cols={cols}
                initialSort="impressions"
                pageSize={50}
                csvName={`indexed-ranking-pages-${data.range.startDate}-to-${data.range.endDate}.csv`}
                csvRow={(r) => ({
                  url: r.url,
                  clicks: r.clicks,
                  impressions: r.impressions,
                  ctr_percent: Number((r.ctr * 100).toFixed(2)),
                  avg_position: r.position,
                  position_band: r.band,
                  top_query: r.topQuery,
                  top_query_clicks: r.topQueryClicks,
                  shown_last_7_days: r.recentLabel,
                  in_sitemap: r.inSitemap,
                  url_inspection: r.inspection,
                })}
                source={["indexedPages.pages", "indexedPages.topQuery"]}
                empty="No pages in this group."
              />
              <p className="muted" style={{ marginBottom: 0 }}>
                Top query found for {num(data.topQueryCovered)} of {num(ranking)} pages. Google hides rare queries for privacy
                {data.topQueryCapped ? ", and the API returns at most 50,000 page-and-query pairs" : ""}, so low-traffic pages may show “—”.
                {!local.listed && " Load the URL list in the section above to fill the In sitemap and URL Inspection columns."}
              </p>
            </div>
          </>
        )}
      </Section>
    </SourcesProvider>
  );
}
