// components/QueryGrowth.tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Source, Sources } from "@/lib/types";
import {
  buildGrowthReport, expand, growthCalcSources, normalizeBrand, lc, cap, STATUS_LABEL,
  type GrowthReport, type GrowthRow, type GrowthInput, type ListId, type Bridge, type Status,
} from "@/lib/queryGrowth";
import { readPicked, parseGscExport, guessSite, HOW_TO_EXPORT } from "@/lib/gscImport";
import { growthReportHtml } from "@/lib/growthReportHtml";
import { downloadFile, downloadJson, fileSafe } from "@/lib/evidence";
import { kvGet, kvSet } from "@/lib/idb";
import { periodName, compareName, type Compare } from "@/lib/dates";
import { DataTable, Kpis, Section, SubTabs, PanelTitle, SourcesProvider, useSources, Delta, num, pct, pos, Col, KpiItem } from "./ui";

/* ---------- Imported reports, kept in this browser ---------- */

type ImportRec =
  | { id: string; kind: "gsc-export"; name: string; importedAt: string; input: GrowthInput; brand: string }
  | { id: string; kind: "saved-report"; name: string; importedAt: string; report: GrowthReport; sources: Sources };

const KV = "growth-imports";

/** Short name for the picker: "acme.com export, 2026-09-29" instead of Search Console's long file name. */
function displayName(r: ImportRec) {
  if (r.kind === "saved-report") return `${r.report.subject} (saved report)`;
  const host = guessSite(r.name), date = r.name.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return host ? `${host} export${date ? `, ${date}` : ""}` : r.name;
}

/** Default brand term from a domain: "acme-shoes.com" → "acmeshoes", which matches "acme shoes" once spaces are removed. */
const brandFromHost = (host: string) => host.split(".")[0].replace(/-/g, "");
const SAVED_KIND = "query-growth-report";

/* Live reports are cached for a few minutes so switching tabs doesn't refetch every query. */
const liveCache = new Map<string, { at: number; report: GrowthReport; sources: Sources }>();
const CACHE_MS = 10 * 60 * 1000;

/* ---------- Small pieces ---------- */

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.round(Math.abs(v)).toLocaleString()}`;
const Signed = ({ v }: { v: number }) => <span className={`delta ${v > 0 ? "good" : v < 0 ? "bad" : "flat"}`}>{signed(v)}</span>;

function PctChange({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span className="delta flat">{cur ? "new" : "–"}</span>;
  const d = ((cur - prev) / prev) * 100;
  return <span className={`delta ${Math.abs(d) < 0.05 ? "flat" : d > 0 ? "good" : "bad"}`}>{d > 0 ? "+" : ""}{d.toFixed(1)}%</span>;
}

function PosChange({ v }: { v: number | null }) {
  if (v == null) return <span className="muted">–</span>;
  const cls = v > 0.05 ? "bad" : v < -0.05 ? "good" : "flat";
  return <span className={`delta ${cls}`}>{v > 0 ? `▼ ${v.toFixed(1)}` : v < 0 ? `▲ ${Math.abs(v).toFixed(1)}` : "0.0"}</span>;
}

const STATUS_PILL: Record<Status, string> = { new: "ok", growing: "ok", declining: "no", lost: "no", steady: "info" };

/** Diverging bars: what added to the total (right) and what took away from it (left). */
function BridgeChart({ b, unit }: { b: Bridge; unit: string }) {
  const parts = [
    { label: "New queries", v: b.fromNew, c: "var(--up)" },
    { label: "Growing queries", v: b.growing, c: "var(--up)" },
    { label: "Declining queries", v: -b.declining, c: "var(--down)" },
    { label: "Lost queries", v: -b.lost, c: "var(--down)" },
    ...(Math.round(b.unlisted) ? [{ label: "Not listed individually", v: b.unlisted, c: "var(--ink-3)" }] : []),
  ];
  const net = b.end - b.start;
  const max = Math.max(1, ...parts.map((p) => Math.abs(p.v)), Math.abs(net));
  const Row = ({ label, v, c, net: isNet }: { label: string; v: number; c: string; net?: boolean }) => {
    const w = `${(Math.abs(v) / max) * 100}%`;
    return (
      <div className={`bridge-row${isNet ? " net" : ""}`}>
        <span>{label}</span>
        <div className="dv" aria-hidden="true">
          <div className="dv-l">{v < 0 && <i style={{ width: w, background: c }} />}</div>
          <div className="dv-r">{v > 0 && <i style={{ width: w, background: c }} />}</div>
        </div>
        <span className="num"><Signed v={v} /></span>
      </div>
    );
  };
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        {num(b.start)} {unit} before → {num(b.end)} now
      </p>
      <div className="bridge">
        {parts.map((p) => <Row key={p.label} {...p} />)}
        <Row label="Net change" v={net} c="var(--r10)" net />
      </div>
    </div>
  );
}

function BandPairs({ report }: { report: GrowthReport }) {
  const max = Math.max(1, ...report.bands.flatMap((b) => [b.cur, b.prev]));
  const c = report.counts;
  return (
    <div>
      <div className="legend">
        <span><i style={{ background: "var(--r30)" }} />Before</span>
        <span><i style={{ background: "var(--r10)" }} />Now</span>
      </div>
      <div className="pairs">
        {report.bands.map((b) => (
          <div className="pair-row" key={b.id}>
            <span>{b.label}</span>
            <div className="pair-bars" aria-hidden="true">
              <i style={{ width: `${(b.prev / max) * 100}%`, background: "var(--r30)" }} />
              <i style={{ width: `${(b.cur / max) * 100}%`, background: "var(--r10)" }} />
            </div>
            <span className="num">{num(b.prev)} → {num(b.cur)}</span>
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {num(c.reachedPageOne)} queries moved onto page one and {num(c.droppedPageOne)} fell off it; {num(c.reachedTop3)} reached the top 3 and {num(c.droppedTop3)} left it.
        Counted for queries with {report.minImpr}+ impressions.
      </p>
    </div>
  );
}

function SegmentTable({ report }: { report: GrowthReport }) {
  return (
    <div className="table-wrap">
      <table className="seg-table">
        <thead>
          <tr>
            <th>Segment</th>
            <th className="num">Queries</th>
            <th className="num">Clicks before</th>
            <th className="num">Clicks now</th>
            <th className="num">Change</th>
            <th className="num">Impressions before</th>
            <th className="num">Impressions now</th>
            <th className="num">Change</th>
            <th className="num">Position</th>
          </tr>
        </thead>
        <tbody>
          {report.segments.map((s) => (
            <tr key={s.id}>
              <td>{s.label}</td>
              <td className="num">{num(s.prev.queries)} → {num(s.cur.queries)}</td>
              <td className="num">{num(s.prev.clicks)}</td>
              <td className="num">{num(s.cur.clicks)}</td>
              <td className="num"><PctChange cur={s.cur.clicks} prev={s.prev.clicks} /></td>
              <td className="num">{num(s.prev.impressions)}</td>
              <td className="num">{num(s.cur.impressions)}</td>
              <td className="num"><PctChange cur={s.cur.impressions} prev={s.prev.impressions} /></td>
              <td className="num">{pos(s.prev.position)} → {pos(s.cur.position)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Tab ---------- */

type View = ListId | "all";

export default function QueryGrowth({ site, days, compare }: { site: string; days: number; compare: Compare }) {
  const parent = useSources();
  const [imports, setImports] = useState<ImportRec[]>([]);
  const [sel, setSel] = useState("live");
  const [liveBrand, setLiveBrand] = useState<string | null>(null);
  const [brandDraft, setBrandDraft] = useState<string | null>(null);
  const [live, setLive] = useState<{ report: GrowthReport; sources: Sources } | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>("gainers");
  const [metric, setMetric] = useState<"clicks" | "impressions">("clicks");
  const fileInput = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    kvGet<ImportRec[]>(KV)
      .then((l) => setImports(l || []))
      .catch(() => setMsg({ text: "This browser blocked local storage (IndexedDB), so imported reports can't be kept after a reload.", error: true }));
  }, []);

  useEffect(() => { setLiveBrand(null); setBrandDraft(null); }, [site]);

  const rec = imports.find((i) => i.id === sel) || null;
  const isLive = !rec;

  /* ---------- Live report ---------- */
  const liveKey = `${site}|${days}|${compare}|${liveBrand ?? ""}`;
  const loadLive = useCallback(async (force = false) => {
    if (!site) return;
    const hit = liveCache.get(liveKey);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) {
      setLive(hit);
      setLiveError(null);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setLiveError(null);
    try {
      const q = new URLSearchParams({ site, days: String(days), compare });
      if (liveBrand != null) q.set("brand", liveBrand);
      const res = await fetch(`/api/gsc/query-growth?${q}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (id !== reqId.current) return;
      liveCache.set(liveKey, { at: Date.now(), ...data });
      setLive(data);
    } catch (e) {
      if (id === reqId.current) setLiveError(e instanceof Error ? e.message : "Could not load the report");
    }
    if (id === reqId.current) setLoading(false);
  }, [site, days, compare, liveBrand, liveKey]);

  useEffect(() => {
    setLive(null);
    if (isLive) loadLive();
  }, [isLive, loadLive]);

  /* ---------- The report on screen, and where its numbers come from ---------- */
  const report = useMemo<GrowthReport | null>(() => {
    if (!rec) return live?.report || null;
    if (rec.kind === "saved-report") return rec.report;
    return buildGrowthReport({ ...rec.input, brand: rec.brand });
  }, [rec, live]);

  const ownSources = useMemo<Sources>(() => {
    if (!rec) return live?.sources || {};
    if (rec.kind === "saved-report") return rec.sources || {};
    const file: Source = {
      id: "import.file",
      label: `Imported file: ${rec.name}`,
      system: "Google Search Console Performance export (imported file)",
      fetchedAt: rec.importedAt,
      rowCount: rec.input.pairs.length,
      formula: rec.input.coverage,
      verifyHow: `Open the imported file and compare with its Queries.csv: this report reads the “${rec.input.currentLabel}” columns as this period and the “${rec.input.previousLabel}” columns as the comparison period.${rec.input.siteTotals ? " Totals are the sums of the daily rows in Chart.csv." : ""}`,
    };
    const calc = growthCalcSources(["import.file"], report?.minImpr ?? 20, normalizeBrand(rec.brand));
    return Object.fromEntries([file, ...calc].map((s) => [s.id, s]));
  }, [rec, live, report?.minImpr]);

  const sources = useMemo(() => ({ ...parent, ...ownSources }), [parent, ownSources]);
  const TOTALS = ownSources["growth.totals.current"] ? ["growth.totals.current", "growth.totals.previous"] : ["import.file"];

  /* ---------- Import ---------- */
  const persist = async (next: ImportRec[]) => {
    setImports(next);
    try { await kvSet(KV, next); } catch { /* kept in memory for this visit */ }
  };

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const { groups, json, skipped } = await readPicked(Array.from(list));
      const now = new Date().toISOString();
      const added: ImportRec[] = [];
      const newId = () => `imp-${Date.now()}-${added.length}`;
      for (const j of json) {
        const d = j.data as { kind?: string; report?: GrowthReport; sources?: Sources };
        if (d?.kind !== SAVED_KIND || d.report?.version !== 1) throw new Error(`${j.name} isn't a query growth report saved from this dashboard.`);
        added.push({ id: newId(), kind: "saved-report", name: j.name, importedAt: now, report: d.report, sources: d.sources || {} });
      }
      for (const g of groups) {
        const input = parseGscExport(g.csv, g.label);
        const host = guessSite(g.label);
        added.push({ id: newId(), kind: "gsc-export", name: g.label, importedAt: now, input, brand: host ? brandFromHost(host) : "" });
      }
      if (!added.length) {
        const excel = skipped.some((s) => /\.xlsx?$/i.test(s));
        throw new Error(
          excel
            ? `Excel exports can't be imported. In Search Console choose Export → Download CSV instead. ${HOW_TO_EXPORT}`
            : `Nothing to import. Choose the ZIP (or CSV files) from Search Console's Export → Download CSV, or a report saved from this tab.`
        );
      }
      await persist([...added, ...imports]);
      setSel(added[0].id);
      setBrandDraft(null);
      setView("gainers");
      setMsg({ text: `Imported ${added.map(displayName).join(", ")}.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""}` });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "That file couldn't be read.", error: true });
    }
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const removeImport = async () => {
    if (!rec || !confirm(`Remove “${displayName(rec)}” from this browser?`)) return;
    await persist(imports.filter((i) => i.id !== rec.id));
    setSel("live");
    setMsg({ text: `Removed ${displayName(rec)}.` });
  };

  /* ---------- Brand term ---------- */
  const brandValue = brandDraft ?? (rec?.kind === "gsc-export" ? rec.brand : report?.brand ?? "");
  const applyBrand = async () => {
    const b = normalizeBrand(brandDraft ?? brandValue);
    if (rec?.kind === "gsc-export") await persist(imports.map((i) => (i.id === rec.id ? { ...rec, brand: b } : i)));
    else if (isLive) setLiveBrand(b);
    setBrandDraft(null);
  };

  /* ---------- Downloads ---------- */
  const stamp = new Date().toISOString().slice(0, 10);
  const base = report ? `query-growth-${fileSafe(report.subject)}-${stamp}` : "query-growth";
  const downloadReport = () => report && downloadFile(`${base}.html`, growthReportHtml(report), "text/html");
  const saveReport = () => report && downloadJson(`${base}.json`, { kind: SAVED_KIND, version: 1, savedAt: new Date().toISOString(), report, sources: ownSources });

  /* ---------- Lists ---------- */
  const c = report?.counts;
  const rows = useMemo<GrowthRow[]>(() => {
    if (!report) return [];
    return (view === "all" ? report.rows : report.lists[view]).map(expand);
  }, [report, view]);

  const cols: Col<GrowthRow>[] = [
    { key: "query", label: "Query" },
    { key: "status", label: "Status", render: (r) => <span className={`pill ${STATUS_PILL[r.status]}`}>{STATUS_LABEL[r.status]}</span> },
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
    { key: "prevClicks", label: "Before", num: true, render: (r) => num(r.prevClicks) },
    { key: "clickChange", label: "Change", num: true, render: (r) => <Signed v={r.clickChange} /> },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
    { key: "prevImpressions", label: "Before", num: true, render: (r) => num(r.prevImpressions) },
    { key: "impressionChange", label: "Change", num: true, render: (r) => <Signed v={r.impressionChange} /> },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
    { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
    { key: "prevPosition", label: "Before", num: true, render: (r) => pos(r.prevPosition) },
    { key: "positionChange", label: "Change", num: true, render: (r) => <PosChange v={r.positionChange} /> },
  ];

  type ListDef = { id: View; label: string; note: string; sort: keyof GrowthRow & string; desc?: boolean; show?: boolean };
  const listDefs: ListDef[] = report && c
    ? ([
        { id: "gainers", label: "Biggest gainers", note: "Queries with the largest increase in clicks. New queries are included.", sort: "clickChange" },
        { id: "losers", label: "Biggest losers", note: "Queries with the largest drop in clicks. Lost queries are included.", sort: "clickChange", desc: false },
        { id: "new", label: `New (${num(c.new)})`, note: `Queries shown this period that didn't appear in ${lc(report.previousLabel)}.`, sort: "clicks" },
        { id: "lost", label: `Lost (${num(c.lost)})`, note: `Queries from ${lc(report.previousLabel)} that no longer appear.`, sort: "prevClicks" },
        { id: "reachedPageOne", label: `Moved onto page one (${num(c.reachedPageOne)})`, note: `Average position above 10 before and 10 or better now, with ${report.minImpr}+ impressions now.`, sort: "impressions", show: report.hasPositions },
        { id: "droppedPageOne", label: `Fell off page one (${num(c.droppedPageOne)})`, note: `Average position 10 or better before and worse than 10 now, with ${report.minImpr}+ impressions before.`, sort: "prevImpressions", show: report.hasPositions },
        { id: "impressionGainers", label: "Impression gainers", note: "Queries with the largest increase in impressions: growing visibility that may not have turned into clicks yet.", sort: "impressionChange" },
        {
          id: "all", label: `All queries (${num(report.rowCount)})`, sort: "clicks",
          note: report.truncated
            ? `The ${num(report.rows.length)} queries with the most clicks or impressions in either period (of ${num(report.rowCount)}). Export CSV to keep the full comparison.`
            : "Every query in both periods, matched side by side. Export CSV to keep the full comparison.",
        },
      ] as ListDef[]).filter((l) => l.show !== false)
    : [];
  const list = listDefs.find((l) => l.id === view) || listDefs[0];

  /* ---------- KPIs ---------- */
  const kpis: KpiItem[] = [];
  if (report && c) {
    const tc = report.totals.current, tp = report.totals.previous;
    const p1 = (k: "cur" | "prev") => report.bands[0][k] + report.bands[1][k];
    kpis.push(
      { label: "Clicks", source: TOTALS, value: num(tc.clicks), delta: <Delta cur={tc.clicks} prev={tp.clicks} />, sub: `${num(tp.clicks)} before` },
      { label: "Impressions", source: TOTALS, value: num(tc.impressions), delta: <Delta cur={tc.impressions} prev={tp.impressions} />, sub: `${num(tp.impressions)} before` },
      { label: "CTR", source: TOTALS, value: pct(tc.ctr, 2), delta: <Delta cur={tc.ctr * 100} prev={tp.ctr * 100} asPoints />, sub: `${pct(tp.ctr, 2)} before` },
      {
        label: "Avg. position", source: TOTALS, value: pos(tc.position),
        delta: tc.position != null && tp.position != null ? <Delta cur={tc.position} prev={tp.position} invert asPoints /> : undefined,
        sub: `${pos(tp.position)} before`,
      },
      { label: "Queries", source: ["growth.calc.status"], value: num(c.current), delta: <Delta cur={c.current} prev={c.previous} />, sub: `${num(c.previous)} before` },
      { label: "New / lost queries", source: ["growth.calc.status"], value: `${num(c.new)} / ${num(c.lost)}`, sub: `${num(c.retained)} in both periods` },
    );
    if (report.hasPositions) {
      kpis.push({ label: "Queries on page one", source: ["growth.calc.bands"], value: num(p1("cur")), delta: <Delta cur={p1("cur")} prev={p1("prev")} />, sub: `${num(p1("prev"))} before` });
    }
  }

  const liveLabel = `Live from Search Console: ${periodName(days)} vs ${compareName(days, compare)}`;

  return (
    <SourcesProvider value={sources}>
      <Section
        title="Query growth"
        lede="Every query compared across two periods: what grew, what's new, what dropped out, and where the change in clicks came from. Use live Search Console data for the period chosen in the top bar, or import a Search Console export (for example a 6-month comparison)."
      >
        <div className="panel">
          <div className="row">
            <label className="control" style={{ maxWidth: "100%" }}>
              Report on
              <select value={rec ? rec.id : "live"} onChange={(e) => { setSel(e.target.value); setBrandDraft(null); setMsg(null); }} style={{ minWidth: 0, width: 400, maxWidth: "100%" }}>
                <option value="live">{liveLabel}</option>
                {imports.map((i) => (
                  <option key={i.id} value={i.id} title={i.name}>
                    Imported: {displayName(i)}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? "Importing…" : "Import Search Console export"}
            </button>
            <input ref={fileInput} type="file" accept=".zip,.csv,.json,application/zip,text/csv,application/json" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <label className="control">
              Brand term
              <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input
                  value={brandValue}
                  onChange={(e) => setBrandDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyBrand()}
                  placeholder="e.g. acme"
                  style={{ minWidth: 120, width: 140 }}
                  disabled={rec?.kind === "saved-report"}
                  aria-label="Brand term used to split branded and non-branded queries"
                />
                {brandDraft != null && <button className="btn" onClick={applyBrand}>Apply</button>}
              </span>
            </label>
            <div className="row" style={{ marginLeft: "auto" }}>
              {isLive && <button className="btn" onClick={() => loadLive(true)} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>}
              <button className="btn" onClick={downloadReport} disabled={!report} title="A printable HTML report with the summary, splits and top queries">Download report</button>
              <button className="btn" onClick={saveReport} disabled={!report} title="Save this report as a file you can import again later, even after Search Console's 16 months have passed">Save report file</button>
              {rec && <button className="btn" onClick={removeImport}>Remove import</button>}
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            <strong>To import a comparison:</strong> {HOW_TO_EXPORT} Imports and saved report files stay in this browser.
          </p>
          {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
        </div>

        {isLive && loading && !live && (
          <div className="notice" style={{ marginTop: 16 }}>
            Fetching every query for both periods from Search Console. Six-month comparisons on large sites can take up to a minute.
          </div>
        )}
        {isLive && liveError && <div className="notice error" style={{ marginTop: 16 }}>{liveError}</div>}
      </Section>

      {report && c && (
        <>
          <Section title="Growth summary" source={["growth.calc.narrative"]} lede={`${cap(report.currentLabel)} compared with ${lc(report.previousLabel)}.`}>
            <Kpis items={kpis} />
            <p className="muted">
              {report.coverage}
              {report.truncated && ` The query table keeps the ${num(report.rows.length)} biggest queries; every figure above still uses all ${num(report.rowCount)}.`}
            </p>
            {report.warnings.map((w) => <div key={w} className="notice" style={{ marginBottom: 8 }}>{w}</div>)}
            <div className="panel">
              <ul className="narrative">{report.narrative.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          </Section>

          <Section title="Where the growth came from">
            <div className="grid-2">
              <div className="panel">
                <PanelTitle source={["growth.calc.bridge"]}>Change in {metric}</PanelTitle>
                <SubTabs value={metric} onChange={setMetric} options={[{ id: "clicks", label: "Clicks" }, { id: "impressions", label: "Impressions" }]} />
                <BridgeChart b={metric === "clicks" ? report.clicksBridge : report.impressionsBridge} unit={metric} />
              </div>
              <div className="panel">
                <PanelTitle source={["growth.calc.bands"]}>Queries by position, before and now</PanelTitle>
                {report.hasPositions ? <BandPairs report={report} /> : <p className="muted">The imported export has no positions. Turn on “Average position” in Search Console before exporting.</p>}
              </div>
            </div>
            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={["growth.calc.segments"]}>Growth by segment</PanelTitle>
              {!report.brand && <p className="muted" style={{ marginTop: 0 }}>Enter a brand term above to split branded and non-branded queries.</p>}
              <SegmentTable report={report} />
            </div>
          </Section>

          <Section title="Query lists">
            <div className="panel">
              <SubTabs value={list.id} onChange={setView} options={listDefs.map((l) => ({ id: l.id, label: l.label }))} />
              <p className="muted" style={{ marginTop: 0 }}>{list.note}</p>
              <DataTable
                key={`${sel}-${list.id}`}
                rows={rows}
                cols={cols}
                initialSort={list.sort}
                initialDesc={list.desc ?? true}
                csvName={`query-growth-${list.id}.csv`}
                source={list.id === "all" ? ["growth.calc.status"] : ["growth.calc.lists"]}
                empty="No queries in this list."
              />
            </div>
          </Section>
        </>
      )}
    </SourcesProvider>
  );
}
