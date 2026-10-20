// components/audit/SiteCrawl.tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, Kpis, SubTabs, PanelTitle, num } from "../ui";
import { loadPart, savePart, clearPart } from "@/lib/auditStore";
import { crawlBatch } from "@/lib/auditClient";
import { loadIndexCache } from "@/lib/indexCache";
import { chainLabel, sameUrlLoose, type CrawlPage, type CrawlResult, type CrawlState } from "@/lib/auditRules";

const BATCH = 10;
const running = new Set<string>();
type View = "broken" | "redirects" | "chains" | "blocked" | "indexability" | "errors" | "all";
const startFor = (site: string) => (site.startsWith("sc-domain:") ? `https://${site.slice(10)}/` : site);

function addPage(s: CrawlState, url: string, depth: number): CrawlPage | null {
  const have = s.pages[url];
  if (have) return have;
  if (s.count >= s.max) { s.capped = true; return null; }
  const p: CrawlPage = { url, depth, inlinks: 0, sources: [] };
  if (s.sitemap && s.sitemap[url]) p.inSitemap = true;
  s.pages[url] = p;
  s.count++;
  s.queue.push(url);
  return p;
}

function apply(s: CrawlState, r: CrawlResult) {
  const p = s.pages[r.url];
  if (!p) return;
  const now = new Date().toISOString();
  if (r.skipped) {
    p.tries = (p.tries || 0) + 1;
    if (p.tries >= 3) { p.crawledAt = now; p.error = "Not fetched: server time limit hit 3 times"; }
    else s.queue.push(r.url);
    return;
  }
  p.crawledAt = now;
  if (r.outside) { p.error = "Outside this Search Console property"; return; }
  if (r.blocked) { p.blocked = true; p.rule = r.rule; return; }
  const l = r.live;
  if (!l) return;
  Object.assign(p, {
    status: l.finalStatus, hops: Math.max(0, l.chain.length - 1), chain: chainLabel(l), finalUrl: l.finalUrl,
    loop: l.loop || l.tooManyHops, noindex: l.noindex, canonical: l.canonical, title: l.title, words: l.words,
    type: l.contentType.split(";")[0], error: l.error,
  });
  let src = r.url;
  if (p.hops && l.finalUrl !== r.url) {
    if (!r.finalInternal) return;
    const existing = s.pages[l.finalUrl];
    if (existing && existing.crawledAt) return; // that page's links were counted when it was fetched
    const target = existing || addPage(s, l.finalUrl, p.depth);
    if (!target) return;
    Object.assign(target, {
      crawledAt: now, status: l.finalStatus, hops: 0, chain: String(l.finalStatus || "no response"), finalUrl: l.finalUrl,
      loop: false, noindex: l.noindex, canonical: l.canonical, title: l.title, words: l.words, type: p.type, error: l.error,
    });
    target.redirectedFrom = (target.redirectedFrom || 0) + 1;
    src = l.finalUrl;
  }
  (r.links || []).forEach((link) => {
    const t = s.pages[link] || addPage(s, link, p.depth + 1);
    if (!t) return;
    t.inlinks++;
    if (t.sources.length < 10 && t.sources.indexOf(src) < 0) t.sources.push(src);
  });
}

export default function SiteCrawl({ site, onChange }: { site: string; onChange?: () => void }) {
  const st = useRef<CrawlState | null>(null);
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);
  const [start, setStart] = useState(startFor(site));
  const [max, setMax] = useState(5000);
  const [parallel, setParallel] = useState(2);
  const [respectRobots, setRespectRobots] = useState(true);
  const [seed, setSeed] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [view, setView] = useState<View>("broken");

  useEffect(() => {
    let alive = true;
    loadPart<CrawlState>(site, "crawl").then((c) => {
      if (!alive) return;
      st.current = c;
      if (c) { setStart(c.startUrl); setMax(c.max); setRespectRobots(c.respectRobots); }
      bump();
    });
    return () => { alive = false; stop.current = true; };
  }, [site]);

  const run = async () => {
    const s = st.current;
    if (!s) return;
    if (running.has(site)) { setMsg({ text: "The previous batch is still finishing. Try again in a few seconds." }); return; }
    running.add(site);
    stop.current = false;
    setBusy(true);
    const inflight = new Set<string>();
    let failures = 0;
    let pauseReason = "";
    const take = (): string[] => {
      const out: string[] = [];
      while (s.pos < s.queue.length && out.length < BATCH) {
        const u = s.queue[s.pos++];
        const p = s.pages[u];
        if (p && !p.crawledAt && !inflight.has(u) && out.indexOf(u) < 0) out.push(u);
      }
      return out;
    };
    const worker = async () => {
      while (!stop.current) {
        const batch = take();
        if (!batch.length) {
          if (!inflight.size) return;
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        batch.forEach((u) => inflight.add(u));
        try {
          const res = await crawlBatch(site, batch, s.respectRobots);
          failures = 0;
          const got = new Set<string>();
          res.results.forEach((r) => { got.add(r.url); inflight.delete(r.url); apply(s, r); });
          batch.forEach((u) => { if (!got.has(u)) { inflight.delete(u); s.queue.push(u); } });
        } catch (e) {
          batch.forEach((u) => { inflight.delete(u); s.queue.push(u); });
          if (++failures >= 3) { pauseReason = e instanceof Error ? e.message : "request failed"; stop.current = true; return; }
          await new Promise((r) => setTimeout(r, 3000));
        }
        if (s.pos > 20000) { s.queue = s.queue.slice(s.pos); s.pos = 0; }
        savePart(site, "crawl", s);
        bump();
      }
    };
    try {
      await Promise.all(Array.from({ length: parallel }, () => worker()));
    } finally {
      running.delete(site);
      savePart(site, "crawl", s, true);
      setBusy(false);
      bump();
      onChange?.();
    }
    if (pauseReason) setMsg({ text: `Crawl paused after 3 failed requests: ${pauseReason}. Click Continue to retry.`, error: true });
    else if (s.pos >= s.queue.length)
      setMsg({ text: `Crawl complete: ${num(Object.keys(s.pages).filter((k) => s.pages[k].crawledAt).length)} URLs fetched${s.capped ? `; stopped adding new URLs at the ${num(s.max)} limit` : ""}.` });
  };

  const newCrawl = async () => {
    if (running.has(site)) return;
    let first = "";
    try { first = new URL(start.trim()).toString(); } catch { setMsg({ text: "Enter a full start URL, e.g. https://www.example.com/", error: true }); return; }
    const idx = await loadIndexCache(site);
    const smUrls = (idx?.urls || []).filter((u) => u.sources.includes("sitemap")).map((u) => u.url);
    const sitemap: Record<string, 1> = {};
    smUrls.forEach((u) => { sitemap[u] = 1; });
    const s: CrawlState = { startUrl: first, startedAt: new Date().toISOString(), max, respectRobots, queue: [], pos: 0, pages: {}, count: 0, capped: false, sitemap };
    addPage(s, first, 0);
    if (seed) smUrls.forEach((u) => addPage(s, u, 1));
    st.current = s;
    savePart(site, "crawl", s, true);
    bump();
    setMsg({
      text: `Started at ${first}.` + (smUrls.length ? ` ${num(smUrls.length)} sitemap URLs known${seed ? " and queued" : " (used to flag sitemap entries)"}.` : " No sitemap URLs saved yet; load the URL list in the Indexing tab to flag sitemap entries."),
    });
    run();
  };

  const d = useMemo(() => {
    const s = st.current;
    if (!s) return null;
    const pages = Object.keys(s.pages).map((k) => s.pages[k]);
    const done = pages.filter((p) => p.crawledAt);
    const broken: { source: string; target: string; status: string; links: number; sitemap: string }[] = [];
    const redirects: { source: string; target: string; chain: string; final: string; links: number }[] = [];
    const chains: { url: string; hops: number; chain: string; final: string; links: number; sitemap: string }[] = [];
    const blocked: { url: string; rule: string; links: number; from: string; sitemap: string }[] = [];
    const indexability: { url: string; issue: string; links: number; sitemap: string; from: string }[] = [];
    const errors: { url: string; problem: string; links: number; from: string }[] = [];
    let ok = 0, red = 0, nf = 0, err = 0, blk = 0, ni = 0, brokenLinks = 0, redirectLinks = 0;
    done.forEach((p) => {
      const sm = p.inSitemap ? "Yes" : "";
      const from = p.sources.join(" · ");
      if (p.blocked) { blk++; blocked.push({ url: p.url, rule: p.rule || "", links: p.inlinks, from, sitemap: sm }); return; }
      if (p.status === 404 || p.status === 410) {
        nf++;
        brokenLinks += p.inlinks;
        if (p.sources.length) p.sources.forEach((src) => broken.push({ source: src, target: p.url, status: String(p.status), links: p.inlinks, sitemap: sm }));
        else broken.push({ source: p.inSitemap ? "(listed in your sitemap)" : "(start URL)", target: p.url, status: String(p.status), links: p.inlinks, sitemap: sm });
      } else if ((p.status ?? 0) >= 500 || p.status === 0 || ((p.status ?? 0) >= 400 && (p.status ?? 0) < 500) || p.error) {
        err++;
        errors.push({ url: p.url, problem: p.status ? `HTTP ${p.status}${p.error ? ` (${p.error})` : ""}` : p.error || "no response", links: p.inlinks, from });
      }
      if ((p.hops || 0) > 0) {
        red++;
        redirectLinks += p.inlinks;
        p.sources.forEach((src) => redirects.push({ source: src, target: p.url, chain: p.chain || "", final: p.finalUrl || "", links: p.inlinks }));
        if ((p.hops || 0) >= 2 || p.loop) chains.push({ url: p.url, hops: p.hops || 0, chain: p.chain || "", final: p.finalUrl || "", links: p.inlinks, sitemap: sm });
      }
      if (p.status === 200 && !p.hops) {
        ok++;
        if (p.noindex) { ni++; indexability.push({ url: p.url, issue: "noindex", links: p.inlinks, sitemap: sm, from }); }
        if (p.canonical && !sameUrlLoose(p.canonical, p.url)) indexability.push({ url: p.url, issue: `canonical → ${p.canonical}`, links: p.inlinks, sitemap: sm, from });
      }
    });
    const all = done.map((p) => ({
      url: p.url, status: p.blocked ? "blocked" : p.chain || String(p.status ?? ""), depth: p.depth, links: p.inlinks,
      title: p.title || "", words: p.words || 0, sitemap: p.inSitemap ? "Yes" : "",
    }));
    return { s, total: pages.length, done: done.length, ok, red, nf, err, blk, ni, brokenLinks, redirectLinks, broken, redirects, chains, blocked, indexability, errors, all };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return (
    <>
      <div className="panel">
        <PanelTitle>Crawl your site like Googlebot would</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Starts at the URL below and follows every internal link, recording each redirect hop, 404, server error, robots.txt block, noindex
          and canonical, plus the pages that link to each URL (first 10 kept, total counted). Runs from this dashboard’s server in batches of
          10; results are saved in this browser, and you can stop and continue at any time.
        </p>
        <div className="row">
          <label className="control">
            Start URL
            <input value={start} onChange={(e) => setStart(e.target.value)} style={{ minWidth: 320 }} />
          </label>
          <label className="control">
            Max URLs
            <select value={max} onChange={(e) => setMax(Number(e.target.value))}>
              {[1000, 5000, 20000, 50000, 100000].map((n) => (
                <option key={n} value={n}>{num(n)}</option>
              ))}
            </select>
          </label>
          <label className="control">
            Parallel batches
            <select value={parallel} onChange={(e) => setParallel(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{n} ({n * 5} requests at a time)</option>
              ))}
            </select>
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={respectRobots} onChange={(e) => setRespectRobots(e.target.checked)} /> Obey robots.txt (Googlebot rules)
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.target.checked)} /> Also fetch every sitemap URL (finds orphans; counts toward the limit)
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={newCrawl} disabled={busy}>Start new crawl</button>
          <button className="btn" onClick={() => { setMsg(null); run(); }} disabled={busy || !d || d.done >= d.total}>Continue</button>
          {busy && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {!busy && d && (
            <button className="btn" onClick={async () => { await clearPart(site, "crawl"); st.current = null; bump(); onChange?.(); }}>Clear crawl</button>
          )}
        </div>
        {d && (
          <div style={{ marginTop: 12 }}>
            <div className="progress"><div style={{ width: `${(d.done / Math.max(1, d.total)) * 100}%` }} /></div>
            <p className="muted">
              Fetched {num(d.done)} of {num(d.total)} URLs found{d.s.capped ? ` (limit of ${num(d.s.max)} reached; links to further URLs are not followed)` : ""} · started {new Date(d.s.startedAt).toLocaleString()}
            </p>
          </div>
        )}
        {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
      </div>

      {d && d.done > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <Kpis
            items={[
              { label: "URLs fetched", value: num(d.done), sub: `${num(d.total - d.done)} still queued` },
              { label: "200 OK", value: num(d.ok) },
              { label: "Redirecting URLs", value: num(d.red), sub: `${num(d.redirectLinks)} internal links point at them` },
              { label: "404 / 410", value: num(d.nf), sub: `${num(d.brokenLinks)} internal links point at them` },
              { label: "Errors", value: num(d.err), sub: "5xx, 4xx, timeouts" },
              { label: "Blocked by robots.txt", value: num(d.blk), sub: "not fetched; links counted" },
              { label: "noindex pages", value: num(d.ni) },
            ]}
          />
          <div style={{ marginTop: 16 }}>
            <SubTabs
              value={view}
              onChange={setView}
              options={[
                { id: "broken", label: `Broken links (${d.broken.length})` },
                { id: "redirects", label: `Links to redirects (${d.redirects.length})` },
                { id: "chains", label: `Chains & loops (${d.chains.length})` },
                { id: "blocked", label: `Blocked (${d.blocked.length})` },
                { id: "indexability", label: `noindex / canonical (${d.indexability.length})` },
                { id: "errors", label: `Errors (${d.errors.length})` },
                { id: "all", label: `All URLs (${d.all.length})` },
              ]}
            />
            {view === "broken" && (
              <DataTable rows={d.broken} cols={[
                { key: "source", label: "Page with the link (edit this)", url: true },
                { key: "target", label: "Broken link target", url: true },
                { key: "status", label: "Status" },
                { key: "links", label: "Links to target", num: true },
                { key: "sitemap", label: "In sitemap" },
              ]} initialSort="links" csvName="broken-links.csv" empty="No broken internal links found so far." />
            )}
            {view === "redirects" && (
              <DataTable rows={d.redirects} cols={[
                { key: "source", label: "Page with the link (edit this)", url: true },
                { key: "target", label: "Linked URL", url: true },
                { key: "chain", label: "Redirect" },
                { key: "final", label: "Link here instead", url: true },
                { key: "links", label: "Links to it", num: true },
              ]} initialSort="links" csvName="links-to-redirects.csv" empty="No internal links to redirecting URLs found so far." />
            )}
            {view === "chains" && (
              <DataTable rows={d.chains} cols={[
                { key: "url", label: "URL", url: true },
                { key: "hops", label: "Hops", num: true },
                { key: "chain", label: "Statuses" },
                { key: "final", label: "Ends at", url: true },
                { key: "links", label: "Links to it", num: true },
                { key: "sitemap", label: "In sitemap" },
              ]} initialSort="hops" csvName="redirect-chains-crawl.csv" empty="No multi-hop chains or loops found." />
            )}
            {view === "blocked" && (
              <DataTable rows={d.blocked} cols={[
                { key: "url", label: "Blocked URL", url: true },
                { key: "rule", label: "Matching rule" },
                { key: "links", label: "Links to it", num: true },
                { key: "from", label: "Linked from" },
                { key: "sitemap", label: "In sitemap" },
              ]} initialSort="links" csvName="blocked-by-robots.csv" empty="No internal links to robots.txt-blocked URLs." />
            )}
            {view === "indexability" && (
              <DataTable rows={d.indexability} cols={[
                { key: "url", label: "URL", url: true },
                { key: "issue", label: "Signal on the page" },
                { key: "links", label: "Links to it", num: true },
                { key: "sitemap", label: "In sitemap" },
                { key: "from", label: "Linked from" },
              ]} initialSort="links" csvName="noindex-canonical.csv" empty="No noindex or canonicalised pages found." />
            )}
            {view === "errors" && (
              <DataTable rows={d.errors} cols={[
                { key: "url", label: "URL", url: true },
                { key: "problem", label: "Problem" },
                { key: "links", label: "Links to it", num: true },
                { key: "from", label: "Linked from" },
              ]} initialSort="links" csvName="crawl-errors.csv" empty="No errors." />
            )}
            {view === "all" && (
              <DataTable rows={d.all} cols={[
                { key: "url", label: "URL", url: true },
                { key: "status", label: "Status / chain" },
                { key: "depth", label: "Clicks from start", num: true },
                { key: "links", label: "Internal links in", num: true },
                { key: "words", label: "Words (rough)", num: true },
                { key: "title", label: "Title" },
                { key: "sitemap", label: "In sitemap" },
              ]} initialSort="links" csvName="crawl-all-urls.csv" />
            )}
          </div>
        </div>
      )}
    </>
  );
}
