// components/AiImpressions.tsx
"use client";
// Overview section: Google AI Overviews + AI Mode impressions for the whole site, from imported
// Search Console "Generative AI features" exports (the report has no API).
import { useMemo, useRef, useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GscData, Source, Sources } from "@/lib/types";
import { AI_HOW_TO, clearAi, parseAiFiles, saveAi, useAiStore } from "@/lib/aiImpressions";
import { aiSum, latestAiSnapshot } from "@/lib/aiStore";
import { Bars, DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, num, pct, useSources, type Col, type KpiItem } from "./ui";

const axis = { fontSize: 12, fill: "#5b6573" };

type PageAiRow = { url: string; impressions: number; share: number };
type HistoryRow = { at: string; by: string; file: string; dates: string; days: number; pages: number };

const PAGE_COLS: Col<PageAiRow>[] = [
  { key: "url", label: "Page", url: true },
  { key: "impressions", label: "AI impressions", num: true, render: (r) => num(r.impressions) },
  { key: "share", label: "Share of listed", num: true, render: (r) => pct(r.share) },
];

const HISTORY_COLS: Col<HistoryRow>[] = [
  { key: "at", label: "Imported" },
  { key: "by", label: "By" },
  { key: "dates", label: "Dates" },
  { key: "days", label: "Days", num: true },
  { key: "pages", label: "Pages", num: true },
  { key: "file", label: "File" },
];

const top = (m: Record<string, number> | undefined, n: number) =>
  Object.entries(m || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, value]) => ({ label, value }));

export default function AiOverview({ site, gsc }: { site: string; gsc: GscData }) {
  const outer = useSources();
  const state = useAiStore(site);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const store = state?.store ?? null;
  const snap = latestAiSnapshot(store);
  const saved = useMemo(() => (store ? Object.keys(store.days).sort() : []), [store]);
  const last = store?.imports.length ? store.imports[store.imports.length - 1] : null;
  const web = (gsc.searchType || "web") === "web";
  const cur = aiSum(store, gsc.range.startDate, gsc.range.endDate);
  const prev = aiSum(store, gsc.previousRange.startDate, gsc.previousRange.endDate);
  const searchImpr = gsc.totals.current.impressions;

  const trend = useMemo(
    () =>
      gsc.trend.map((t) => {
        const v = store?.days[t.date];
        return {
          date: t.date,
          ai: v ?? null,
          share: v != null && t.impressions > 0 ? +((v / t.impressions) * 100).toFixed(2) : null,
        };
      }),
    [gsc.trend, store]
  );

  const pageRows = useMemo<PageAiRow[]>(() => {
    if (!snap) return [];
    const tot = Object.values(snap.pages).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(snap.pages).map(([url, impressions]) => ({ url, impressions, share: impressions / tot }));
  }, [snap]);

  const history = useMemo<HistoryRow[]>(
    () =>
      (store?.imports || [])
        .slice()
        .reverse()
        .map((i) => ({
          at: new Date(i.at).toLocaleString(),
          by: i.by || "this browser",
          file: i.file,
          dates: `${i.from} to ${i.to}`,
          days: i.days,
          pages: i.pages,
        })),
    [store]
  );

  const sources = useMemo<Sources>(() => {
    if (!saved.length) return outer;
    const imported = {
      id: "client.aiImport",
      label: "Google AI impressions (Generative AI features report)",
      system: `Search Console Generative AI performance report (Beta), imported from its export and saved ${state?.shared ? "in shared storage" : "in this browser"}`,
      range: { startDate: saved[0], endDate: saved[saved.length - 1] },
      fetchedAt: last?.at || new Date().toISOString(),
      rowCount: saved.length,
      formula:
        "Daily impressions come from the export's chart data and are merged by date across imports; a newer import replaces the same dates. " +
        "Page, country and device totals come from the most recent export and cover only that export's dates, because the export doesn't split them by day.",
      verifyUrl: `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(site)}`,
      verifyLabel: "Open Performance in Search Console",
      verifyHow: "Search Console → Performance → Generative AI features (Beta). Set the same dates; the daily chart should match day for day.",
    } as Source;
    const share = {
      id: "calc.aiShare",
      label: "AI share of Search impressions",
      system: "Calculated in the dashboard",
      fetchedAt: new Date().toISOString(),
      formula:
        "AI impressions ÷ Search Console impressions (Web search type) for the same days. Google counts AI Overview and AI Mode impressions inside the " +
        "normal Search totals too, so this is the part of the site's search impressions that came from links in AI answers.",
      derivedFrom: ["client.aiImport", "gsc.trend"],
    } as Source;
    return { ...outer, [imported.id]: imported, [share.id]: share };
  }, [outer, saved, last, state?.shared, site]);

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const { parsed, skipped } = await parseAiFiles(Array.from(list));
      if (!parsed.length) throw new Error(`Nothing to import. ${AI_HOW_TO}`);
      const s = await saveAi(site, parsed);
      const summary = parsed
        .map((p) => {
          const total = Object.values(p.days).reduce((a, b) => a + b, 0);
          return `${p.file}: ${p.from} to ${p.to}, ${num(total)} AI impressions, ${num(Object.keys(p.pages).length)} pages`;
        })
        .join("; ");
      setMsg({
        text:
          `Imported into ${site}. ${summary}.` +
          (skipped.length ? ` Skipped ${skipped.join(", ")} (only ZIP and CSV files are read).` : "") +
          ` Saved ${s.shared ? "for everyone" : "in this browser only"}.`,
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Couldn't read the files", error: true });
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const clearAll = async () => {
    if (!confirm(`Delete all saved AI impressions for ${site}${state?.shared ? " for everyone" : ""}?`)) return;
    setBusy(true);
    try {
      await clearAi(site);
      setMsg({ text: "Saved AI data deleted." });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Delete failed", error: true });
    }
    setBusy(false);
  };

  const kpis: KpiItem[] = saved.length
    ? [
        {
          label: "AI impressions",
          source: ["client.aiImport"],
          value: cur.covered ? num(cur.total) : "–",
          delta: cur.complete && prev.complete ? <Delta cur={cur.total} prev={prev.total} /> : undefined,
          sub: cur.complete ? `${gsc.range.startDate} to ${gsc.range.endDate}` : `${cur.covered} of ${cur.expected} days in this period imported`,
        },
        {
          label: "Share of Search impressions",
          source: ["calc.aiShare"],
          value: web && cur.complete && searchImpr ? pct(cur.total / searchImpr) : "–",
          sub: web ? "AI impressions ÷ all Search impressions" : "only for the Web search type",
        },
        {
          label: "Pages linked by AI",
          source: ["client.aiImport"],
          value: snap ? num(Object.keys(snap.pages).length) : "–",
          sub: snap ? `latest export, ${snap.from} to ${snap.to}` : "import an export that includes its Pages table",
        },
        {
          label: "Days saved",
          source: ["client.aiImport"],
          value: num(saved.length),
          sub: `${saved[0]} to ${saved[saved.length - 1]}`,
        },
      ]
    : [];

  return (
    <SourcesProvider value={sources}>
      <Section
        title="AI visibility in Google Search"
        source={saved.length ? ["client.aiImport"] : undefined}
        lede="How often Google's AI Overviews and AI Mode linked to this site, from Search Console's Generative AI features report (Beta). Google offers this report only in the Search Console interface, not through its API, so it's imported from the report's export. It counts impressions only: Google doesn't share clicks or the questions asked."
      >
        {state?.note && <div className="notice error">{state.note}</div>}
        {state && !state.shared && !state.note && (
          <div className="notice">Shared storage isn&apos;t set up, so imported AI data is saved only in this browser.</div>
        )}
        {!state && <p className="muted">Loading saved AI impressions…</p>}
        {state && !saved.length && <div className="notice">No Generative AI report has been imported for this property yet. {AI_HOW_TO}</div>}

        {saved.length > 0 && (
          <>
            <Kpis items={kpis} />

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={web ? ["client.aiImport", "calc.aiShare"] : ["client.aiImport"]}>
                {web ? "AI impressions by day, and share of all Search impressions" : "AI impressions by day"}
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
                  {cur.expected - cur.covered} days in this period have no imported data. Import a newer or longer export to fill them.
                </p>
              )}
            </div>

            {snap && (
              <div className="grid-2" style={{ marginTop: 16 }}>
                <div className="panel">
                  <PanelTitle source={["client.aiImport"]}>{`Pages linked by AI, ${snap.from} to ${snap.to}`}</PanelTitle>
                  <DataTable rows={pageRows} cols={PAGE_COLS} initialSort="impressions" pageSize={10} csvName="ai-impressions-pages.csv" source={["client.aiImport"]} />
                </div>
                <div className="panel">
                  <PanelTitle source={["client.aiImport"]}>Countries</PanelTitle>
                  {Object.keys(snap.countries).length ? <Bars items={top(snap.countries, 10)} color="#5e35b1" /> : <p className="muted">Not in this export.</p>}
                  <PanelTitle source={["client.aiImport"]}>Devices</PanelTitle>
                  {Object.keys(snap.devices).length ? <Bars items={top(snap.devices, 5)} color="#9bb0d9" /> : <p className="muted">Not in this export.</p>}
                </div>
              </div>
            )}
          </>
        )}

        <div className="panel" style={{ marginTop: 16 }}>
          <PanelTitle>Import the Generative AI report</PanelTitle>
          <p className="muted" style={{ marginTop: 0 }}>{AI_HOW_TO}</p>
          <div className="row">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.csv"
              multiple
              disabled={busy || !state}
              onChange={(e) => onFiles(e.target.files)}
              aria-label="Choose Generative AI report export files"
            />
            {busy && <span className="muted">Working…</span>}
            {saved.length > 0 && (
              <button className="btn" onClick={clearAll} disabled={busy}>
                Delete saved AI data
              </button>
            )}
          </div>
          {msg && (
            <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>
              {msg.text}
            </p>
          )}
          {history.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <DataTable rows={history} cols={HISTORY_COLS} pageSize={5} empty="No imports yet." />
            </div>
          )}
        </div>
      </Section>
    </SourcesProvider>
  );
}
