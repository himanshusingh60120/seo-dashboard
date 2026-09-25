"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Inspection } from "@/lib/types";
import { loadIndexCache, saveIndexCache, classify, IndexCache } from "@/lib/indexCache";
import { DataTable, Kpis, Section, SubTabs, Bars, num } from "./ui";

const CHUNK = 20;
type V = "not" | "indexed" | "unchecked" | "errors";

export default function Indexing({ site }: { site: string }) {
  const [cache, setCache] = useState<IndexCache | null>(null);
  const [listing, setListing] = useState(false);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [limit, setLimit] = useState(200);
  const [includeSeen, setIncludeSeen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [view, setView] = useState<V>("not");
  const stop = useRef(false);

  useEffect(() => {
    setCache(loadIndexCache(site));
    setMsg(null);
  }, [site]);

  const update = (c: IndexCache) => {
    setCache(c);
    saveIndexCache(site, c);
  };

  const loadUrls = async () => {
    setListing(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/gsc/sitemap-urls?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      update({ urls: data.urls, sitemaps: data.sitemaps, inspected: cache?.inspected || {}, listedAt: new Date().toISOString() });
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
    if (!cache || !urls.length) return;
    stop.current = false;
    let c = cache;
    setScan({ done: 0, total: urls.length });
    setMsg(null);
    for (let i = 0; i < urls.length; i += CHUNK) {
      if (stop.current) break;
      const res = await fetch("/api/gsc/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl: site, urls: urls.slice(i, i + CHUNK) }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg({ text: data.error, error: true }); break; }
      const now = new Date().toISOString();
      const inspected = { ...c.inspected };
      (data.results as Inspection[]).forEach((r) => { if (r.verdict !== "ERROR" || !inspected[r.url]) inspected[r.url] = { ...r, checkedAt: now }; });
      c = { ...c, inspected };
      update(c);
      setScan({ done: Math.min(i + CHUNK, urls.length), total: urls.length });
      if (data.quotaExceeded) {
        setMsg({ text: "Google's daily URL Inspection quota for this property is used up (about 2,000 checks a day). Results so far are saved; continue tomorrow.", error: true });
        break;
      }
    }
    setScan(null);
  };

  const result = useMemo(() => (cache ? classify(cache) : null), [cache]);

  const queueNext = () => {
    if (!cache) return;
    const pending = cache.urls.filter((u) => !cache.inspected[u.url] && (includeSeen || !u.sources.includes("search")));
    inspect(pending.slice(0, limit).map((u) => u.url));
  };
  const recheckNot = () => result && inspect(result.notIndexed.slice(0, limit).map((r) => r.url));

  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    result?.notIndexed.forEach((r) => m.set(r.state, (m.get(r.state) || 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }, [result]);

  const openLink = (link: string) => (link ? <a href={link} target="_blank" rel="noreferrer">Open in Search Console</a> : "");

  return (
    <Section
      title="Indexed and unindexed pages"
      lede="Search Console's API doesn't expose the Pages report, so this tab builds it: it collects URLs from your sitemaps and search results, then checks each with the URL Inspection API. Pages that earned impressions count as indexed without using quota. Results are saved in this browser."
    >
      <div className="panel">
        <div className="row">
          <button className="btn primary" onClick={loadUrls} disabled={listing || !!scan}>
            {listing ? "Reading sitemaps…" : cache ? "Reload URL list" : "Load URL list"}
          </button>
          <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            Check up to
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ minWidth: 90 }}>
              {[50, 200, 500, 1000, 1900].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            URLs
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeSeen} onChange={(e) => setIncludeSeen(e.target.checked)} />
            Also inspect pages that already have impressions
          </label>
          <button className="btn" onClick={queueNext} disabled={!cache?.urls.length || !!scan}>Check index status</button>
          <button className="btn" onClick={recheckNot} disabled={!result?.notIndexed.length || !!scan}>Re-check unindexed</button>
          {scan && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {cache && !scan && (
            <button className="btn" onClick={() => { localStorage.removeItem(`dash:index:${site}`); setCache(null); }}>Clear saved results</button>
          )}
        </div>
        {scan && (
          <div style={{ marginTop: 12 }}>
            <div className="progress"><div style={{ width: `${(scan.done / scan.total) * 100}%` }} /></div>
            <p className="muted">Checked {num(scan.done)} of {num(scan.total)}</p>
          </div>
        )}
        {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
        {cache && <p className="muted" style={{ marginBottom: 0 }}>URL list loaded {new Date(cache.listedAt).toLocaleString()}.</p>}
      </div>

      {!cache && <div className="notice" style={{ marginTop: 16 }}>Load the URL list to start. Inspection uses Google's quota of about 2,000 URLs per property per day.</div>}

      {result && (
        <>
          <div style={{ marginTop: 16 }}>
            <Kpis
              items={[
                { label: "Known URLs", value: num(result.total) },
                { label: "Indexed", value: num(result.indexed.length), sub: `${num(result.indexed.filter((r) => r.how === "Inspected").length)} confirmed by inspection` },
                { label: "Not indexed", value: num(result.notIndexed.length) },
                { label: "Not checked yet", value: num(result.unchecked.length) },
                { label: "Errors", value: num(result.errors.length) },
              ]}
            />
          </div>
          {reasons.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <h3>Why pages aren't indexed</h3>
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
                { id: "errors", label: `Errors (${result.errors.length})` },
              ]}
            />
            {view === "not" && (
              <DataTable
                rows={result.notIndexed}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "state", label: "Reason", render: (r) => <span className="pill no">{r.state}</span> },
                  { key: "inSitemap", label: "In sitemap" },
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "link", label: "", render: (r) => openLink(r.link) },
                ]}
                initialSort="state"
                initialDesc={false}
                csvName="not-indexed.csv"
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
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "link", label: "", render: (r) => openLink(r.link) },
                ]}
                csvName="indexed.csv"
              />
            )}
            {view === "unchecked" && (
              <DataTable
                rows={result.unchecked}
                cols={[{ key: "url", label: "URL", url: true }, { key: "sources", label: "Found in" }]}
                csvName="not-checked.csv"
                empty="Every known URL has a status."
              />
            )}
            {view === "errors" && (
              <DataTable
                rows={result.errors}
                cols={[{ key: "url", label: "URL", url: true }, { key: "error", label: "Error" }]}
                csvName="inspection-errors.csv"
                empty="No inspection errors."
              />
            )}
          </div>
        </>
      )}
    </Section>
  );
}
