// components/DeindexReport.tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SiteCheck, Source } from "@/lib/types";
import { loadIndexCache, saveIndexCache, flushIndexCache, IndexCache } from "@/lib/indexCache";
import { inspectBatch, siteBatch, runBatches, providerInfo, localDate, InspectionRec } from "@/lib/checks";
import {
  Snapshot, UrlCheck, Method, DeindexRow, compare, overall, listSnapshots, putSnapshot, deleteSnapshot,
  importSnapshots, snapshotId, inspectionStatus, siteStatus,
} from "@/lib/snapshots";
import { reportHtml, reportCsvRows, downloadFile, downloadJson, fileSafe } from "@/lib/evidence";
import { DataTable, Kpis, Section, SubTabs, SourcesProvider, useSources, num } from "./ui";

type View = "deindexed" | "possible" | "newly" | "all" | "history";
const LIMITS = [20, 50, 200, 500, 1000, 2000, 5000, 10000];

/* ---------- Evidence cell: both checks for one URL on one day ---------- */

function Evidence({ c }: { c?: UrlCheck }) {
  if (!c || (!c.inspection && !c.site)) return <span className="muted">Not checked</span>;
  const i = c.inspection, s = c.site;
  const iStatus = inspectionStatus(c), sStatus = siteStatus(c);
  const pill = (st: string) => (st === "indexed" ? "ok" : st === "not_indexed" ? "no" : "warn");
  return (
    <div>
      {i && (
        <div className="ev">
          <span className={`pill ${pill(iStatus)}`}>{i.verdict === "ERROR" ? "Inspection error" : iStatus === "indexed" ? "Indexed" : "Not indexed"}</span>{" "}
          {i.coverageState}
          <br />
          <span className="muted">
            URL Inspection {i.checkedAt ? new Date(i.checkedAt).toLocaleString() : ""}
            {i.lastCrawlTime ? `, last crawled ${i.lastCrawlTime.slice(0, 10)}` : ""}
          </span>
          {i.link && <> · <a href={i.link} target="_blank" rel="noreferrer">Search Console</a></>}
        </div>
      )}
      {s && (
        <div className="ev">
          <span className={`pill ${pill(sStatus)}`}>{s.status === "found" ? "site: indexed" : s.status === "not_found" ? "site: not indexed" : "site: inconclusive"}</span>{" "}
          {s.reason}
          <br />
          <span className="muted">
            {s.query} · {new Date(s.checkedAt).toLocaleString()}
          </span>
          <br />
          <a href={s.googleUrl} target="_blank" rel="noreferrer">Repeat on Google</a>
          {s.archiveUrl && <> · <a href={s.archiveUrl} target="_blank" rel="noreferrer">Saved results page</a></>}
        </div>
      )}
    </div>
  );
}

const confPill = (c: string) => (c === "Both checks agree" ? "no" : c === "Checks disagree" ? "warn" : "info");

/* ---------- Tab ---------- */

export default function DeindexReport({ site, onChange }: { site: string; onChange?: () => void }) {
  const parentSources = useSources();
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<{ provider: string | null; archives: boolean } | null>(null);
  const [methods, setMethods] = useState<Method[]>(["inspection", "site"]);
  // 0 = every known page
  const [limit, setLimit] = useState(0);
  const [progress, setProgress] = useState<{ inspection?: [number, number]; site?: [number, number] } | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [compareWith, setCompareWith] = useState<string>("");
  const [view, setView] = useState<View>("deindexed");
  const [listing, setListing] = useState(false);
  const stop = useRef(false);
  const snapRef = useRef<Snapshot | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listSnapshots(site);
      setSnaps(list);
      setLoaded(true);
      return list;
    } catch {
      setMsg({ text: "This browser blocked local storage (IndexedDB), so daily checks can't be saved. Private/incognito windows often do this.", error: true });
      setLoaded(true);
      return [];
    }
  }, [site]);

  useEffect(() => {
    setSelected("");
    setCompareWith("");
    setMsg(null);
    refresh();
  }, [refresh]);
  useEffect(() => { providerInfo().then((p) => { setProvider(p); if (!p.provider) setMethods(["inspection"]); }); }, []);

  const today = localDate();
  const todaySnap = snaps.find((s) => s.date === today) || null;
  const cur = snaps.find((s) => s.date === selected) || snaps[snaps.length - 1] || null;
  const earlier = cur ? snaps.filter((s) => s.date < cur.date) : [];
  const prev = earlier.find((s) => s.date === compareWith) || earlier[earlier.length - 1] || null;
  const report = useMemo(() => (cur ? compare(prev, cur) : null), [prev, cur]);

  /* ---------- Build today's list of pages ---------- */
  const candidates = (latestPrev: Snapshot | null, cache: IndexCache | null) => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (u: string) => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
    // Pages indexed at the last check come first: they are the ones that can drop out
    if (latestPrev) {
      Object.values(latestPrev.checks).filter((c) => inspectionStatus(c) === "indexed" || siteStatus(c) === "indexed").forEach((c) => add(c.url));
      Object.keys(latestPrev.checks).forEach(add);
    }
    if (cache) {
      Object.entries(cache.inspected).filter(([, r]) => r.verdict === "PASS" || r.verdict === "PARTIAL").forEach(([u]) => add(u));
      Object.entries(cache.site || {}).filter(([, r]) => r.status === "found").forEach(([u]) => add(u));
      cache.urls.filter((u) => u.sources.includes("search")).forEach((u) => add(u.url));
      cache.urls.forEach((u) => add(u.url));
    }
    return out;
  };

  const loadUrlList = async () => {
    setListing(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/gsc/sitemap-urls?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const c = await loadIndexCache(site);
      saveIndexCache(site, { urls: data.urls, sitemaps: data.sitemaps, inspected: c?.inspected || {}, site: c?.site || {}, listedAt: new Date().toISOString() }, true);
      onChange?.();
      setMsg({ text: `Loaded ${num(data.urls.length)} URLs from your sitemaps and search results. Run today's check to continue.` });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Could not load URLs", error: true });
    }
    setListing(false);
  };

  /* ---------- Run (or continue) today's check ---------- */
  const run = async (fresh = false) => {
    stop.current = false;
    setMsg(null);
    const list = await refresh();
    const latestPrev = [...list].filter((s) => s.date < today).pop() || null;
    const cache = await loadIndexCache(site);
    const existing = fresh ? null : list.find((s) => s.date === today) || null;
    const pool = candidates(latestPrev, cache);
    const planned = existing
      ? (limit ? Array.from(new Set([...existing.planned, ...pool])).slice(0, Math.max(limit, existing.planned.length)) : Array.from(new Set([...existing.planned, ...pool])))
      : limit ? pool.slice(0, limit) : pool;

    if (!planned.length) {
      setMsg({ text: "There are no pages to check yet. Load the URL list first.", error: true });
      return;
    }
    const now = new Date().toISOString();
    let snap: Snapshot = existing
      ? { ...existing, planned, methods: Array.from(new Set([...existing.methods, ...methods])) }
      : { id: snapshotId(site, today), site, date: today, startedAt: now, updatedAt: now, methods: [...methods], planned, checks: {} };
    snapRef.current = snap;
    await putSnapshot(snap);
    setSelected(today);
    setView("deindexed");

    const need = (m: Method) => planned.filter((u) => !(m === "inspection" ? snap.checks[u]?.inspection : snap.checks[u]?.site));
    const todoI = methods.includes("inspection") ? need("inspection") : [];
    const todoS = methods.includes("site") ? need("site") : [];
    if (!todoI.length && !todoS.length) {
      setMsg({ text: `All ${num(planned.length)} pages already have today's results. Raise the limit to check more pages, or use “Start today over”.` });
      await refresh();
      return;
    }
    setProgress({ inspection: todoI.length ? [0, todoI.length] : undefined, site: todoS.length ? [0, todoS.length] : undefined });

    // Merge results into today's snapshot and into the Indexing tab's saved results
    const merge = async (field: "inspection" | "site", results: (InspectionRec | SiteCheck)[]) => {
      const s = snapRef.current!;
      const checks = { ...s.checks };
      for (const r of results) {
        const bad = field === "inspection" ? (r as InspectionRec).verdict === "ERROR" : (r as SiteCheck).status === "error";
        const had = checks[r.url]?.[field];
        if (bad && had) continue;
        checks[r.url] = { ...(checks[r.url] || { url: r.url }), [field]: r };
      }
      snap = { ...s, checks, updatedAt: new Date().toISOString() };
      snapRef.current = snap;
      await putSnapshot(snap);
      const c = await loadIndexCache(site);
      if (c) {
        if (field === "inspection") results.forEach((r) => { if ((r as InspectionRec).verdict !== "ERROR") c.inspected[r.url] = r as InspectionRec; });
        else { c.site = c.site || {}; results.forEach((r) => { if ((r as SiteCheck).status !== "error") c.site![r.url] = r as SiteCheck; }); }
        saveIndexCache(site, c);
      }
      setSnaps((l) => [...l.filter((x) => x.id !== snap.id), snap].sort((a, b) => a.date.localeCompare(b.date)));
    };

    const notes: string[] = [];
    await Promise.all([
      todoI.length &&
        runBatches<InspectionRec>(todoI, (b) => inspectBatch(site, b), async (r, done) => {
          await merge("inspection", r);
          setProgress((p) => ({ ...p, inspection: [done, todoI.length] }));
        }, () => stop.current).then((r) => {
          if (r.quotaExceeded) notes.push("Google's URL Inspection quota for today is used up (about 2,000 per property). Continue tomorrow, or rely on the site: results.");
          if (r.error) notes.push(`URL Inspection: ${r.error}`);
        }),
      todoS.length &&
        runBatches<SiteCheck>(todoS, (b) => siteBatch(site, b), async (r, done) => {
          await merge("site", r);
          setProgress((p) => ({ ...p, site: [done, todoS.length] }));
        }, () => stop.current).then((r) => {
          if (r.quotaExceeded) notes.push(`Your ${provider?.provider || "search provider"} credits are used up.`);
          if (r.error) notes.push(`site: search: ${r.error}`);
        }),
    ]);
    setProgress(null);
    flushIndexCache(site);
    onChange?.();
    await refresh();
    if (stop.current) notes.push("Stopped. Results so far are saved; “Continue today's check” picks up where it left off.");
    setMsg(notes.length ? { text: notes.join(" "), error: true } : { text: latestPrev ? `Check complete. Compared with ${latestPrev.date}.` : "Check complete. This is the first saved check for this property, so it's the baseline: run it again on a later day to see which pages dropped out." });
  };

  const startOver = async () => {
    if (!todaySnap || !confirm("Delete today's results and check again from scratch?")) return;
    await deleteSnapshot(todaySnap.id);
    await run(true);
  };

  const removeDay = async (s: Snapshot) => {
    if (!confirm(`Delete the saved check for ${s.date}? This can't be undone unless you exported your history.`)) return;
    await deleteSnapshot(s.id);
    if (selected === s.date) setSelected("");
    await refresh();
  };

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      const list: Snapshot[] = Array.isArray(data) ? data : data.snapshots;
      const n = await importSnapshots(list.filter((s) => s.site === site));
      setMsg({ text: `Imported ${n} day(s) of history for this property.` });
      await refresh();
    } catch {
      setMsg({ text: "That file isn't a history export from this dashboard.", error: true });
    }
  };

  /* ---------- Provenance for this report ---------- */
  const localSources = useMemo(() => {
    if (!cur) return parentSources;
    const inspected = Object.values(cur.checks).filter((c) => c.inspection).length;
    const searched = Object.values(cur.checks).filter((c) => c.site).length;
    const providers = Array.from(new Set(Object.values(cur.checks).map((c) => c.site?.provider).filter(Boolean)));
    const src: Source = {
      id: "client.deindex",
      label: `Index check of ${cur.date}${prev ? ` compared with ${prev.date}` : ""}`,
      system: [inspected && "Google Search Console URL Inspection API", searched && `Google site: search via ${providers.join(", ")}`].filter(Boolean).join(" + ") || "No checks yet",
      endpoint: [inspected && "POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", searched && "site:<full URL> through the search provider"].filter(Boolean).join(" | "),
      request: { query: "site:<full page URL>", inspection: { inspectionUrl: "<each URL>", siteUrl: site } },
      fetchedAt: cur.updatedAt,
      rowCount: Object.keys(cur.checks).length,
      formula: `${inspected} page(s) inspected and ${searched} searched with site: on ${cur.date}. A page is “deindexed” when at least one check found it indexed on ${prev?.date || "the earlier day"} and a check on ${cur.date} found it not indexed; if today's two checks disagree it's listed as “possibly deindexed”. For site:, a page counts as indexed only when the FIRST result for site:<full URL> is that page (or the URL it redirects to; protocol, www and a trailing slash are ignored) and the page loads with HTTP 200, directly or through redirects. Timeouts, 403, 429 and 5xx are marked inconclusive, never deindexed.`,
      verifyHow: "Each row has its own evidence: “Search Console” opens Google's inspection of that URL, “Repeat on Google” reruns the same site: search, and “Saved results page” (SerpApi) shows the Google page exactly as it looked at the time of the check.",
    };
    return { ...parentSources, [src.id]: src };
  }, [cur, prev, parentSources, site]);
  const SRC = ["client.deindex"];

  const csvRow = (r: DeindexRow) => reportCsvRows([r], prev?.date || "", cur?.date || "")[0];
  const allRows = useMemo(
    () => (cur ? Object.values(cur.checks).map((c) => ({ url: c.url, status: overall(c), check: c, before: prev?.checks[c.url] })) : []),
    [cur, prev]
  );
  const statusLabel: Record<string, string> = { indexed: "Indexed", not_indexed: "Not indexed", conflict: "Checks disagree", unknown: "No result" };

  const rowCols = [
    { key: "url" as const, label: "Page", url: true },
    { key: "confidence" as const, label: "Confidence", render: (r: DeindexRow) => <span className={`pill ${confPill(r.confidence)}`}>{r.confidence}</span> },
    { key: "before" as const, label: `Before (${prev?.date || "–"})`, render: (r: DeindexRow) => <Evidence c={r.before} /> },
    { key: "now" as const, label: `Now (${cur?.date || "–"})`, render: (r: DeindexRow) => <Evidence c={r.now} /> },
  ];

  const running = !!progress;
  const pct = (p?: [number, number]) => (p ? `${(p[0] / p[1]) * 100}%` : "0%");

  return (
    <SourcesProvider value={localSources}>
      <Section
        title="Deindexed pages"
        source={cur ? SRC : undefined}
        lede="Run a check whenever you want a report — once a day is typical. Each run re-checks your pages with URL Inspection and a site: search, saves the results for that date, and compares them with the previous saved check to list pages that dropped out of Google's index. History is saved in this browser; export it to keep a copy."
      >
        <div className="panel">
          <div className="row">
            <button className="btn primary" onClick={() => run()} disabled={running || !loaded}>
              {todaySnap ? "Continue today's check" : "Run today's check"}
            </button>
            <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              Pages to check
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ minWidth: 150 }} disabled={running}>
                <option value={0}>All pages</option>
                {LIMITS.map((n) => <option key={n} value={n}>{num(n)}</option>)}
              </select>
            </label>
            <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={methods.includes("inspection")} disabled={running}
                onChange={(e) => setMethods((m) => (e.target.checked ? [...m, "inspection"] : m.filter((x) => x !== "inspection")))} />
              URL Inspection
            </label>
            <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }} title={provider?.provider ? `via ${provider.provider}` : "Add SERPAPI_KEY or SERPER_API_KEY to enable"}>
              <input type="checkbox" checked={methods.includes("site")} disabled={running || !provider?.provider}
                onChange={(e) => setMethods((m) => (e.target.checked ? [...m, "site"] : m.filter((x) => x !== "site")))} />
              site: search{provider?.provider ? ` (${provider.provider})` : " (not set up)"}
            </label>
            {running && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
            {todaySnap && !running && <button className="btn" onClick={startOver}>Start today over</button>}
            {!running && <button className="btn" onClick={loadUrlList} disabled={listing}>{listing ? "Reading sitemaps…" : "Reload URL list"}</button>}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Pages that were indexed at the last check are checked first. URL Inspection allows about 2,000 pages per property per day; when it runs out, the check stops and “Continue today's check” (or tomorrow's run) carries on. Each site: search uses one credit from your provider.
          </p>
          {progress && (
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              {progress.inspection && (
                <div><div className="progress"><div style={{ width: pct(progress.inspection) }} /></div>
                  <span className="muted">URL Inspection: {num(progress.inspection[0])} of {num(progress.inspection[1])}</span></div>
              )}
              {progress.site && (
                <div><div className="progress"><div style={{ width: pct(progress.site) }} /></div>
                  <span className="muted">site: search: {num(progress.site[0])} of {num(progress.site[1])}</span></div>
              )}
            </div>
          )}
          {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
        </div>

        {loaded && !snaps.length && !running && (
          <div className="notice" style={{ marginTop: 16 }}>
            No checks saved for this property yet. The first run becomes the baseline; from the second run on, you'll see which pages were deindexed since the previous check.
          </div>
        )}

        {cur && report && (
          <>
            <div className="panel" style={{ marginTop: 16 }}>
              <div className="row">
                <label className="control">
                  Report for
                  <select value={cur.date} onChange={(e) => { setSelected(e.target.value); setCompareWith(""); }}>
                    {[...snaps].reverse().map((s) => <option key={s.id} value={s.date}>{s.date}{s.date === today ? " (today)" : ""}</option>)}
                  </select>
                </label>
                <label className="control">
                  Compared with
                  <select value={prev?.date || ""} onChange={(e) => setCompareWith(e.target.value)} disabled={!earlier.length}>
                    {!earlier.length && <option value="">No earlier check</option>}
                    {[...earlier].reverse().map((s) => <option key={s.id} value={s.date}>{s.date}</option>)}
                  </select>
                </label>
                <div style={{ marginLeft: "auto" }} className="row">
                  <button className="btn" onClick={() => downloadFile(`deindexed-${fileSafe(site)}-${cur.date}.html`, reportHtml(prev, cur), "text/html")}>Download report</button>
                  <button className="btn" onClick={() => downloadJson(`index-evidence-${fileSafe(site)}-${cur.date}.json`, { property: site, generatedAt: new Date().toISOString(), comparedWith: prev, check: cur })}>Download raw evidence</button>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <Kpis
                items={[
                  { label: "Deindexed", value: prev ? num(report.deindexed.length) : "–", sub: prev ? `since ${prev.date}` : "baseline day", source: SRC },
                  { label: "Possibly deindexed", value: prev ? num(report.possible.length) : "–", sub: "checks disagree today", source: SRC },
                  { label: "Newly indexed", value: prev ? num(report.newlyIndexed.length) : "–", source: SRC },
                  { label: "Still indexed", value: prev ? num(report.stillIndexed) : "–", source: SRC },
                  { label: "Pages checked", value: `${num(Object.keys(cur.checks).length)} / ${num(cur.planned.length)}`, sub: "checked / planned", source: SRC },
                ]}
              />
              {prev && report.notRechecked > 0 && (
                <p className="muted">{num(report.notRechecked)} page(s) indexed on {prev.date} weren't checked on {cur.date}, so they aren't in this comparison. Raise “Pages to check” and continue to include them.</p>
              )}
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <SubTabs
                value={view}
                onChange={setView}
                options={[
                  { id: "deindexed", label: `Deindexed (${report.deindexed.length})` },
                  { id: "possible", label: `Possibly deindexed (${report.possible.length})` },
                  { id: "newly", label: `Newly indexed (${report.newlyIndexed.length})` },
                  { id: "all", label: `All pages checked (${allRows.length})` },
                  { id: "history", label: `History (${snaps.length} day${snaps.length === 1 ? "" : "s"})` },
                ]}
              />
              {view === "deindexed" && (
                <DataTable key="d" rows={report.deindexed} cols={rowCols} csvRow={csvRow} source={SRC}
                  csvName={`deindexed-${cur.date}.csv`} initialSort="confidence" initialDesc={false}
                  empty={prev ? `No page that was indexed on ${prev.date} is missing on ${cur.date}.` : "This is the baseline check. Run another check on a later day to see changes."} />
              )}
              {view === "possible" && (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>These pages were indexed on {prev?.date || "the earlier day"}, but today URL Inspection and site: search disagree. Re-check before reporting them.</p>
                  <DataTable key="p" rows={report.possible} cols={rowCols} csvRow={csvRow} source={SRC} csvName={`possibly-deindexed-${cur.date}.csv`} empty="None." />
                </>
              )}
              {view === "newly" && (
                <DataTable key="n" rows={report.newlyIndexed} cols={rowCols} csvRow={csvRow} source={SRC} csvName={`newly-indexed-${cur.date}.csv`} empty="No newly indexed pages." />
              )}
              {view === "all" && (
                <DataTable
                  key="a"
                  rows={allRows}
                  cols={[
                    { key: "url", label: "Page", url: true },
                    { key: "status", label: "Today", render: (r) => <span className={`pill ${r.status === "indexed" ? "ok" : r.status === "not_indexed" ? "no" : "warn"}`}>{statusLabel[r.status]}</span> },
                    { key: "check", label: `Evidence (${cur.date})`, render: (r) => <Evidence c={r.check} /> },
                    { key: "before", label: `Before (${prev?.date || "–"})`, render: (r) => <Evidence c={r.before} /> },
                  ]}
                  csvRow={(r) => ({ ...reportCsvRows([{ url: r.url, confidence: statusLabel[r.status] as any, before: r.before || { url: r.url }, now: r.check }], prev?.date || "", cur.date)[0], today: statusLabel[r.status] })}
                  source={SRC}
                  csvName={`index-check-${cur.date}.csv`}
                  initialSort="status"
                />
              )}
              {view === "history" && (
                <>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <button className="btn" onClick={() => downloadJson(`index-history-${fileSafe(site)}-${today}.json`, { property: site, exportedAt: new Date().toISOString(), snapshots: snaps })}>Export history</button>
                    <button className="btn" onClick={() => fileInput.current?.click()}>Import history</button>
                    <input ref={fileInput} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
                    <span className="muted">History lives in this browser only. Export it regularly, and import it to move to another computer.</span>
                  </div>
                  <DataTable
                    key="h"
                    rows={[...snaps].reverse().map((s, i, arr) => {
                      const before = arr[i + 1] || null;
                      const r = compare(before, s);
                      return {
                        date: s.date, pages: Object.keys(s.checks).length, methods: s.methods.map((m) => (m === "inspection" ? "URL Inspection" : "site:")).join(" + "),
                        deindexed: before ? r.deindexed.length : null, possible: before ? r.possible.length : null, newly: before ? r.newlyIndexed.length : null,
                        vs: before?.date || "baseline", snap: s,
                      };
                    })}
                    cols={[
                      { key: "date", label: "Date" },
                      { key: "vs", label: "Compared with" },
                      { key: "pages", label: "Pages checked", num: true, render: (r) => num(r.pages) },
                      { key: "methods", label: "Checks" },
                      { key: "deindexed", label: "Deindexed", num: true, render: (r) => (r.deindexed == null ? "–" : num(r.deindexed)) },
                      { key: "possible", label: "Possibly", num: true, render: (r) => (r.possible == null ? "–" : num(r.possible)) },
                      { key: "newly", label: "Newly indexed", num: true, render: (r) => (r.newly == null ? "–" : num(r.newly)) },
                      {
                        key: "snap", label: "", render: (r) => (
                          <span className="row" style={{ gap: 6 }}>
                            <button className="btn small" onClick={() => { setSelected(r.date); setCompareWith(""); setView("deindexed"); }}>View</button>
                            <button className="btn small" onClick={() => removeDay(r.snap)}>Delete</button>
                          </span>
                        ),
                      },
                    ]}
                    csvRow={(r) => ({ date: r.date, compared_with: r.vs, pages_checked: r.pages, checks: r.methods, deindexed: r.deindexed ?? "", possibly_deindexed: r.possible ?? "", newly_indexed: r.newly ?? "" })}
                    csvName="index-check-history.csv"
                    initialSort="date"
                  />
                </>
              )}
            </div>
          </>
        )}
      </Section>
    </SourcesProvider>
  );
}
