// components/CrawlActivity.tsx
"use client";
// How often Google crawls the site. Exact daily counts come from Search Console's Crawl stats export
// (there is no API for it); per-page crawl recency comes from saved URL Inspection results; sitemap reads
// come from the Sitemaps API.
import { useEffect, useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Source, Sources } from "@/lib/types";
import { loadIndexCache, type IndexCache } from "@/lib/indexCache";
import { addDays } from "@/lib/dates";
import {
  HOW_TO_EXPORT, KIND_LABEL, applyImport, clearCrawl, crawlStatsUrl, dailyRows, loadCrawl, parseCrawlFiles, saveCrawl,
  type CrawlStore, type ParsedCrawl, type SeriesKind,
} from "@/lib/crawlStats";
import { Bars, DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, num, pct, useSources, type KpiItem } from "./ui";

type Pending = ParsedCrawl & { choice: SeriesKind; otherLabel: string };
type SitemapRow = {
  path: string; lastDownloaded: string; lastSubmitted: string; isPending: boolean; isIndex: boolean;
  errors: number; warnings: number; submitted: number | null;
};
type SitemapResp = { sitemaps?: SitemapRow[]; sources?: Sources; error?: string };

const WINDOWS: [number, string][] = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [0, "Everything imported"]];
const KINDS: SeriesKind[] = ["refresh", "discovery", "total", "other"];
const SRC = ["client.crawlImport"];
const DAY = 864e5;

const ago = (iso: string) => {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (isNaN(t)) return "–";
  const d = (Date.now() - t) / DAY;
  return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};
const mb = (b: number | null) => (b == null ? "–" : `${(b / 1e6).toFixed(1)} MB`);

export default function CrawlActivity({ site }: { site: string }) {
  const outer = useSources();
  const [store, setStore] = useState<CrawlStore | null>(null);
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState(30);
  const [cache, setCache] = useState<IndexCache | null>(null);
  const [sm, setSm] = useState<SitemapResp | null>(null);
  const [urlView, setUrlView] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setStore(null);
    setPending(null);
    setMsg(null);
    setCache(null);
    setSm(null);
    loadCrawl(site).then((s) => live && setStore(s));
    loadIndexCache(site).then((c) => live && setCache(c));
    fetch(`/api/gsc/sitemaps?site=${encodeURIComponent(site)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        return j as SitemapResp;
      })
      .then((j) => live && setSm(j))
      .catch((e) => live && setSm({ error: e instanceof Error ? e.message : "Couldn't read sitemaps" }));
    return () => {
      live = false;
    };
  }, [site]);

  /* ---------- Import ---------- */

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const { parsed, skipped } = await parseCrawlFiles(Array.from(list));
      const usable = parsed.filter((p) => Object.keys(p.days).length || p.urls.length);
      if (!usable.length) throw new Error(`No Crawl stats data was found in these files. ${HOW_TO_EXPORT}`);
      setPending(usable.map((p) => ({ ...p, choice: p.kind, otherLabel: p.label })));
      if (skipped.length) setMsg({ text: `Skipped ${skipped.join(", ")}: only ZIP and CSV files are read.` });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Couldn't read the files", error: true });
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const confirmImport = async () => {
    if (!pending) return;
    let s: CrawlStore = store || { series: {}, imports: [] };
    for (const p of pending) s = applyImport(s, p, p.choice, p.choice === "other" ? p.otherLabel.trim() || p.file : KIND_LABEL[p.choice]);
    await saveCrawl(site, s);
    setStore(s);
    setMsg({ text: `Imported ${pending.length} file(s). Days already saved were updated with the newer numbers.` });
    setPending(null);
  };

  const clearAll = async () => {
    if (!confirm("Delete the imported crawl data for this property in this browser?")) return;
    await clearCrawl(site);
    setStore({ series: {}, imports: [] });
  };

  /* ---------- Imported crawl counts ---------- */

  const all = useMemo(() => (store ? dailyRows(store) : []), [store]);
  const latest = all.length ? all[all.length - 1].date : "";
  const rows = useMemo(() => (win && latest ? all.filter((r) => r.date > addDays(latest, -win)) : all), [all, win, latest]);
  const hasSplit = !!store?.series.refresh && !!store?.series.discovery;
  const hasReportedTotal = !!store?.series.total;

  const k = useMemo(() => {
    const sum = (a: typeof rows, f: (r: (typeof rows)[number]) => number | null) => a.reduce((s, r) => s + (f(r) ?? 0), 0);
    const withTotal = rows.filter((r) => r.total != null);
    const total = sum(withTotal, (r) => r.total);
    const both = rows.filter((r) => r.refresh != null && r.discovery != null);
    const ref = sum(both, (r) => r.refresh);
    const dis = sum(both, (r) => r.discovery);
    const peak = withTotal.reduce<(typeof rows)[number] | null>((m, r) => (!m || (r.total ?? 0) > (m.total ?? 0) ? r : m), null);
    const msRows = rows.filter((r) => r.ms != null && r.total);
    const msWeight = sum(msRows, (r) => r.total);
    const ms = msWeight ? sum(msRows, (r) => (r.ms ?? 0) * (r.total ?? 0)) / msWeight : null;
    const cut7 = latest ? addDays(latest, -7) : "";
    const cut14 = latest ? addDays(latest, -14) : "";
    const last7 = all.filter((r) => r.total != null && r.date > cut7);
    const prev7 = all.filter((r) => r.total != null && r.date <= cut7 && r.date > cut14);
    return {
      total, days: withTotal.length, avg: withTotal.length ? total / withTotal.length : 0,
      ref, dis, splitDays: both.length, peak, ms,
      last7: sum(last7, (r) => r.total), prev7: sum(prev7, (r) => r.total), has14: last7.length === 7 && prev7.length === 7,
    };
  }, [rows, all, latest]);

  const others = useMemo(
    () =>
      Object.values(store?.series || {})
        .filter((s) => s.kind === "other")
        .map((s) => {
          const dates = Object.keys(s.days).filter((d) => !win || !latest || d > addDays(latest, -win));
          return { label: s.label, days: dates.length, requests: dates.reduce((n, d) => n + s.days[d].requests, 0) };
        }),
    [store, win, latest]
  );

  const withUrls = Object.values(store?.series || {}).filter((s) => s.urls.length);
  const urlSeries = withUrls.find((s) => s.key === urlView) || withUrls[0];

  const crawlSource: Source | null =
    store && all.length
      ? {
          id: "client.crawlImport",
          label: "Crawl stats imported from Search Console",
          system: "Google Search Console Crawl stats report (CSV export, imported into this browser)",
          range: { startDate: all[0].date, endDate: latest },
          fetchedAt: store.imports[store.imports.length - 1]?.at || new Date().toISOString(),
          rowCount: all.length,
          formula:
            `Daily counts read from the exported chart data and merged by date across imports (newer files win). ` +
            `Saved: ${Object.values(store.series).map((s) => `${s.label} (${Object.keys(s.days).length} days)`).join(", ")}. ` +
            `Every Googlebot crawl is either Refresh or Discovery, so when no “All crawl requests” file was imported, the daily total is Refresh + Discovery.`,
          verifyUrl: crawlStatsUrl(site),
          verifyLabel: "Open Crawl stats in Search Console",
          verifyHow:
            "Search Console → Settings → Crawl stats → Open report. Hover a day on the chart for its total crawl requests; under “By purpose” open Refresh or Discovery for those lines. Search Console keeps only the last 90 days.",
        }
      : null;

  const merged = useMemo<Sources>(
    () => ({ ...outer, ...(sm?.sources || {}), ...(crawlSource ? { [crawlSource.id]: crawlSource } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outer, sm, store, latest]
  );

  const kpis: KpiItem[] = [
    { label: "Crawl requests", value: num(k.total), sub: `${num(k.days)} day(s) with data`, source: SRC },
    { label: "Average per day", value: num(k.avg), source: SRC },
    {
      label: "Last 7 days",
      value: num(k.last7),
      delta: k.has14 ? <Delta cur={k.last7} prev={k.prev7} /> : undefined,
      sub: k.has14 ? undefined : "needs 14 days of data to compare",
      source: SRC,
    },
    {
      label: "Refresh",
      value: k.splitDays ? num(k.ref) : "–",
      sub: k.splitDays ? `${pct(k.ref / (k.ref + k.dis || 1), 0)} · re-crawls of known pages` : "import the Refresh export",
      source: SRC,
    },
    {
      label: "Discovery",
      value: k.splitDays ? num(k.dis) : "–",
      sub: k.splitDays ? `${pct(k.dis / (k.ref + k.dis || 1), 0)} · first crawls of new URLs` : "import the Discovery export",
      source: SRC,
    },
    { label: "Busiest day", value: k.peak ? num(k.peak.total) : "–", sub: k.peak?.date, source: SRC },
  ];
  if (k.ms != null) kpis.push({ label: "Avg. response time", value: `${num(k.ms)} ms`, sub: "how fast your server answered Googlebot", source: SRC });

  /* ---------- Crawl recency from URL Inspection ---------- */

  const recency = useMemo(() => {
    if (!cache) return null;
    const now = Date.now();
    const buckets: Record<string, number> = { "Last 24 hours": 0, "1–7 days": 0, "7–30 days": 0, "30–90 days": 0, "Over 90 days": 0, "Never crawled": 0 };
    const pages: { url: string; lastCrawl: string; ageDays: number | null; crawledAs: string; state: string }[] = [];
    let mobile = 0, desktop = 0;
    for (const [url, r] of Object.entries(cache.inspected)) {
      if (!r.verdict || r.verdict === "ERROR") continue;
      const t = r.lastCrawlTime ? Date.parse(r.lastCrawlTime) : NaN;
      if (/MOBILE/i.test(r.crawledAs)) mobile++;
      else if (/DESKTOP/i.test(r.crawledAs)) desktop++;
      const crawledAs = /MOBILE/i.test(r.crawledAs) ? "Smartphone" : /DESKTOP/i.test(r.crawledAs) ? "Desktop" : "–";
      if (isNaN(t)) {
        buckets["Never crawled"]++;
        pages.push({ url, lastCrawl: "", ageDays: null, crawledAs, state: r.coverageState });
        continue;
      }
      const age = (now - t) / DAY;
      buckets[age < 1 ? "Last 24 hours" : age < 7 ? "1–7 days" : age < 30 ? "7–30 days" : age < 90 ? "30–90 days" : "Over 90 days"]++;
      pages.push({ url, lastCrawl: r.lastCrawlTime.slice(0, 16).replace("T", " "), ageDays: Math.round(age * 10) / 10, crawledAs, state: r.coverageState });
    }
    // Sitemap entries changed in the last 30 days: has Google crawled them since?
    const lags: number[] = [];
    const waiting = cache.urls
      .filter((u) => u.lastmod && !isNaN(Date.parse(u.lastmod)) && now - Date.parse(u.lastmod) < 30 * DAY)
      .map((u) => {
        const r = cache.inspected[u.url];
        const lm = Date.parse(u.lastmod!);
        const lc = r?.lastCrawlTime ? Date.parse(r.lastCrawlTime) : NaN;
        const ok = !isNaN(lc) && lc >= lm;
        if (ok) lags.push((lc - lm) / 36e5);
        return {
          url: u.url,
          lastmod: u.lastmod!.slice(0, 10),
          lastCrawl: isNaN(lc) ? "" : r!.lastCrawlTime.slice(0, 16).replace("T", " "),
          status: !r || r.verdict === "ERROR" ? "Not inspected yet" : isNaN(lc) ? "Not crawled yet" : ok ? "Crawled after the change" : "Changed since last crawl",
          lagHours: ok ? Math.round((lc - lm) / 36e5) : null,
        };
      });
    lags.sort((a, b) => a - b);
    return {
      inspected: pages.length,
      buckets,
      pages: pages.sort((a, b) => (b.ageDays ?? 1e9) - (a.ageDays ?? 1e9)),
      mobile,
      desktop,
      waiting,
      notYet: waiting.filter((w) => w.status !== "Crawled after the change").length,
      medianLag: lags.length ? lags[Math.floor(lags.length / 2)] : null,
    };
  }, [cache]);

  return (
    <SourcesProvider value={merged}>
      <Section
        title="Googlebot crawl requests"
        source={crawlSource ? SRC : undefined}
        lede="How often Google crawls the site, split into Refresh (re-crawling pages Google already knows) and Discovery (crawling URLs for the first time)."
      >
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Where these numbers come from</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            <li>
              <strong>Google has no API for the Crawl stats report</strong>, so no app can read it directly. These counts come from the report's own
              export, imported here: exactly the numbers Search Console shows.
            </li>
            <li>
              <strong>Search Console keeps only the last 90 days.</strong> Each import is saved in this browser and merged by date, so importing every
              month or two builds a longer history here.
            </li>
            <li>
              <strong>It covers Google's crawlers only</strong> (Googlebot smartphone, desktop, image and so on), not other bots.
            </li>
          </ul>
        </div>

        <div className="panel">
          <PanelTitle>Import Crawl stats exports</PanelTitle>
          <p className="muted" style={{ marginTop: 0 }}>
            {HOW_TO_EXPORT}{" "}
            <a href={crawlStatsUrl(site)} target="_blank" rel="noreferrer">Open Crawl stats for this property</a>
          </p>
          <div className="row" style={{ alignItems: "center" }}>
            <input ref={fileRef} type="file" accept=".zip,.csv" multiple onChange={(e) => onFiles(e.target.files)} disabled={busy} aria-label="Choose Crawl stats export files" />
            {busy && <span className="muted">Reading files…</span>}
            {store && store.imports.length > 0 && !pending && <button className="btn" onClick={clearAll}>Delete imported crawl data</button>}
          </div>
          {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}

          {pending && (
            <div style={{ marginTop: 12 }}>
              <p style={{ margin: "0 0 8px" }}><b>Check what each file is, then save.</b> The type was guessed from the file name; change it if it's wrong.</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>This file is</th>
                      <th>Dates</th>
                      <th className="num">Days</th>
                      <th className="num">Crawl requests</th>
                      <th className="num">Example URLs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((p, i) => (
                      <tr key={`${p.file}-${i}`}>
                        <td className="url">{p.file}{p.note && <div className="muted">{p.note}</div>}</td>
                        <td>
                          <select
                            value={p.choice}
                            onChange={(e) => setPending((prev) => prev!.map((x, j) => (j === i ? { ...x, choice: e.target.value as SeriesKind } : x)))}
                          >
                            {KINDS.map((kd) => (
                              <option key={kd} value={kd}>{KIND_LABEL[kd]}</option>
                            ))}
                          </select>
                          {p.choice === "other" && (
                            <input
                              style={{ marginLeft: 6, width: 160 }}
                              value={p.otherLabel}
                              placeholder="e.g. OK (200)"
                              onChange={(e) => setPending((prev) => prev!.map((x, j) => (j === i ? { ...x, otherLabel: e.target.value } : x)))}
                              aria-label="Name of this breakdown"
                            />
                          )}
                        </td>
                        <td>{p.from ? `${p.from} to ${p.to}` : "–"}</td>
                        <td className="num">{num(Object.keys(p.days).length)}</td>
                        <td className="num">{num(p.total)}</td>
                        <td className="num">{num(p.urls.length)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary" onClick={confirmImport}>Save import</button>
                <button className="btn" onClick={() => setPending(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        {store && all.length === 0 && !pending && (
          <div className="notice" style={{ marginTop: 16 }}>No crawl data imported for this property yet. Import the Refresh and Discovery exports to start.</div>
        )}

        {all.length > 0 && (
          <>
            <div className="row" style={{ marginTop: 16, alignItems: "center" }}>
              <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                Show
                <select value={win} onChange={(e) => setWin(Number(e.target.value))}>
                  {WINDOWS.map(([d, label]) => (
                    <option key={d} value={d}>{label}</option>
                  ))}
                </select>
              </label>
              <span className="muted">
                Imported data covers {all[0].date} to {latest}. “Last N days” counts back from {latest}, the latest day imported.
              </span>
            </div>

            <div style={{ marginTop: 12 }}>
              <Kpis items={kpis} />
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>Crawl requests per day</PanelTitle>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={rows.map((r) => ({ date: r.date, refresh: r.refresh ?? undefined, discovery: r.discovery ?? undefined, total: r.total ?? undefined }))}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" fontSize={11} minTickGap={24} />
                  <YAxis fontSize={11} width={52} />
                  <Tooltip />
                  <Legend />
                  {hasSplit && <Area type="monotone" dataKey="refresh" name="Refresh" stackId="purpose" stroke="#4f6bd8" fill="#4f6bd8" fillOpacity={0.35} />}
                  {hasSplit && <Area type="monotone" dataKey="discovery" name="Discovery" stackId="purpose" stroke="#2ea36a" fill="#2ea36a" fillOpacity={0.45} />}
                  {(hasReportedTotal || !hasSplit) && <Line type="monotone" dataKey="total" name="All crawl requests" stroke="#374151" dot={false} strokeWidth={2} />}
                </ComposedChart>
              </ResponsiveContainer>
              {!hasSplit && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  Import both the Refresh and the Discovery exports to see the split.
                </p>
              )}
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>Daily detail</PanelTitle>
              <DataTable
                rows={[...rows].reverse()}
                cols={[
                  { key: "date", label: "Date" },
                  { key: "total", label: "Crawl requests", num: true, render: (r) => num(r.total) },
                  { key: "refresh", label: "Refresh", num: true, render: (r) => num(r.refresh) },
                  { key: "discovery", label: "Discovery", num: true, render: (r) => num(r.discovery) },
                  {
                    key: "date",
                    label: "Discovery share",
                    num: true,
                    render: (r) => (r.refresh != null && r.discovery != null && r.refresh + r.discovery ? pct(r.discovery / (r.refresh + r.discovery)) : "–"),
                  },
                  { key: "bytes", label: "Downloaded", num: true, render: (r) => mb(r.bytes) },
                  { key: "ms", label: "Avg. response", num: true, render: (r) => (r.ms == null ? "–" : `${num(r.ms)} ms`) },
                  { key: "totalFrom", label: "Total from" },
                ]}
                csvRow={(r) => ({
                  date: r.date, crawl_requests: r.total, refresh: r.refresh, discovery: r.discovery,
                  download_bytes: r.bytes, avg_response_ms: r.ms, total_from: r.totalFrom,
                })}
                initialSort="date"
                csvName={`crawl-requests-${latest}.csv`}
                source={SRC}
                empty="No days in this window."
              />
            </div>

            {others.length > 0 && (
              <div className="panel" style={{ marginTop: 16 }}>
                <PanelTitle source={SRC}>Other breakdowns imported</PanelTitle>
                <Bars items={others.map((o) => ({ label: o.label, value: o.requests, note: `${num(o.requests)} · ${num(o.days)} days` }))} />
              </div>
            )}

            {urlSeries && (
              <div className="panel" style={{ marginTop: 16 }}>
                <PanelTitle source={SRC}>Example crawled URLs (from the export; Google lists up to 1,000)</PanelTitle>
                {withUrls.length > 1 && (
                  <SubTabs value={urlSeries.key} onChange={setUrlView} options={withUrls.map((s) => ({ id: s.key, label: `${s.label} (${s.urls.length})` }))} />
                )}
                <DataTable
                  rows={urlSeries.urls}
                  cols={[{ key: "url", label: "URL", url: true }, { key: "when", label: "Crawled" }]}
                  csvName={`crawled-urls-${urlSeries.key.replace(/[^a-z0-9]+/gi, "-")}.csv`}
                  empty="No example URLs in this export."
                />
              </div>
            )}

            {store && store.imports.length > 0 && (
              <div className="panel" style={{ marginTop: 16 }}>
                <PanelTitle>Imports saved in this browser</PanelTitle>
                <DataTable
                  rows={[...store.imports].reverse().map((x) => ({ ...x, at: new Date(x.at).toLocaleString() }))}
                  cols={[
                    { key: "file", label: "File" },
                    { key: "label", label: "Type" },
                    { key: "from", label: "From" },
                    { key: "to", label: "To" },
                    { key: "days", label: "Days", num: true },
                    { key: "at", label: "Imported" },
                  ]}
                  pageSize={10}
                  empty="No imports yet."
                />
              </div>
            )}
          </>
        )}
      </Section>

      <Section
        title="How recently pages were crawled"
        source={recency ? ["client.indexScan"] : undefined}
        lede="From the URL Inspection results saved in this browser (Indexing tab and Live index monitor): the last time Googlebot crawled each inspected page. Updates automatically as more pages are inspected; it covers inspected pages only and shows the last crawl, not how many times."
      >
        {!recency || recency.inspected === 0 ? (
          <div className="notice">No inspected pages yet. Load the URL list and inspect pages in the Indexing tab, or start the Live index monitor.</div>
        ) : (
          <>
            <Kpis
              items={[
                { label: "Pages inspected", value: num(recency.inspected), source: ["client.indexScan"] },
                { label: "Crawled in the last 7 days", value: num(recency.buckets["Last 24 hours"] + recency.buckets["1–7 days"]), sub: pct((recency.buckets["Last 24 hours"] + recency.buckets["1–7 days"]) / recency.inspected, 0), source: ["client.indexScan"] },
                { label: "Not crawled in 90+ days", value: num(recency.buckets["Over 90 days"]), sub: `${num(recency.buckets["Never crawled"])} never crawled`, source: ["client.indexScan"] },
                { label: "Changed pages not yet recrawled", value: num(recency.notYet), sub: `of ${num(recency.waiting.length)} sitemap pages changed in 30 days`, source: ["client.indexScan"] },
                { label: "Typical time to crawl a change", value: recency.medianLag == null ? "–" : recency.medianLag < 48 ? `${num(recency.medianLag)} h` : `${num(recency.medianLag / 24)} days`, sub: "median, sitemap date → crawl", source: ["client.indexScan"] },
                { label: "Crawled as", value: `${num(recency.mobile)} / ${num(recency.desktop)}`, sub: "smartphone / desktop Googlebot", source: ["client.indexScan"] },
              ]}
            />
            <div className="grid-2" style={{ marginTop: 16 }}>
              <div className="panel">
                <PanelTitle source={["client.indexScan"]}>Last crawl, by age</PanelTitle>
                <Bars items={Object.entries(recency.buckets).map(([label, value]) => ({ label, value }))} />
              </div>
              <div className="panel">
                <PanelTitle source={["client.indexScan"]}>Changed in the sitemap (last 30 days)</PanelTitle>
                <DataTable
                  rows={recency.waiting}
                  cols={[
                    { key: "url", label: "URL", url: true },
                    { key: "lastmod", label: "Sitemap date" },
                    { key: "lastCrawl", label: "Last crawl" },
                    { key: "status", label: "Status" },
                    { key: "lagHours", label: "Hours to crawl", num: true, render: (r) => (r.lagHours == null ? "–" : num(r.lagHours)) },
                  ]}
                  initialSort="lastmod"
                  pageSize={10}
                  csvName="changed-pages-crawl-status.csv"
                  source={["client.indexScan"]}
                  empty="No sitemap pages with a date in the last 30 days."
                />
              </div>
            </div>
            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={["client.indexScan"]}>Pages by last crawl (oldest first)</PanelTitle>
              <DataTable
                rows={recency.pages}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "ageDays", label: "Days ago", num: true, render: (r) => (r.ageDays == null ? "never" : num(r.ageDays)) },
                  { key: "crawledAs", label: "Crawled as" },
                  { key: "state", label: "Index status" },
                ]}
                initialSort="ageDays"
                csvName="pages-by-last-crawl.csv"
                source={["client.indexScan"]}
              />
            </div>
          </>
        )}
      </Section>

      <Section
        title="Sitemaps: when Google last read them"
        source={sm?.sources ? ["gsc.sitemaps"] : undefined}
        lede="Sitemaps submitted in Search Console, from the Sitemaps API. Google re-reads sitemaps on its own schedule; a sitemap not read for weeks can slow down discovery of new pages."
      >
        {!sm && <p className="muted">Reading sitemaps…</p>}
        {sm?.error && <div className="notice error">{sm.error}</div>}
        {sm?.sitemaps && (
          <div className="panel">
            <DataTable
              rows={sm.sitemaps.map((s) => ({
                ...s,
                lastRead: s.lastDownloaded ? s.lastDownloaded.slice(0, 16).replace("T", " ") : "",
                ageDays: s.lastDownloaded ? Math.round((Date.now() - Date.parse(s.lastDownloaded)) / DAY) : null,
                type: s.isIndex ? "Index" : "Sitemap",
              }))}
              cols={[
                { key: "path", label: "Sitemap", url: true },
                { key: "type", label: "Type" },
                { key: "lastRead", label: "Last read by Google", render: (r) => (r.lastRead ? `${r.lastRead} (${ago(r.lastDownloaded)})` : "Not read yet") },
                { key: "submitted", label: "URLs submitted", num: true, render: (r) => num(r.submitted) },
                { key: "errors", label: "Errors", num: true },
                { key: "warnings", label: "Warnings", num: true },
                { key: "isPending", label: "Pending", render: (r) => (r.isPending ? "Yes" : "No") },
              ]}
              csvRow={(r) => ({
                sitemap: r.path, type: r.type, last_read_by_google: r.lastDownloaded, days_since_read: r.ageDays,
                urls_submitted: r.submitted, errors: r.errors, warnings: r.warnings, pending: r.isPending,
              })}
              initialSort="ageDays"
              csvName="sitemaps-last-read.csv"
              source={["gsc.sitemaps"]}
              empty="No sitemaps are submitted in Search Console for this property."
            />
          </div>
        )}
      </Section>
    </SourcesProvider>
  );
}
