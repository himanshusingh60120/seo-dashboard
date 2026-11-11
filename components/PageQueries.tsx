// components/PageQueries.tsx
"use client";
// Side panel opened from the Rankings tab: every query one page ranked for, matched against the comparison period.
import { useEffect, useMemo, useRef, useState } from "react";
import type { GscData } from "@/lib/types";
import type { PageQueriesResponse, PageQueryRow } from "@/app/api/gsc/page-queries/route";
import { gscPerformanceUrl } from "@/lib/provenance";
import { DataTable, Delta, Kpis, SourcesProvider, SubTabs, num, pct, pos, useSources, type Col, type KpiItem } from "./ui";

type View = "now" | "new" | "lost";
export type PageAi = { impressions: number; from: string; to: string } | null;

function Change({ r }: { r: PageQueryRow }) {
  if (r.change == null) return <span className="muted">{r.status === "new" ? "new" : r.status === "lost" ? "lost" : "–"}</span>;
  const v = r.change;
  const cls = v > 0.05 ? "bad" : v < -0.05 ? "good" : "flat";
  return <span className={`delta ${cls}`}>{v > 0 ? `▼ ${v.toFixed(1)}` : v < 0 ? `▲ ${Math.abs(v).toFixed(1)}` : "0.0"}</span>;
}

const NOW_COLS: Col<PageQueryRow>[] = [
  { key: "query", label: "Query" },
  { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
  { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
  { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
  { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
  { key: "prevPosition", label: "Previous", num: true, render: (r) => pos(r.prevPosition) },
  { key: "change", label: "Change", num: true, render: (r) => <Change r={r} /> },
];

const LOST_COLS: Col<PageQueryRow>[] = [
  { key: "query", label: "Query" },
  { key: "prevClicks", label: "Clicks before", num: true, render: (r) => num(r.prevClicks) },
  { key: "prevImpressions", label: "Impressions before", num: true, render: (r) => num(r.prevImpressions) },
  { key: "prevPosition", label: "Position before", num: true, render: (r) => pos(r.prevPosition) },
];

const EMPTY: Record<View, string> = {
  now: "This page had no listed queries in this period.",
  new: "No new queries for this page.",
  lost: "No queries were lost.",
};

export default function PageQueries({
  site, page, gsc, ai, onClose,
}: { site: string; page: string; gsc: GscData; ai: PageAi; onClose: () => void }) {
  const outer = useSources();
  const [data, setData] = useState<PageQueriesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("now");
  const closeRef = useRef<HTMLButtonElement>(null);
  const type = gsc.searchType || "web";

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setView("now");
    const q = new URLSearchParams({
      site, page, type,
      start: gsc.range.startDate, end: gsc.range.endDate,
      pstart: gsc.previousRange.startDate, pend: gsc.previousRange.endDate,
    });
    fetch(`/api/gsc/page-queries?${q}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        return j as PageQueriesResponse;
      })
      .then((j) => live && setData(j))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the queries"));
    return () => {
      live = false;
    };
  }, [site, page, type, gsc.range.startDate, gsc.range.endDate, gsc.previousRange.startDate, gsc.previousRange.endDate]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(
    () => (data ? data.rows.filter((r) => (view === "now" ? r.status !== "lost" : r.status === view)) : []),
    [data, view]
  );
  const merged = useMemo(() => ({ ...outer, ...(data?.sources || {}) }), [outer, data]);

  let kpis: KpiItem[] = [];
  if (data) {
    const c = data.totals.current, p = data.totals.previous;
    const S = ["pq.totals.current", "pq.totals.previous"];
    kpis = [
      { label: "Clicks", source: S, value: num(c.clicks), delta: <Delta cur={c.clicks} prev={p.clicks} /> },
      { label: "Impressions", source: S, value: num(c.impressions), delta: <Delta cur={c.impressions} prev={p.impressions} /> },
      { label: "CTR", source: S, value: pct(c.ctr, 2), delta: <Delta cur={c.ctr * 100} prev={p.ctr * 100} asPoints /> },
      {
        label: "Avg. position", source: S,
        value: c.impressions ? pos(c.position) : "–",
        delta: c.impressions && p.impressions ? <Delta cur={c.position} prev={p.position} invert asPoints /> : undefined,
      },
      { label: "Queries", source: ["pq.status"], value: num(data.counts.now), sub: `${num(data.counts.new)} new · ${num(data.counts.lost)} lost` },
    ];
    if (ai) {
      kpis.push({ label: "AI impressions", value: num(ai.impressions), sub: `AI Overviews & AI Mode, ${ai.from} to ${ai.to} (imported report)` });
    }
  }

  return (
    <div className="src-overlay" onClick={onClose}>
      <div className="src-dialog pq-dialog" role="dialog" aria-modal="true" aria-label={`Queries for ${page}`} onClick={(e) => e.stopPropagation()}>
        <SourcesProvider value={merged}>
          <div className="src-head">
            <div style={{ minWidth: 0 }}>
              <div className="muted">Queries this page ranked for</div>
              <h3 style={{ overflowWrap: "anywhere" }}>
                <a href={page} target="_blank" rel="noreferrer">{page}</a>
              </h3>
              <div className="muted">
                {gsc.range.startDate} to {gsc.range.endDate} vs {gsc.previousRange.startDate} to {gsc.previousRange.endDate} · search type {type}
              </div>
            </div>
            <button ref={closeRef} className="btn" onClick={onClose}>Close</button>
          </div>

          {error && <div className="notice error">{error}</div>}
          {!data && !error && <p className="muted">Loading queries from Search Console…</p>}

          {data && (
            <>
              <Kpis items={kpis} />
              <p className="muted">
                The listed queries account for {num(data.queryClicks)} of this page&apos;s {num(data.totals.current.clicks)} clicks. Google hides rare
                queries for privacy, so the list never adds up to the page total.
                {data.capped && " The API's 25,000-query limit was reached, so the least-searched queries are left out."}
              </p>
              <SubTabs
                value={view}
                onChange={setView}
                options={[
                  { id: "now", label: `Queries now (${num(data.counts.now)})` },
                  { id: "new", label: `New (${num(data.counts.new)})` },
                  { id: "lost", label: `Lost (${num(data.counts.lost)})` },
                ]}
              />
              <DataTable
                key={view}
                rows={rows}
                cols={view === "lost" ? LOST_COLS : NOW_COLS}
                initialSort={view === "lost" ? "prevClicks" : "clicks"}
                csvName={`page-queries-${view}.csv`}
                source={["pq.queries.current", "pq.queries.previous", "pq.status"]}
                empty={EMPTY[view]}
              />
              <p className="muted" style={{ marginBottom: 0 }}>
                To check this list in Google&apos;s own interface,{" "}
                <a href={gscPerformanceUrl(site, gsc.range, "query")} target="_blank" rel="noreferrer">open Performance in Search Console</a>, then
                add a Page filter (Exact URL) for this page.
              </p>
            </>
          )}
        </SourcesProvider>
      </div>
    </div>
  );
}
