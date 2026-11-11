// components/CrawlActivity.tsx
"use client";
// How often Google crawls the site. Exact daily counts come from Search Console's Crawl stats report (there is no API
// for it), sent by the "Copy crawl stats" bookmark or imported from its export, and kept in shared storage so everyone
// sees the same numbers. Per-page crawl recency comes from saved URL Inspection results; sitemap reads from the Sitemaps API.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Source, Sources } from "@/lib/types";
import { loadIndexCache, type IndexCache } from "@/lib/indexCache";
import { addDays } from "@/lib/dates";
import {
  HOW_TO_EXPORT, KIND_LABEL, applyImport, clearCrawl, crawlStatsUrl, dailyRows, loadCrawl, parseCrawlFiles, saveCrawl,
  type CrawlImport, type CrawlStore, type ParsedCrawl, type SeriesKind,
} from "@/lib/crawlStats";
import { parseCapture } from "@/lib/crawlCapture";
import CrawlPaste from "./CrawlPaste";
import { Bars, DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, num, pct, useSources, type KpiItem } from "./ui";

type Pending = ParsedCrawl & { choice: SeriesKind; otherLabel: string };
type SitemapRow = {
  path: string; lastDownloaded: string; lastSubmitted: string; isPending: boolean; isIndex: boolean;
  errors: number; warnings: number; submitted: number | null;
};
type SitemapResp = { sitemaps?: SitemapRow[]; sources?: Sources; error?: string };

const WINDOWS: [number, string][] = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [0, "Everything saved"]];
const KINDS: SeriesKind[] = ["refresh", "discovery", "total", "other"];
const SRC = ["client.crawlImport"];
const DAY = 864e5;
const empty = (): CrawlStore => ({ series: {}, imports: [] });

const ago = (iso: string) => {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (isNaN(t)) return "–";
  const d = (Date.now() - t) / DAY;
  return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};
const mb = (b: number | null) => (b == null ? "–" : `${(b / 1e6).toFixed(1)} MB`);

export default function CrawlActivity({
  site, inbox, waiting, onInboxHandled,
}: { site: string; inbox?: string | null; waiting?: boolean; onInboxHandled?: () => void }) {
  const outer = useSources();
  const [store, setStore] = useState<CrawlStore | null>(null);
  const [shared, setShared] = useState<boolean | null>(null);
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState(30);
  const [cache, setCache] = useState<IndexCache | null>(null);
  const [sm, setSm] = useState<SitemapResp | null>(null);
  const [urlView, setUrlView] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const handledInbox = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setStore(null);
    setShared(null);
    setPending(null);
    setMsg(null);
    setCache(null);
    setSm(null);
    (async () => {
      try {
        const r = await fetch(`/api/crawl?site=${encodeURIComponent(site)}`, { cache: "no-store" });
        if (r.status === 501) {
          const local = await loadCrawl(site);
          if (live) { setShared(false); setStore(local); }
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        if (live) { setShared(true); setStore(j.store || empty()); }
      } catch (e) {
        if (live) {
          setShared(false);
          setStore(await loadCrawl(site));
          setMsg({ text: `Couldn't reach shared storage (${e instanceof Error ? e.message : "error"}). Showing data saved in this browser.`, error: true });
        }
      }
    })();
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

  /* ---------- Saving (shared storage, or this browser if it isn't set up) ---------- */

  const saveItems = useCallback(
    async (items: ParsedCrawl[]) => {
      if (shared) {
        const res = await fetch("/api/crawl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site, series: items.map((p) => ({ kind: p.kind, label: p.label, days: p.days, urls: p.urls, source: p.file })) }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `Saving failed (${res.status})`);
        setStore(j.store);
      } else {
        let s = store || empty();
        for (const p of items) s = applyImport(s, p, p.kind, p.label);
        await saveCrawl(site, s);
        setStore(s);
      }
    },
    [shared, site, store]
  );

  const addPending = (list: ParsedCrawl[]) =>
    setPending((prev) => [...(prev || []), ...list.map((p) => ({ ...p, choice: p.kind, otherLabel: p.label }))]);

  /** Data from the bookmark (new tab) or pasted: saved straight away when the numbers check out. */
  const handleCapture = useCallback(
    async (text: string) => {
      setMsg(null);
      try {
        const res = parseCapture(text, site);
        if (res.verified) {
          await saveItems(res.items);
          setMsg({ text: `${res.summary} Saved${shared ? " for everyone" : " in this browser"}.` });
        } else {
          addPending(res.items);
          setMsg({
            text: `${res.summary} Check the numbers in “Update crawl stats” at the bottom of this page against Search Console, then click Save.`,
            error: true,
          });
        }
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : "Couldn't read the crawl data", error: true });
      }
    },
    [site, saveItems, shared]
  );

  useEffect(() => {
    if (!inbox || shared === null || !store || handledInbox.current === inbox) return;
    handledInbox.current = inbox;
    handleCapture(inbox).finally(() => onInboxHandled?.());
  }, [inbox, shared, store, handleCapture, onInboxHandled]);

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const { parsed, skipped } = await parseCrawlFiles(Array.from(list));
      const usable = parsed.filter((p) => Object.keys(p.days).length || p.urls.length);
      if (!usable.length) throw new Error(`No Crawl stats data was found in these files. ${HOW_TO_EXPORT}`);
      addPending(usable);
      if (skipped.length) setMsg({ text: `Skipped ${skipped.join(", ")}: only ZIP and CSV files are read.` });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Couldn't read the files", error: true });
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const confirmImport = async () => {
    if (!pending) return;
    try {
      await saveItems(
        pending.map((p) => ({ ...p, kind: p.choice, label: p.choice === "other" ? p.otherLabel.trim() || p.file : KIND_LABEL[p.choice] }))
      );
      setMsg({ text: `Saved ${pending.length} item(s)${shared ? " for everyone" : " in this browser"}. Days already saved were updated with the newer numbers.` });
      setPending(null);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Saving failed", error: true });
    }
  };

  const clearAll = async () => {
    if (!confirm(shared ? "Delete the crawl data saved for this property, for everyone?" : "Delete the crawl data saved for this property in this browser?")) return;
    try {
      if (shared) {
        const r = await fetch(`/api/crawl?site=${encodeURIComponent(site)}`, { method: "DELETE" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Delete failed (${r.status})`);
      } else await clearCrawl(site);
      setStore(empty());
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Delete failed", error: true });
    }
  };

  /* ---------- Saved crawl counts ---------- */

  const all = useMemo(() => (store ? dailyRows(store) : []), [store]);
  const latest = all.length ? all[all.length - 1].date : "";
  const rows = useMemo(() => (win && latest ? all.filter((r) => r.date > addDays(latest, -win)) : all), [all, win, latest]);
  const hasSplit = !!store?.series.refresh && !!store?.series.discovery;
  const hasReportedTotal = !!store?.series.total;
  const lastSaved = store?.imports.length ? store.imports[store.imports.length - 1] : null;

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
    const bytes = sum(rows.filter((r) => r.bytes != null), (r) => r.bytes);
    const cut7 = latest ? addDays(latest, -7) : "";
    const cut14 = latest ? addDays(latest, -14) : "";
    const last7 = all.filter((r) => r.total != null && r.date > cut7);
    const prev7 = all.filter((r) => r.total != null && r.date <= cut7 && r.date > cut14);
    return {
      total, days: withTotal.length, avg: withTotal.length ? total / withTotal.length : 0,
      ref, dis, splitDays: both.length, peak, ms, bytes,
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
          label: "Crawl stats from Search Console",
          system: `Google Search Console Crawl stats report (copied by the bookmark or imported from its export; saved ${shared ? "in shared storage" : "in this browser"})`,
          range: { startDate: all[0].date, endDate: latest },
          fetchedAt: lastSaved?.at || new Date().toISOString(),
          rowCount: all.length,
          formula:
            `Daily counts from the report's chart data, merged by date (newer data wins). ` +
            `Saved: ${Object.values(store.series).map((s) => `${s.label} (${Object.keys(s.days).length} days)`).join(", ")}. ` +
            `Bookmark data is saved automatically only when Refresh + Discovery equals All crawl requests on at least 95% of days. ` +
            `Every Googlebot crawl is either Refresh or Discovery, so when no “All crawl requests” data was saved, the daily total is Refresh + Discovery.`,
          verifyUrl: crawlStatsUrl(site),
          verifyLabel: "Open Crawl stats in Search Console",
          verifyHow:
            "Search Console → Settings → Crawl stats → Open report. Hover a day on the chart for its total crawl requests; under “By purpose” open Refresh or Discovery for those lines. Search Console keeps only the last 90 days.",
        }
      : null;

  const merged = useMemo<Sources>(
    () => ({ ...outer, ...(sm?.sources || {}), ...(crawlSource ? { [crawlSource.id]: crawlSource } : {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outer, sm, store, latest, shared]
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
      sub: k.splitDays ? `${pct(k.ref / (k.ref + k.dis || 1), 0)} · re-crawls of known pages` : "not captured yet",
      source: SRC,
    },
    {
      label: "Discovery",
      value: k.splitDays ? num(k.dis) : "–",
      sub: k.splitDays ? `${pct(k.dis / (k.ref + k.dis || 1), 0)} · first crawls of new URLs` : "not captured yet",
      source: SRC,
    },
    { label: "Busiest day", value: k.peak ? num(k.peak.total) : "–", sub: k.peak?.date, source: SRC },
  ];
  if (k.bytes) kpis.push({ label: "Downloaded", value: `${(k.bytes / 1e9).toFixed(2)} GB`, sub: "total download size", source: SRC });
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
    const lags: number[] = [];
    const waitingPages = cache.urls
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
      waiting: waitingPages,
      notYet: waitingPages.filter((w) => w.status !== "Crawled after the change").length,
      medianLag: lags.length ? lags[Math.floor(lags.length / 2)] : null,
    };
  }, [cache]);

  /** Bookmark, paste and export steps: shown open until data is saved, folded away under "How to update" after that. */
  const howTo = (
    <>
      <CrawlPaste statsUrl={crawlStatsUrl(site)} onText={handleCapture} />

      <details style={{ marginTop: 14 }}>
        <summary className="muted">Or import Search Console export files</summary>
        <p className="muted">{HOW_TO_EXPORT}</p>
        <div className="row" style={{ alignItems: "center" }}>
          <input ref={fileRef} type="file" accept=".zip,.csv" multiple onChange={(e) => onFiles(e.target.files)} disabled={busy} aria-label="Choose Crawl stats export files" />
          {busy && <span className="muted">Reading files…</span>}
        </div>
      </details>
    </>
  );

  return (
    <SourcesProvider value={merged}>
      <Section
        title="Googlebot crawl requests"
        source={crawlSource ? SRC : undefined}
        lede="How often Google crawls the site, split into Refresh (re-crawling pages Google already knows) and Discovery (crawling URLs for the first time)."
      >
        {waiting && !inbox && <div className="notice" style={{ marginBottom: 16 }}>Collecting crawl stats from Search Console… this tab updates in a few seconds.</div>}
        {msg && <p className={msg.error ? "notice error" : "notice"} style={{ marginTop: 0 }}>{msg.text}</p>}
        {shared === false && (
          <div className="notice error" style={{ marginBottom: 16 }}>
            Shared storage isn't set up, so crawl data is saved only in this browser and other people (for example your CEO) won't see it.
            Add Upstash Redis in Vercel → Storage, connect it to this project and redeploy.
          </div>
        )}
        {lastSaved && (
          <p className="muted" style={{ marginTop: 0 }}>
            Last updated {new Date(lastSaved.at).toLocaleString()} ({ago(lastSaved.at)}){(lastSaved as CrawlImport & { by?: string }).by ? ` by ${(lastSaved as CrawlImport & { by?: string }).by}` : ""}
            {shared ? " · saved for everyone" : ""}.
          </p>
        )}

        <details className="notice" style={{ marginBottom: 16 }}>
          <summary>
            <strong>Where these numbers come from</strong>
          </summary>
          <ul style={{ margin: "0", paddingLeft: 18 }}>
            <li>
              <strong>Google has no API for the Crawl stats report</strong>, so no app can fetch it on its own. Someone signed in to Search Console
              clicks the “Copy crawl stats” bookmark on the report (about once a week), and the numbers are saved here for everyone. They are
              exactly what Search Console shows, and they're only saved automatically when Refresh + Discovery equals the total for each day.
            </li>
            <li>
              <strong>Search Console keeps only the last 90 days.</strong> Each update is merged by date, so the history here grows beyond 90 days.
            </li>
            <li>
              <strong>It covers Google's crawlers only</strong> (Googlebot smartphone, desktop, image and so on), not other bots.
            </li>
          </ul>
        </details>

        {store && all.length === 0 && !pending && (
          <div className="notice">
            No crawl data saved for this property yet. Follow the steps in “Update crawl stats” at the bottom of this page.
          </div>
        )}

        {all.length > 0 && (
          <>
            <div className="row" style={{ alignItems: "center" }}>
              <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                Show
                <select value={win} onChange={(e) => setWin(Number(e.target.value))}>
                  {WINDOWS.map(([d, label]) => (
                    <option key={d} value={d}>{label}</option>
                  ))}
                </select>
              </label>
              <span className="muted">
                Saved data covers {all[0].date} to {latest}. “Last N days” counts back from {latest}, the latest day saved.
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
                <PanelTitle source={SRC}>Other breakdowns saved</PanelTitle>
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
                  empty="No example URLs saved."
                />
              </div>
            )}
          </>
        )}
      </Section>

      <Section
        title="How recently pages were crawled"
        source={recency ? ["client.indexScan"] : undefined}
        lede="From the URL Inspection results saved in this browser: the last time Googlebot crawled each inspected page. It covers inspected pages only and shows the last crawl, not how many times."
      >
        {!recency || recency.inspected === 0 ? (
          <div className="notice">No inspected pages saved in this browser yet.</div>
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
        lede="Sitemaps submitted in Search Console, from the Sitemaps API (updates automatically). Google re-reads sitemaps on its own schedule; a sitemap not read for weeks can slow down discovery of new pages."
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

      <Section title="Update crawl stats">
        <div className="panel">
          {all.length > 0 && !pending ? (
            <details>
              <summary>How to update</summary>
              <div style={{ marginTop: 8 }}>{howTo}</div>
            </details>
          ) : (
            howTo
          )}

          {store && store.imports.length > 0 && !pending && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={clearAll}>Delete saved crawl data</button>
            </div>
          )}

          {pending && (
            <div style={{ marginTop: 14 }}>
              <p style={{ margin: "0 0 8px" }}>
                <b>Check each item, then save.</b> Change the type if it's wrong.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>This is</th>
                      <th>Dates</th>
                      <th className="num">Days</th>
                      <th className="num">Crawl requests</th>
                      <th className="num">Example URLs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((p, i) => (
                      <tr key={`${p.file}-${i}`}>
                        <td className="url">
                          {p.file}
                          {p.note && <div className="muted">{p.note}</div>}
                        </td>
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
                <button className="btn primary" onClick={confirmImport}>Save</button>
                <button className="btn" onClick={() => setPending(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </Section>
    </SourcesProvider>
  );
}
