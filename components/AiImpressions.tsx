// components/AiImpressions.tsx
"use client";
// Overview section: Google AI Overviews + AI Mode impressions for the whole site. The data comes from Search Console's
// Generative AI features report (no API): one-click "Copy AI impressions" bookmark, paste, or the report's export files.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GscData, Source, Sources } from "@/lib/types";
import { AI_HOW_TO, clearAi, parseAiFiles, saveAi, useAiStore } from "@/lib/aiImpressions";
import { aiBookmarkletFor, parseAiCapture } from "@/lib/aiCapture";
import { AI_MAX_PAGES, aiSum, latestAiSnapshot, type AiParsed } from "@/lib/aiStore";
import { addDays } from "@/lib/dates";
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

const ago = (iso: string) => {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = (Date.now() - t) / DAY;
  if (d < 1 / 24) return "just now";
  return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};

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
  waiting = false,
  onInboxHandled,
}: {
  site: string;
  gsc: GscData;
  /** Data sent by the "Copy AI impressions" bookmark. */
  inbox?: string | null;
  waiting?: boolean;
  onInboxHandled?: () => void;
}) {
  const outer = useSources();
  const state = useAiStore(site);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [pending, setPending] = useState<AiParsed | null>(null);
  const [paste, setPaste] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [range, setRange] = useState<AiRange>("period");
  const fileRef = useRef<HTMLInputElement>(null);
  const bmRef = useRef<HTMLAnchorElement>(null);
  const handled = useRef<string | null>(null);

  const store = state?.store ?? null;
  const snap = latestAiSnapshot(store);
  const saved = useMemo(() => (store ? Object.keys(store.days).sort() : []), [store]);
  const last = store?.imports.length ? store.imports[store.imports.length - 1] : null;
  const web = (gsc.searchType || "web") === "web";
  const reportUrl = `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(site)}`;
  const periodDays = daysBetween(gsc.range.startDate, gsc.range.endDate);

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

  // Set the bookmark's address directly (React warns about javascript: links in JSX).
  useEffect(() => {
    bmRef.current?.setAttribute("href", aiBookmarkletFor(window.location.origin));
  }, []);

  const takeCapture = useCallback(
    async (text: string) => {
      setBusy(true);
      setMsg(null);
      setPending(null);
      try {
        const r = parseAiCapture(text, site);
        const notes = r.notes.length ? ` ${r.notes.join(" ")}` : "";
        if (r.verified) {
          await saveAi(site, [r.item]);
          setMsg({ text: `Updated: ${r.summary}.${notes}` });
          setPaste("");
        } else {
          setPending(r.item);
          setMsg({ text: `${r.problem}${notes}`, error: true });
        }
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : "Couldn't read the data", error: true });
      }
      setBusy(false);
    },
    [site]
  );

  // Data arriving from the bookmark (via the dashboard URL).
  useEffect(() => {
    if (!inbox || !state || handled.current === inbox) return;
    handled.current = inbox;
    takeCapture(inbox).finally(() => onInboxHandled?.());
  }, [inbox, state, takeCapture, onInboxHandled]);

  const savePending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await saveAi(site, [pending]);
      setMsg({ text: "Saved anyway. Compare the chart with Search Console to be sure." });
      setPending(null);
      setPaste("");
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Saving failed", error: true });
    }
    setBusy(false);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(aiBookmarkletFor(window.location.origin));
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      setMsg({ text: "Couldn't copy. Right-click the button and copy the link address instead.", error: true });
    }
  };

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

  const sources = useMemo<Sources>(() => {
    if (!saved.length) return outer;
    const imported = {
      id: "client.aiImport",
      label: "Google AI impressions (Generative AI features report)",
      system: `Search Console Generative AI performance report (Beta), copied from the report page or its export and saved ${state?.shared ? "in shared storage" : "in this browser"}`,
      range: { startDate: saved[0], endDate: saved[saved.length - 1] },
      fetchedAt: last?.at || new Date().toISOString(),
      rowCount: saved.length,
      formula:
        "Daily impressions come from the report's chart and are merged by date across updates; a newer update replaces the same dates. " +
        "Bookmark copies are saved automatically only when the days add up to the report's Total impressions. " +
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

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setMsg(null);
    setPending(null);
    try {
      const { parsed, skipped } = await parseAiFiles(Array.from(list));
      if (!parsed.length) throw new Error(`Nothing to import. ${AI_HOW_TO}`);
      await saveAi(site, parsed);
      const summary = parsed
        .map((p) => {
          const total = Object.values(p.days).reduce((a, b) => a + b, 0);
          return `${num(total)} AI impressions, ${p.from} to ${p.to} · ${num(Object.keys(p.pages).length)} pages · ${Object.keys(p.countries).length} countries · ${Object.keys(p.devices).length} devices`;
        })
        .join("; ");
      setMsg({ text: `Imported: ${summary}.${skipped.length ? ` Skipped ${skipped.join(", ")} (only ZIP and CSV files are read).` : ""}` });
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
      setPending(null);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Delete failed", error: true });
    }
    setBusy(false);
  };

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
          sub: cur.complete
            ? `${winText} · ${cur.expected} days`
            : `${winText} · only ${cur.covered} of ${cur.expected} days saved`,
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
          sub: snap
            ? `${fmtRange(snap.from, snap.to)} · latest capture${pagesCapped ? " · Search Console lists 1,000 max" : ""}`
            : "no page list saved yet",
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

  /** Bookmark, paste and export steps: shown open when nothing is saved yet, folded away under "How to update" otherwise. */
  const howTo = (
    <>
      <h4 style={{ margin: "4px 0 8px" }}>Update with one click (no export)</h4>
      <ol style={{ marginTop: 0, paddingLeft: 20 }}>
        <li>
          One time only: drag this button to your browser&apos;s bookmarks bar{" "}
          <a ref={bmRef} className="btn" onClick={(e) => e.preventDefault()} title="Drag me to the bookmarks bar">
            Copy AI impressions
          </a>{" "}
          (if dragging doesn&apos;t work,{" "}
          <button type="button" className="btn small" onClick={copyCode}>
            {codeCopied ? "Copied" : "copy its code"}
          </button>{" "}
          and create a bookmark with that code as the URL). Replace any older “Copy AI impressions” bookmark.
        </li>
        <li>
          Open{" "}
          <a href={reportUrl} target="_blank" rel="noreferrer">
            Performance for this property
          </a>
          , click <strong>Open report</strong> in the generative AI box, press F5 to reload it, wait for the chart, then click the bookmark. It
          reads the Pages, Countries and Devices tabs, then the dashboard opens in a new tab, checks the numbers and saves them for everyone.
        </li>
      </ol>

      <details>
        <summary>The browser blocked the new tab? Paste instead</summary>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={4}
          style={{ width: "100%", marginTop: 8 }}
          placeholder="Paste what the bookmark copied"
          aria-label="Paste AI impressions"
        />
        <button className="btn" disabled={busy || !paste.trim() || !state} onClick={() => takeCapture(paste)}>
          Paste AI impressions
        </button>
      </details>

      <details style={{ marginTop: 8 }}>
        <summary>Or import Search Console export files</summary>
        <p className="muted">{AI_HOW_TO}</p>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.csv"
          multiple
          disabled={busy || !state}
          onChange={(e) => onFiles(e.target.files)}
          aria-label="Choose Generative AI report export files"
        />
      </details>
    </>
  );

  return (
    <SourcesProvider value={sources}>
      <Section
        title="AI visibility in Google Search"
        source={saved.length ? ["client.aiImport"] : undefined}
        lede="How often Google's AI Overviews and AI Mode linked to this site, from Search Console's Generative AI features report (Beta). Google offers this report only in the Search Console interface, not through its API, so it's copied from the report page or its export. It counts impressions only: Google doesn't share clicks or the questions asked."
      >
        {waiting && <div className="notice">Waiting for data from the “Copy AI impressions” bookmark…</div>}
        {state?.note && <div className="notice error">{state.note}</div>}
        {state && !state.shared && !state.note && (
          <div className="notice">Shared storage isn&apos;t set up, so AI data is saved only in this browser.</div>
        )}
        {!state && <p className="muted">Loading saved AI impressions…</p>}
        {state && !saved.length && <div className="notice">No AI impressions saved for this property yet. Follow the steps below to add them.</div>}

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
                {web
                  ? `AI impressions by day, and share of all Search impressions · ${winText}`
                  : `AI impressions by day · ${winText}`}
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
                  {cur.expected - cur.covered} days in this range have no saved data. Update with the bookmark or a longer export to fill them.
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
                    <p className="muted">Not in the latest update. Click the bookmark again.</p>
                  )}
                  <div style={{ marginTop: 16 }}>
                    <PanelTitle source={["client.aiImport"]}>{`Devices · ${fmtRange(snap.from, snap.to)}`}</PanelTitle>
                    {Object.keys(snap.devices).length ? (
                      <Bars items={top(snap.devices, 5)} color="#9bb0d9" />
                    ) : (
                      <p className="muted">Not in the latest update. Click the bookmark again.</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div className="panel" style={{ marginTop: 16 }}>
          <PanelTitle>Update AI impressions</PanelTitle>

          {last && (
            <p style={{ marginTop: 0 }}>
              Last updated <strong>{new Date(last.at).toLocaleString()}</strong> ({ago(last.at)})
              {last.by ? (
                <>
                  {" "}
                  by <strong>{last.by}</strong>
                </>
              ) : null}
              <span className="muted">{state?.shared ? " · saved for everyone" : " · saved in this browser"}</span>
            </p>
          )}

          {saved.length > 0 ? (
            <details>
              <summary>How to update</summary>
              <div style={{ marginTop: 8 }}>{howTo}</div>
            </details>
          ) : (
            howTo
          )}

          <div className="row" style={{ marginTop: 12 }}>
            {busy && <span className="muted">Working…</span>}
            {pending && (
              <button className="btn" onClick={savePending} disabled={busy}>
                Save anyway
              </button>
            )}
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
        </div>
      </Section>
    </SourcesProvider>
  );
}
