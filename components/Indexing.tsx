// components/Indexing.tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { classify, clearIndexCache, flushIndexCache, loadIndexCache, pendingUrls, type IndexCache } from "@/lib/indexCache";
import { DAILY_INSPECTION_LIMIT, inspectAndStore, loadUrlList, quotaLeft, quotaUsed } from "@/lib/checks";
import { Bars, DataTable, Kpis, PanelTitle, Section, SubTabs, num } from "./ui";

type V = "not" | "indexed" | "canonical" | "assumed" | "unchecked" | "errors";

const SRC = ["client.indexScan"];
const LIMITS = [20, 100, 500, 1000, 2000];
const AGES = [1, 3, 7, 30];
const QUOTA =
  "Google's URL Inspection quota for this property is used up for today (about 2,000 checks, shared with the Live index monitor and the audit). " +
  "Results so far are saved. The quota resets at midnight Pacific time (12:30 or 13:30 IST).";
const gscLink = (href: string) => (href ? <a href={href} target="_blank" rel="noreferrer">Open in Search Console</a> : "");

export default function Indexing({ site, onChange }: { site: string; onChange?: () => void }) {
  const [cache, setCache] = useState<IndexCache | null>(null);
  const [listing, setListing] = useState(false);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [limit, setLimit] = useState(500);
  const [maxAge, setMaxAge] = useState(7);
  const [includeSeen, setIncludeSeen] = useState(true);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [view, setView] = useState<V>("not");
  const [used, setUsed] = useState(0);
  const stop = useRef(false);

  useEffect(() => {
    let live = true;
    setCache(null);
    setMsg(null);
    setUsed(quotaUsed(site));
    loadIndexCache(site).then((c) => {
      if (live) setCache(c);
    });
    return () => {
      live = false;
      flushIndexCache(site);
    };
  }, [site]);

  const loadUrls = async () => {
    setListing(true);
    setMsg(null);
    try {
      const r = await loadUrlList(site);
      setCache({ ...r.cache });
      setMsg({ text: r.message });
      onChange?.();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Could not load URLs", error: true });
    }
    setListing(false);
  };

  const inspect = async (urls: string[]) => {
    stop.current = false;
    setMsg(null);
    if (!urls.length) {
      setMsg({ text: "Nothing to inspect with these settings: every page already has a result newer than the age you picked.", error: true });
      return;
    }
    const total = Math.min(urls.length, quotaLeft(site));
    if (!total) {
      setMsg({ text: QUOTA, error: true });
      return;
    }
    setScan({ done: 0, total });
    let done = 0;
    let note: { text: string; error?: boolean } | null = null;
    for (let i = 0; i < total && !stop.current; i += 20) {
      try {
        const r = await inspectAndStore(site, urls.slice(i, Math.min(i + 20, total)));
        done += r.results.length;
        setCache({ ...r.cache });
        setUsed(quotaUsed(site));
        setScan({ done, total });
        onChange?.();
        if (r.quotaExceeded) {
          note = { text: QUOTA, error: true };
          break;
        }
        if (r.rateLimited) await new Promise((res) => setTimeout(res, 60_000));
      } catch (e) {
        note = { text: e instanceof Error ? e.message : "Inspection failed", error: true };
        break;
      }
    }
    flushIndexCache(site);
    setScan(null);
    setMsg(note ?? { text: `Inspected ${num(done)} page(s)${stop.current ? " before you stopped" : ""}. Any status changes appear in the Live index monitor tab.` });
  };

  const result = useMemo(() => (cache ? classify(cache) : null), [cache]);
  const runPending = () => {
    if (cache) inspect(pendingUrls(cache, { includeSeen, maxAgeDays: maxAge }).slice(0, limit));
  };
  const recheckNot = () => {
    if (result) inspect(result.notIndexed.map((r) => r.url).slice(0, limit));
  };
  const clearAll = async () => {
    if (!confirm("Delete the saved URL list and inspection results for this property in this browser?")) return;
    await clearIndexCache(site);
    setCache(null);
    onChange?.();
  };

  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    result?.notIndexed.forEach((r) => m.set(r.state, (m.get(r.state) || 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }, [result]);

  return (
    <Section
      title="Indexed and unindexed pages"
      source={cache ? SRC : undefined}
      lede="URLs come from your sitemaps, robots.txt sitemaps and pages with search impressions in the last 90 days. Each page is checked with Google's URL Inspection API — Search Console's own record. “Indexed” and “Not indexed” count only inspected pages; pages that only had impressions are shown separately as “Assumed indexed”. Failed checks are retried automatically. Results are saved in this browser."
    >
      <div className="panel">
        <div className="row">
          <button className="btn primary" onClick={loadUrls} disabled={listing || !!scan}>
            {listing ? "Reading sitemaps…" : cache ? "Reload URL list" : "Load URL list"}
          </button>
          <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            Check up to
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {LIMITS.map((n) => (
                <option key={n} value={n}>{num(n)}</option>
              ))}
            </select>
            URLs
          </label>
          <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            Re-check results older than
            <select value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
              {AGES.map((d) => (
                <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>
              ))}
            </select>
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={includeSeen} onChange={(e) => setIncludeSeen(e.target.checked)} />
            Include pages that already have search impressions
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={runPending} disabled={!cache?.urls.length || !!scan}>Inspect in Search Console</button>
          <button className="btn" onClick={recheckNot} disabled={!result?.notIndexed.length || !!scan}>Re-inspect not indexed</button>
          {scan && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {cache && !scan && <button className="btn" onClick={clearAll}>Clear saved results</button>}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          URL Inspection used today: {num(used)} of {num(DAILY_INSPECTION_LIMIT)} (shared with the Live index monitor and the audit).
        </p>
        {scan && (
          <div style={{ marginTop: 12 }}>
            <div className="progress"><div style={{ width: `${(scan.done / scan.total) * 100}%` }} /></div>
            <p className="muted">URL Inspection: checked {num(scan.done)} of {num(scan.total)}</p>
          </div>
        )}
        {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
        {cache?.listedAt && (
          <p className="muted" style={{ marginBottom: 0 }}>
            URL list loaded {new Date(cache.listedAt).toLocaleString()} from {num(cache.sitemaps.length)} sitemap file(s).
          </p>
        )}
      </div>

      {!cache && (
        <div className="notice" style={{ marginTop: 16 }}>
          Load the URL list to start. URL Inspection allows about 2,000 URLs per property per day, so large sites take several days; each run
          continues with pages that don't have a recent result.
        </div>
      )}

      {result && (
        <>
          <div style={{ marginTop: 16 }}>
            <Kpis
              items={[
                { label: "Known URLs", value: num(result.total), source: SRC },
                { label: "Indexed (confirmed)", value: num(result.indexed.length), sub: "by URL Inspection", source: SRC },
                { label: "Not indexed", value: num(result.notIndexed.length), sub: "by URL Inspection", source: SRC },
                { label: "Assumed indexed", value: num(result.assumed.length), sub: "impressions only, not inspected yet", source: SRC },
                { label: "Canonical mismatch", value: num(result.canonicalMismatch.length), sub: "Google chose another URL", source: SRC },
                { label: "Check errors", value: num(result.errors.length), sub: "retried on the next run" },
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
                { id: "canonical", label: `Canonical mismatch (${result.canonicalMismatch.length})` },
                { id: "assumed", label: `Assumed indexed (${result.assumed.length})` },
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
                  { key: "fetch", label: "Page fetch" },
                  { key: "inSitemap", label: "In sitemap" },
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "checkedAt", label: "Inspected" },
                  { key: "link", label: "", render: (r) => gscLink(r.link) },
                ]}
                csvRow={(r) => ({ url: r.url, reason: r.state, page_fetch: r.fetch, in_sitemap: r.inSitemap, last_crawled: r.lastCrawl, inspected_at: r.checkedAt, search_console_link: r.link })}
                initialSort="state"
                initialDesc={false}
                csvName="not-indexed.csv"
                source={SRC}
                empty="No unindexed pages among the URLs inspected so far."
              />
            )}
            {view === "indexed" && (
              <DataTable
                rows={result.indexed}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "state", label: "Status", render: (r) => <span className="pill ok">{r.state}</span> },
                  { key: "lastCrawl", label: "Last crawled" },
                  { key: "checkedAt", label: "Inspected" },
                  { key: "link", label: "", render: (r) => gscLink(r.link) },
                ]}
                csvRow={(r) => ({ url: r.url, status: r.state, last_crawled: r.lastCrawl, inspected_at: r.checkedAt, search_console_link: r.link })}
                csvName="indexed.csv"
                source={SRC}
                empty="No inspected pages yet."
              />
            )}
            {view === "canonical" && (
              <DataTable
                rows={result.canonicalMismatch}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "userCanonical", label: "Your canonical", url: true },
                  { key: "googleCanonical", label: "Google's canonical", url: true },
                  { key: "state", label: "Status" },
                  { key: "link", label: "", render: (r) => gscLink(r.link) },
                ]}
                csvRow={(r) => ({ url: r.url, user_canonical: r.userCanonical, google_canonical: r.googleCanonical, status: r.state, search_console_link: r.link })}
                csvName="canonical-mismatch.csv"
                source={SRC}
                empty="Google agrees with your canonical on every inspected page."
              />
            )}
            {view === "assumed" && (
              <DataTable
                rows={result.assumed}
                cols={[{ key: "url", label: "URL", url: true }, { key: "sources", label: "Found in" }]}
                csvRow={(r) => ({ url: r.url, found_in: r.sources })}
                csvName="assumed-indexed.csv"
                empty="Every page with impressions has been inspected."
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
            {view === "errors" && (
              <DataTable
                rows={result.errors}
                cols={[{ key: "url", label: "URL", url: true }, { key: "error", label: "Error" }, { key: "checkedAt", label: "When" }]}
                csvRow={(r) => ({ url: r.url, error: r.error, checked_at: r.checkedAt })}
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
