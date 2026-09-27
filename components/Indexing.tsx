// components/Indexing.tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SiteCheck } from "@/lib/types";
import { loadIndexCache, saveIndexCache, flushIndexCache, clearIndexCache, classify, IndexCache, SiteCell } from "@/lib/indexCache";
import { inspectBatch, siteBatch, runBatches, providerInfo, InspectionRec } from "@/lib/checks";
import { DataTable, Kpis, Section, SubTabs, Bars, PanelTitle, num } from "./ui";

type V = "not" | "indexed" | "unchecked" | "disagree" | "errors";
const SRC = ["client.indexScan"];

export function SiteResult({ cell }: { cell: SiteCell }) {
  if (!cell) return <span className="muted">Not run</span>;
  const cls = cell.status === "found" ? "ok" : cell.status === "not_found" ? "no" : "warn";
  const label = cell.status === "found" ? "Indexed" : cell.status === "not_found" ? "Not indexed" : "Inconclusive";
  return (
    <div className="ev">
      <span className={`pill ${cls}`}>{label}</span>{" "}
      <span className="muted">{cell.reason}</span>
      <br />
      <a href={cell.googleUrl} target="_blank" rel="noreferrer">Repeat on Google</a>
      {cell.archiveUrl && <> · <a href={cell.archiveUrl} target="_blank" rel="noreferrer">Saved page</a></>}
    </div>
  );
}

export default function Indexing({ site, onChange }: { site: string; onChange?: () => void }) {
  const [cache, setCache] = useState<IndexCache | null>(null);
  const [listing, setListing] = useState(false);
  const [scan, setScan] = useState<{ what: string; done: number; total: number } | null>(null);
  // 0 = every URL in the list (the sitemap can hold tens of thousands)
  const [limit, setLimit] = useState(0);
  const cap = <T,>(list: T[]) => (limit ? list.slice(0, limit) : list);
  const [includeSeen, setIncludeSeen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [view, setView] = useState<V>("not");
  const [provider, setProvider] = useState<{ provider: string | null; archives: boolean } | null>(null);
  const stop = useRef(false);
  const cacheRef = useRef<IndexCache | null>(null);

  useEffect(() => {
    let live = true;
    setCache(null);
    cacheRef.current = null;
    setMsg(null);
    loadIndexCache(site).then((c) => {
      if (!live) return;
      setCache(c);
      cacheRef.current = c;
    });
    return () => { live = false; flushIndexCache(site); };
  }, [site]);
  useEffect(() => { providerInfo().then(setProvider); }, []);

  const update = (c: IndexCache) => {
    cacheRef.current = c;
    setCache(c);
    saveIndexCache(site, c);
    onChange?.();
  };

  const loadUrls = async () => {
    setListing(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/gsc/sitemap-urls?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      update({ urls: data.urls, sitemaps: data.sitemaps, inspected: cache?.inspected || {}, site: cache?.site || {}, listedAt: new Date().toISOString() });
      flushIndexCache(site);
      const fromMaps = data.urls.filter((u: any) => u.sources.includes("sitemap")).length;
      setMsg({
        text: `Found ${num(data.urls.length)} URLs: ${num(fromMaps)} from ${data.sitemaps.length} sitemap file(s), the rest from search results.` +
          (data.errors.length ? ` ${data.errors.length} sitemap(s) could not be read: ${data.errors.map((e: any) => `${e.sitemap} (${e.error})`).join(", ")}.` : ""),
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Could not load URLs", error: true });
    }
    setListing(false);
  };

  const inspect = async (urls: string[]) => {
    if (!cacheRef.current || !urls.length) return;
    stop.current = false;
    setMsg(null);
    setScan({ what: "URL Inspection", done: 0, total: urls.length });
    const r = await runBatches<InspectionRec>(
      urls,
      (b) => inspectBatch(site, b),
      (results, done) => {
        const c = cacheRef.current!;
        const inspected = { ...c.inspected };
        results.forEach((x) => { if (x.verdict !== "ERROR" || !inspected[x.url]) inspected[x.url] = x; });
        update({ ...c, inspected });
        setScan({ what: "URL Inspection", done, total: urls.length });
      },
      () => stop.current
    );
    flushIndexCache(site);
    if (r.quotaExceeded) setMsg({ text: "Google's daily URL Inspection quota for this property is used up (about 2,000 checks a day). Results so far are saved; click “Inspect in Search Console” again tomorrow and it continues with the pages not yet checked.", error: true });
    else if (r.error) setMsg({ text: r.error, error: true });
    setScan(null);
  };

  const searchSite = async (urls: string[]) => {
    if (!cacheRef.current || !urls.length) return;
    stop.current = false;
    setMsg(null);
    setScan({ what: "site: search", done: 0, total: urls.length });
    const r = await runBatches<SiteCheck>(
      urls,
      (b) => siteBatch(site, b),
      (results, done) => {
        const c = cacheRef.current!;
        const s = { ...(c.site || {}) };
        results.forEach((x) => { if (x.status !== "error" || !s[x.url]) s[x.url] = x; });
        update({ ...c, site: s });
        setScan({ what: "site: search", done, total: urls.length });
      },
      () => stop.current
    );
    flushIndexCache(site);
    if (r.quotaExceeded) setMsg({ text: `Your ${provider?.provider || "search provider"} credits are used up. Results so far are saved.`, error: true });
    else if (r.error) setMsg({ text: r.error, error: true });
    setScan(null);
  };

  const result = useMemo(() => (cache ? classify(cache) : null), [cache]);

  const queueNext = () => {
    if (!cache) return;
    const pending = cache.urls.filter((u) => !cache.inspected[u.url] && (includeSeen || !u.sources.includes("search")));
    inspect(cap(pending).map((u) => u.url));
  };
  const recheckNot = () => result && inspect(cap(result.notIndexed.filter((r) => r.how === "URL Inspection")).map((r) => r.url));

  /** site: search runs on the list currently on screen, skipping URLs already searched today. */
  const today = new Date().toDateString();
  const viewUrls = (): string[] => {
    if (!result) return [];
    const list = view === "not" ? result.notIndexed : view === "indexed" ? result.indexed : view === "unchecked" ? result.unchecked : view === "disagree" ? result.disagree : [];
    return list.map((r) => r.url).filter((u) => {
      const s = cache?.site?.[u];
      return !s || new Date(s.checkedAt).toDateString() !== today;
    });
  };
  const viewName = { not: "not indexed", indexed: "indexed", unchecked: "not checked", disagree: "disagreeing", errors: "" }[view];

  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    result?.notIndexed.forEach((r) => m.set(r.state, (m.get(r.state) || 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }, [result]);

  const openLink = (link: string) => (link ? <a href={link} target="_blank" rel="noreferrer">Open in Search Console</a> : "");
  const siteFound = result ? Object.values(cache?.site || {}).filter((s) => s.status === "found").length : 0;
  const siteRun = Object.keys(cache?.site || {}).length;

  return (
    <Section
      title="Indexed and unindexed pages"
      source={cache ? SRC : undefined}
      lede="This tab collects URLs from your sitemaps and search results, then checks each one two ways: Google's URL Inspection API (Search Console's own record) and a site: search (site: followed by the full URL — indexed only if the first result is the page and the page loads with HTTP 200, directly or through redirects). Pages that earned impressions count as indexed until checked. Results are saved in this browser."
    >
      <div className="panel">
        <div className="row">
          <button className="btn primary" onClick={loadUrls} disabled={listing || !!scan}>
            {listing ? "Reading sitemaps…" : cache ? "Reload URL list" : "Load URL list"}
          </button>
          <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            Check up to
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ minWidth: 150 }}>
              <option value={0}>All{cache ? ` (${num(cache.urls.length)})` : ""}</option>
              {[20, 50, 200, 500, 1000, 2000, 5000, 10000].map((n) => <option key={n} value={n}>{num(n)}</option>)}
            </select>
            URLs
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeSeen} onChange={(e) => setIncludeSeen(e.target.checked)} />
            Also inspect pages that already have impressions
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={queueNext} disabled={!cache?.urls.length || !!scan}>Inspect in Search Console</button>
          <button className="btn" onClick={recheckNot} disabled={!result?.notIndexed.length || !!scan}>Re-inspect unindexed</button>
          <button
            className="btn"
            onClick={() => searchSite(cap(viewUrls()))}
            disabled={!provider?.provider || !result || !!scan || view === "errors"}
            title={provider?.provider ? `Runs site:<url> through ${provider.provider}` : "Add SERPAPI_KEY or SERPER_API_KEY to enable"}
          >
            Run site: search on {viewName || "this list"}
          </button>
          {scan && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {cache && !scan && (
            <button className="btn" onClick={async () => { await clearIndexCache(site); setCache(null); cacheRef.current = null; onChange?.(); }}>Clear saved results</button>
          )}
        </div>
        {provider && !provider.provider && (
          <p className="muted" style={{ marginBottom: 0 }}>
            site: search is off. Add <code>SERPAPI_KEY</code> (keeps a saved copy of each Google results page as evidence) or <code>SERPER_API_KEY</code> to your environment variables and redeploy.
          </p>
        )}
        {scan && (
          <div style={{ marginTop: 12 }}>
            <div className="progress"><div style={{ width: `${(scan.done / scan.total) * 100}%` }} /></div>
            <p className="muted">{scan.what}: checked {num(scan.done)} of {num(scan.total)}</p>
          </div>
        )}
        {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
        {cache && <p className="muted" style={{ marginBottom: 0 }}>URL list loaded {new Date(cache.listedAt).toLocaleString()}.</p>}
      </div>

      {!cache && <div className="notice" style={{ marginTop: 16 }}>Load the URL list to start. “All” checks every URL from your sitemaps. URL Inspection allows about 2,000 URLs per property per day, so large sites take several days: each run continues with the pages not yet checked. Each site: search uses one credit from your search provider.</div>}

      {result && (
        <>
          <div style={{ marginTop: 16 }}>
            <Kpis
              items={[
                { label: "Known URLs", value: num(result.total), source: SRC },
                { label: "Indexed", value: num(result.indexed.length), sub: `${num(result.indexed.filter((r) => r.how === "URL Inspection").length)} confirmed by URL Inspection`, source: SRC },
                { label: "Not indexed", value: num(result.notIndexed.length), source: SRC },
                { label: "Found with site:", value: siteRun ? `${num(siteFound)} / ${num(siteRun)}` : "–", sub: siteRun ? "found / searched" : "not run yet", source: SRC },
                { label: "Checks disagree", value: num(result.disagree.length), source: SRC },
                { label: "Not checked yet", value: num(result.unchecked.length) },
              ]}
            />
          </div>
          {reasons.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>Why pages aren't indexed</PanelTitle>
              <Bars items={reasons} color="var(--down)" />
            </div>
          )}
          <div className="panel" style={{ marginTop: 16 }}>
            <SubTabs
              value={view}
              onChange={setView}
              options={[
                { id: "not", label: `Not indexed (${result.notIndexed.length})` },
                { id: "indexed", label: `Indexed (${result.indexed.length})` },
                { id: "unchecked", label: `Not checked (${result.unchecked.length})` },
                { id: "disagree", label: `Checks disagree (${result.disagree.length})` },
                { id: "errors", label: `Errors (${result.errors.length})` },
              ]}
            />
            {view === "not" && (
              <DataTable
                rows={result.notIndexed}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "state", label: "Reason", render: (r) => <span className="pill no">{r.state}</span> },
                  { key: "how", label: "Checked by" },
                  { key: "site", label: "site: search", render: (r) => <SiteResult cell={r.siteCell} /> },
                  { key: "inSitemap", label: "In sitemap" },
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "checkedAt", label: "Inspected" },
                  { key: "link", label: "", render: (r) => openLink(r.link) },
                ]}
                csvRow={(r) => ({ url: r.url, reason: r.state, checked_by: r.how, site_search: r.site, site_reason: r.siteCell?.reason || "", http_status: r.siteCell?.http || "", site_search_checked: r.siteCheckedAt, site_google_url: r.siteCell?.googleUrl || "", site_saved_page: r.siteCell?.archiveUrl || "", in_sitemap: r.inSitemap, last_crawled: r.lastCrawl, inspected_at: r.checkedAt, search_console_link: r.link })}
                initialSort="state"
                initialDesc={false}
                csvName="not-indexed.csv"
                source={SRC}
                empty="No unindexed pages found among the URLs checked so far."
              />
            )}
            {view === "indexed" && (
              <DataTable
                rows={result.indexed}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "how", label: "Confirmed by", render: (r) => <span className="pill ok">{r.how}</span> },
                  { key: "state", label: "Status" },
                  { key: "site", label: "site: search", render: (r) => <SiteResult cell={r.siteCell} /> },
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "link", label: "", render: (r) => openLink(r.link) },
                ]}
                csvRow={(r) => ({ url: r.url, confirmed_by: r.how, status: r.state, site_search: r.site, site_reason: r.siteCell?.reason || "", http_status: r.siteCell?.http || "", site_search_checked: r.siteCheckedAt, site_google_url: r.siteCell?.googleUrl || "", site_saved_page: r.siteCell?.archiveUrl || "", last_crawled: r.lastCrawl, inspected_at: r.checkedAt, search_console_link: r.link })}
                csvName="indexed.csv"
                source={SRC}
              />
            )}
            {view === "unchecked" && (
              <DataTable
                rows={result.unchecked}
                cols={[{ key: "url", label: "URL", url: true }, { key: "sources", label: "Found in" }]}
                csvRow={(r) => ({ url: r.url, found_in: r.sources })}
                csvName="not-checked.csv"
                empty="Every known URL has a status."
              />
            )}
            {view === "disagree" && (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  URL Inspection and site: search give different answers for these pages. URL Inspection is Search Console's own record; site: results can lag or vary by location. Re-run both before reporting a change.
                </p>
                <DataTable
                  rows={result.disagree}
                  cols={[
                    { key: "url", label: "URL", url: true },
                    { key: "inspection", label: "URL Inspection" },
                    { key: "site", label: "site: search", render: (r) => <SiteResult cell={r.siteCell} /> },
                    { key: "link", label: "", render: (r) => openLink(r.link) },
                  ]}
                  csvRow={(r) => ({ url: r.url, url_inspection: r.inspection, site_search: r.site, site_google_url: r.siteCell?.googleUrl || "", site_saved_page: r.siteCell?.archiveUrl || "", search_console_link: r.link })}
                  csvName="checks-disagree.csv"
                  source={SRC}
                  empty="The two checks agree on every page checked both ways."
                />
              </>
            )}
            {view === "errors" && (
              <DataTable
                rows={result.errors}
                cols={[{ key: "url", label: "URL", url: true }, { key: "error", label: "Error" }]}
                csvName="check-errors.csv"
                empty="No errors."
              />
            )}
          </div>
        </>
      )}
    </Section>
  );
}
