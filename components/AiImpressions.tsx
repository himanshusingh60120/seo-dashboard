// components/AiImpressions.tsx
"use client";
// Overview section: Google AI Overviews + AI Mode impressions for the whole site, from Search Console's Generative AI
// features report (no API). The team's Chrome extension copies the report once a week into the Google Sheet; this
// screen only shows the data and who updated it. Nothing can be changed or deleted here.
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GscData, Source, Sources } from "@/lib/types";
import { useAiStore } from "@/lib/aiImpressions";
import { AI_MAX_PAGES, aiSum, latestAiSnapshot } from "@/lib/aiStore";
import { addDays } from "@/lib/dates";
import UpdatedBy, { BOOKMARKS_RETIRED, viaOf, type UpdateEntry } from "./UpdatedBy";
import { Bars, DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, num, pct, useSources, type Col, type KpiItem } from "./ui";

const axis = { fontSize: 12, fill: "#5b6573" };
const DAY = 864e5;

type PageAiRow = { url: string; impressions: number; share: number };

const PAGE_COLS: Col<PageAiRow>[] = [
  { key: "url", label: "Page", url: true },
  { key: "impressions", label: "AI impressions", num: true, render: (r) => num(r.impressions) },
  { key: "share", label: "Share of listed", num: true, render: (r) => pct(r.share) },
];

const top = (m: Record<string, number> | undefined, n: number) =>
  Object.entries(m || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, value]) => ({ label, value }));

/* ---------- Date range for the AI section ---------- */

type AiRange = "period" | "3m" | "all";
const RANGE_KEY = "dash:ai:range";

/** "2026-11-10" → "10 Nov 2026" */
const fmtDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const fmtRange = (from: string, to: string) => `${fmtDate(from)} – ${fmtDate(to)}`;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/** Start of Search Console's "3 months" ending on `end`: the day after the same date 3 months earlier (10 Nov → 11 Aug). */
function threeMonthsStart(end: string) {
  const d = new Date(`${end}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 3);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return addDays(d.toISOString().slice(0, 10), 1);
}

export default function AiOverview({
  site,
  gsc,
  inbox = null,
  onInboxHandled,
}: {
  site: string;
  gsc: GscData;
  /** Data from an old bookmark. Bookmarks are retired, so it's only acknowledged (kept so existing callers compile). */
  inbox?: string | null;
  waiting?: boolean;
  onInboxHandled?: () => void;
}) {
  const outer = useSources();
  const state = useAiStore(site);
  const [range, setRange] = useState<AiRange>("period");
  const [retired, setRetired] = useState(false);

  const store = state?.store ?? null;
  const snap = latestAiSnapshot(store);
  const saved = useMemo(() => (store ? Object.keys(store.days).sort() : []), [store]);
  const last = store?.imports.length ? store.imports[store.imports.length - 1] : null;
  const web = (gsc.searchType || "web") === "web";
  const reportUrl = `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(site)}`;
  const periodDays = daysBetween(gsc.range.startDate, gsc.range.endDate);

  // Old bookmark clicks: nothing is saved any more; say so and clear it.
  useEffect(() => {
    if (!inbox) return;
    setRetired(true);
    onInboxHandled?.();
  }, [inbox, onInboxHandled]);

  // Remember the chosen range in this browser.
  useEffect(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      if (v === "period" || v === "3m" || v === "all") setRange(v);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  const pickRange = (r: AiRange) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* ignore */
    }
  };

  /** The dates the cards and chart cover, plus the same-length window before them for the change figure. */
  const win = useMemo(() => {
    const end = gsc.range.endDate;
    if (range === "3m") {
      const from = threeMonthsStart(end);
      const n = daysBetween(from, end);
      return { from, to: end, prevFrom: addDays(from, -n) as string | null, prevTo: addDays(from, -1) as string | null };
    }
    if (range === "all" && saved.length) {
      return { from: saved[0], to: saved[saved.length - 1], prevFrom: null, prevTo: null };
    }
    return { from: gsc.range.startDate, to: end, prevFrom: gsc.previousRange.startDate, prevTo: gsc.previousRange.endDate };
  }, [range, saved, gsc.range.startDate, gsc.range.endDate, gsc.previousRange.startDate, gsc.previousRange.endDate]);

  const cur = aiSum(store, win.from, win.to);
  const prev = win.prevFrom && win.prevTo ? aiSum(store, win.prevFrom, win.prevTo) : null;

  const searchByDay = useMemo(() => new Map(gsc.trend.map((t) => [t.date, t.impressions])), [gsc.trend]);

  /** All Search impressions for exactly the same days; 0 when the dashboard hasn't loaded every one of those days. */
  const searchImpr = useMemo(() => {
    if (range === "period") return gsc.totals.current.impressions;
    let total = 0;
    for (let d = win.from, i = 0; d <= win.to && i < 1100; d = addDays(d, 1), i++) {
      const s = searchByDay.get(d);
      if (s == null) return 0;
      total += s;
    }
    return total;
  }, [range, win.from, win.to, searchByDay, gsc.totals.current.impressions]);

  const trend = useMemo(() => {
    const out: { date: string; ai: number | null; share: number | null }[] = [];
    for (let d = win.from, i = 0; d <= win.to && i < 1100; d = addDays(d, 1), i++) {
      const v = store?.days[d];
      const s = searchByDay.get(d);
      out.push({
        date: d,
        ai: v ?? null,
        share: v != null && s ? +((v / s) * 100).toFixed(2) : null,
      });
    }
    return out;
  }, [win.from, win.to, store, searchByDay]);

  const pageRows = useMemo<PageAiRow[]>(() => {
    if (!snap) return [];
    const tot = Object.values(snap.pages).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(snap.pages).map(([url, impressions]) => ({ url, impressions, share: impressions / tot }));
  }, [snap]);

  const updates = useMemo<UpdateEntry[]>(
    () =>
      (store?.imports || []).map((i) => ({
        at: i.at,
        by: i.by,
        via: viaOf(i.file),
        note: i.from && i.to ? `${i.from} to ${i.to}${i.pages ? ` · ${num(i.pages)} pages` : ""}` : "",
      })),
    [store]
  );

  const sources = useMemo<Sources>(() => {
    if (!saved.length) return outer;
    const imported = {
      id: "client.aiImport",
      label: "Google AI impressions (Generative AI features report)",
      system: `Search Console Generative AI performance report (Beta), copied from the report page by the team's Chrome extension and saved ${state?.shared ? "in the shared Google Sheet" : "in this browser"}`,
      range: { startDate: saved[0], endDate: saved[saved.length - 1] },
      fetchedAt: last?.at || new Date().toISOString(),
      rowCount: saved.length,
      formula:
        "Daily impressions come from the report's chart and are merged by date across updates; a newer update replaces the same dates. " +
        "Each update is saved only when the days add up to the report's Total impressions. " +
        "Page, country and device totals come from the most recent update and cover only its dates, because the report doesn't split them by day. " +
        "Search Console lists at most 1,000 pages, so a page count of 1,000 means at least 1,000.",
      verifyUrl: reportUrl,
      verifyLabel: "Open Performance in Search Console",
      verifyHow:
        "Search Console → Performance → Open report (Generative AI features). Set the same dates as the card (\"Last 3 months\" here matches Search Console's 3 months); the totals and the daily chart should match.",
    } as Source;
    const share = {
      id: "calc.aiShare",
      label: "AI share of Search impressions",
      system: "Calculated in the dashboard",
      fetchedAt: new Date().toISOString(),
      formula:
        "AI impressions ÷ Search Console impressions (Web search type) for exactly the same days. Google counts AI Overview and AI Mode impressions inside the " +
        "normal Search totals too, so this is the part of the site's search impressions that came from links in AI answers. " +
        "Shown only when Search totals are loaded for every day in the range.",
      derivedFrom: ["client.aiImport", "gsc.trend"],
    } as Source;
    return { ...outer, [imported.id]: imported, [share.id]: share };
  }, [outer, saved, last, state?.shared, reportUrl]);

  const winText = fmtRange(win.from, win.to);
  const pageCount = snap ? Object.keys(snap.pages).length : 0;
  const pagesCapped = pageCount >= AI_MAX_PAGES;

  const kpis: KpiItem[] = saved.length
    ? [
        {
          label: "AI impressions",
          source: ["client.aiImport"],
          value: cur.covered ? num(cur.total) : "–",
          delta: prev && cur.complete && prev.complete ? <Delta cur={cur.total} prev={prev.total} /> : undefined,
          sub: cur.complete ? `${winText} · ${cur.expected} days` : `${winText} · only ${cur.covered} of ${cur.expected} days saved`,
        },
        {
          label: "Share of Search impressions",
          source: ["calc.aiShare"],
          value: web && cur.complete && searchImpr ? pct(cur.total / searchImpr) : "–",
          sub: !web
            ? "only for the Web search type"
            : searchImpr
              ? `${winText} · AI ÷ all Search impressions`
              : "Search totals aren't loaded for these dates. Choose “Dashboard period” to see it",
        },
        {
          label: "Pages linked by AI",
          source: ["client.aiImport"],
          value: snap ? (pagesCapped ? `${num(AI_MAX_PAGES)}+` : num(pageCount)) : "–",
          sub: snap ? `${fmtRange(snap.from, snap.to)} · latest capture${pagesCapped ? " · Search Console lists 1,000 max" : ""}` : "no page list saved yet",
        },
        {
          label: "Days saved",
          source: ["client.aiImport"],
          value: num(saved.length),
          sub: `${fmtRange(saved[0], saved[saved.length - 1])} · all history`,
        },
      ]
    : [];

  const RANGES: { id: AiRange; label: string }[] = [
    { id: "period", label: `Dashboard period (${periodDays} days)` },
    { id: "3m", label: "Last 3 months (same as Search Console)" },
    { id: "all", label: "All saved days" },
  ];

  return (
    <SourcesProvider value={sources}>
      <Section
        title="AI visibility in Google Search"
        source={saved.length ? ["client.aiImport"] : undefined}
        lede="How often Google's AI Overviews and AI Mode linked to this site, from Search Console's Generative AI features report (Beta). Google offers this report only in the Search Console interface, not through its API, so the team's Chrome extension copies it once a week. It counts impressions only: Google doesn't share clicks or the questions asked."
      >
        {retired && <div className="notice">{BOOKMARKS_RETIRED}</div>}
        {state?.note && <div className="notice error">{state.note}</div>}
        {state && !state.shared && !state.note && (
          <div className="notice">The Google Sheet isn&apos;t set up, so only AI data saved earlier in this browser is shown.</div>
        )}
        {!state && <p className="muted">Loading saved AI impressions…</p>}
        {state && !saved.length && (
          <div className="notice">
            No AI impressions saved for this property yet. The Chrome extension adds them with its weekly update (see the Index checks tab).
          </div>
        )}

        {saved.length > 0 && (
          <>
            <div
              className="row"
              role="group"
              aria-label="Date range for AI impressions"
              style={{ gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}
            >
              <span className="muted">Showing:</span>
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="btn small"
                  aria-pressed={range === r.id}
                  style={range === r.id ? { fontWeight: 600, borderColor: "#5e35b1", color: "#5e35b1" } : undefined}
                  onClick={() => pickRange(r.id)}
                >
                  {r.label}
                </button>
              ))}
              <span className="muted">{winText}</span>
            </div>

            <Kpis items={kpis} />

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={web ? ["client.aiImport", "calc.aiShare"] : ["client.aiImport"]}>
                {web ? `AI impressions by day, and share of all Search impressions · ${winText}` : `AI impressions by day · ${winText}`}
              </PanelTitle>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#e7ebef" vertical={false} />
                  <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                  <YAxis yAxisId="a" tick={axis} width={48} />
                  {web && <YAxis yAxisId="s" orientation="right" tick={axis} width={44} unit="%" />}
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 13 }} />
                  <Line yAxisId="a" type="monotone" dataKey="ai" name="AI impressions" stroke="#5e35b1" strokeWidth={2} dot={false} />
                  {web && <Line yAxisId="s" type="monotone" dataKey="share" name="Share of Search impressions (%)" stroke="#9bb0d9" dot={false} />}
                </ComposedChart>
              </ResponsiveContainer>
              {!cur.complete && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  {cur.expected - cur.covered} days in this range have no saved data yet. Each weekly update adds the latest days.
                </p>
              )}
            </div>

            {snap && (
              <div className="grid-2" style={{ marginTop: 16, alignItems: "stretch" }}>
                {/* Pages: fills the height set by the Countries/Devices panel and scrolls inside. */}
                <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <PanelTitle source={["client.aiImport"]}>
                    {`Pages linked by AI · ${fmtRange(snap.from, snap.to)} (latest capture)${pagesCapped ? " · top 1,000" : ""}`}
                  </PanelTitle>
                  <div style={{ flex: "1 1 0", minHeight: 320, overflowY: "auto" }}>
                    <DataTable
                      rows={pageRows}
                      cols={PAGE_COLS}
                      initialSort="impressions"
                      pageSize={AI_MAX_PAGES}
                      csvName="ai-impressions-pages.csv"
                      source={["client.aiImport"]}
                    />
                  </div>
                </div>
                <div className="panel">
                  <PanelTitle source={["client.aiImport"]}>{`Countries · ${fmtRange(snap.from, snap.to)}`}</PanelTitle>
                  {Object.keys(snap.countries).length ? (
                    <Bars items={top(snap.countries, 10)} color="#5e35b1" />
                  ) : (
                    <p className="muted">Not in the latest update.</p>
                  )}
                  <div style={{ marginTop: 16 }}>
                    <PanelTitle source={["client.aiImport"]}>{`Devices · ${fmtRange(snap.from, snap.to)}`}</PanelTitle>
                    {Object.keys(snap.devices).length ? (
                      <Bars items={top(snap.devices, 5)} color="#9bb0d9" />
                    ) : (
                      <p className="muted">Not in the latest update.</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <UpdatedBy title="AI impressions updates" updates={updates} shared={!!state?.shared} />
      </Section>
    </SourcesProvider>
  );
}
