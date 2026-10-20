// components/audit/AuditImport.tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable, Kpis, SubTabs, PanelTitle, num } from "../ui";
import { runBatches } from "@/lib/checks";
import { loadIndexCache, classify } from "@/lib/indexCache";
import { loadPart, savePart, clearPart } from "@/lib/auditStore";
import { checkBatch, parseUrlList, LIST_OPTIONS, type ImportedList, type ListedUrl } from "@/lib/auditClient";
import { diagnose, chainLabel, reasonOf, listReason, isInternal, VERDICT_LABEL, VERDICT_PILL, type AuditCheck, type RefCheck, type Verdict } from "@/lib/auditRules";

type Lists = Record<string, ImportedList>;
type Checks = Record<string, AuditCheck>;
type View = "results" | "sources" | "chains";
type Row = { url: string; list: string; google: string; live: string; verdict: Verdict; summary: string; todo: string; lastCrawl: string; link: string };
type SrcRow = { url: string; now: string; type: string; source: string; evidence: string; confirmed: string };
type ChainRow = { url: string; hops: number; chain: string; final: string; status: string };

const running = new Set<string>();
const listName = (id: string) => (LIST_OPTIONS.find((o) => o.id === id)?.label || id).replace(/^.*· /, "");

function merge(base: Lists, id: string, urls: ListedUrl[], from: string): Lists {
  const m = new Map<string, ListedUrl>();
  (base[id]?.urls || []).forEach((u) => m.set(u.url, u));
  urls.forEach((u) => m.set(u.url, u));
  const label = LIST_OPTIONS.find((o) => o.id === id)?.label || id;
  return { ...base, [id]: { id, label, urls: Array.from(m.values()), importedAt: new Date().toISOString(), from } };
}

export default function AuditImport({ site, onChange }: { site: string; onChange?: () => void }) {
  const [lists, setLists] = useState<Lists>({});
  const [checks, setChecks] = useState<Checks>({});
  const checksRef = useRef<Checks>({});
  const [sitemapSet, setSitemapSet] = useState<Set<string>>(new Set());
  const [listId, setListId] = useState("notFound");
  const [paste, setPaste] = useState("");
  const [limit, setLimit] = useState(200);
  const [live, setLive] = useState(true);
  const [onlyNew, setOnlyNew] = useState(true);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [view, setView] = useState<View>("results");
  const stop = useRef(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadPart<Lists>(site, "imports"), loadPart<Checks>(site, "checks"), loadIndexCache(site)]).then(([l, c, idx]) => {
      if (!alive) return;
      setLists(l || {});
      checksRef.current = c || {};
      setChecks(c || {});
      setSitemapSet(new Set((idx?.urls || []).filter((u) => u.sources.includes("sitemap")).map((u) => u.url)));
    });
    return () => {
      alive = false;
      stop.current = true;
    };
  }, [site]);

  const saveLists = (next: Lists) => {
    setLists(next);
    savePart(site, "imports", next, true);
    onChange?.();
  };

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    const found: ListedUrl[] = [];
    const names: string[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      if (/\.(xlsx|xls|zip)$/i.test(f.name)) { skipped.push(f.name); continue; }
      parseUrlList(await f.text()).forEach((u) => found.push(u));
      names.push(f.name);
    }
    if (found.length) saveLists(merge(lists, listId, found, names.join(", ")));
    setMsg({
      text:
        (found.length ? `Added ${num(found.length)} URL(s) to “${listName(listId)}”.` : "No URLs found in the file(s).") +
        (skipped.length ? ` Skipped ${skipped.join(", ")}: export as CSV, or unzip the download and upload the CSV inside.` : ""),
      error: !found.length,
    });
  };

  const onPaste = () => {
    const found = parseUrlList(paste);
    if (!found.length) { setMsg({ text: "No URLs found in the pasted text.", error: true }); return; }
    saveLists(merge(lists, listId, found, "pasted"));
    setPaste("");
    setMsg({ text: `Added ${num(found.length)} pasted URL(s) to “${listName(listId)}”.` });
  };

  const fromIndexing = async () => {
    const c = await loadIndexCache(site);
    if (!c) { setMsg({ text: "The Indexing tab has no saved inspections for this property yet.", error: true }); return; }
    const groups = new Map<string, ListedUrl[]>();
    classify(c).notIndexed.forEach((r) => {
      if (r.how !== "URL Inspection") return;
      const id = reasonOf(r.state);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push({ url: r.url, date: r.lastCrawl });
    });
    if (!groups.size) { setMsg({ text: "No URLs marked not indexed by URL Inspection in the Indexing tab yet.", error: true }); return; }
    let next = lists;
    let total = 0;
    groups.forEach((urls, id) => { next = merge(next, id, urls, "Indexing tab"); total += urls.length; });
    saveLists(next);
    setMsg({ text: `Imported ${num(total)} not-indexed URLs from the Indexing tab, grouped by Google’s reason.` });
  };

  const removeList = (id: string) => {
    const next = { ...lists };
    delete next[id];
    saveLists(next);
  };

  const listed = useMemo(() => {
    const m = new Map<string, string>();
    Object.keys(lists).forEach((id) => lists[id].urls.forEach((u) => { if (!m.has(u.url)) m.set(u.url, id); }));
    return m;
  }, [lists]);

  const runCheck = async () => {
    if (running.has(site)) return;
    const all = Array.from(listed.keys()).filter((u) => isInternal(u, site));
    const outside = listed.size - all.length;
    const todo = onlyNew ? all.filter((u) => !checksRef.current[u]) : all;
    const urls = limit ? todo.slice(0, limit) : todo;
    if (!urls.length) {
      setMsg({ text: all.length ? "Every imported URL is already checked. Untick “Only URLs not checked yet” to re-check." : "Import a URL list first.", error: true });
      return;
    }
    running.add(site);
    stop.current = false;
    setMsg(null);
    setScan({ done: 0, total: urls.length });
    try {
      const r = await runBatches<AuditCheck>(
        urls,
        (b) => checkBatch(site, b, { live }),
        (results, done) => {
          const next = { ...checksRef.current };
          results.forEach((x) => { next[x.url] = { ...x, listedAs: listed.get(x.url) }; });
          checksRef.current = next;
          setChecks(next);
          savePart(site, "checks", next);
          setScan({ done, total: urls.length });
        },
        () => stop.current,
        5
      );
      savePart(site, "checks", checksRef.current, true);
      onChange?.();
      const note = outside ? ` ${num(outside)} URL(s) outside this property were skipped.` : "";
      if (r.quotaExceeded) setMsg({ text: `Google’s URL Inspection quota for this property is used up for today (about 2,000 a day). Results so far are saved; run again tomorrow to continue.${note}`, error: true });
      else if (r.error) setMsg({ text: r.error + note, error: true });
      else setMsg({ text: `${r.stopped ? "Stopped." : "Done."} ${num(Object.keys(checksRef.current).length)} URLs checked in total.${note}` });
    } finally {
      running.delete(site);
      setScan(null);
    }
  };

  const rows = useMemo<Row[]>(
    () =>
      Object.keys(checks).map((u) => {
        const c = checks[u];
        const id = listed.get(u) || c.listedAs || "";
        const d = diagnose({ ...c, listedAs: id || undefined });
        return {
          url: u,
          list: id ? listName(id) : "",
          google: c.google?.coverageState || (c.googleError ? `Error: ${c.googleError}` : ""),
          live: c.live ? chainLabel(c.live) : "not fetched",
          verdict: d.verdict,
          summary: d.summary,
          todo: d.actions.map((a) => (a.page ? `${a.text} → edit: ${a.page}` : a.text)).join("  |  "),
          lastCrawl: c.google?.lastCrawlTime ? c.google.lastCrawlTime.slice(0, 10) : "",
          link: c.google?.link || "",
        };
      }),
    [checks, listed]
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach((r) => { m[r.verdict] = (m[r.verdict] || 0) + 1; });
    return m;
  }, [rows]);

  const sourceRows = useMemo<SrcRow[]>(() => {
    const out: SrcRow[] = [];
    Object.keys(checks).forEach((u) => {
      const c = checks[u];
      const id = listed.get(u) || c.listedAs || "";
      const key = id ? listReason(id) : null;
      const fin = c.live?.finalStatus;
      const is404 = key === "notFound" || key === "soft404" || fin === 404 || fin === 410 || /404/.test(c.google?.coverageState || "");
      if (!is404) return;
      const now = c.live ? chainLabel(c.live) : "not fetched";
      const verified = new Map<string, RefCheck>();
      c.refs.forEach((r) => verified.set(r.url, r));
      const refs = c.google?.referringUrls || [];
      const maps = c.google?.sitemaps || [];
      refs.forEach((ref) => {
        const v = verified.get(ref);
        const internal = isInternal(ref, site);
        out.push({
          url: u,
          now,
          source: ref,
          type: internal ? "Page on your site" : "Another website",
          evidence: v
            ? v.status === "links"
              ? v.exact
                ? `Link is on the page: href="${v.href}"`
                : `Links to a similar URL: href="${v.href}"`
              : v.status === "no_link"
              ? "Link is no longer on this page"
              : `Page didn't load (${v.note || v.http})`
            : internal
            ? "Reported by Google; not re-checked (only the first 3 are)"
            : "Reported by Google. Ask that site to update it, or 301 this URL to the right page.",
          confirmed: v ? (v.status === "links" ? (v.exact ? "Yes" : "Similar") : "No") : "–",
        });
      });
      maps.forEach((s) => out.push({ url: u, now, type: "Sitemap (Google's record)", source: s, evidence: "Google says this sitemap listed the URL", confirmed: "Google" }));
      if (sitemapSet.has(u)) out.push({ url: u, now, type: "Sitemap (current)", source: "Your sitemaps (Indexing tab URL list)", evidence: "Your sitemap still lists this URL", confirmed: "Yes" });
      if (!refs.length && !maps.length && !sitemapSet.has(u))
        out.push({ url: u, now, type: "None reported", source: "", evidence: "Google gives no referring page or sitemap; usually an old URL Google remembers. Run the Site crawl to look for links.", confirmed: "–" });
    });
    return out;
  }, [checks, listed, sitemapSet, site]);

  const chainRows = useMemo<ChainRow[]>(
    () =>
      Object.keys(checks)
        .map((u) => checks[u])
        .filter((c) => c.live && c.live.chain.length > 1)
        .map((c) => ({
          url: c.url,
          hops: c.live!.chain.length - 1,
          chain: c.live!.chain.map((h) => `${h.status} ${h.url}`).join("  →  "),
          final: c.live!.finalUrl,
          status: String(c.live!.finalStatus || "no response"),
        })),
    [checks]
  );

  const listRows = Object.keys(lists).map((id) => ({
    id,
    label: lists[id].label,
    urls: lists[id].urls.length,
    checked: lists[id].urls.filter((u) => checks[u.url]).length,
    from: lists[id].from,
    updated: lists[id].importedAt.slice(0, 16).replace("T", " "),
  }));

  return (
    <>
      <div className="panel">
        <PanelTitle>1. Bring in the URLs Search Console lists</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          In Search Console open Pages → click a reason (for example “Not found (404)”) → Export → CSV. For crawl requests open Settings →
          Crawl stats → click a row such as “Not found (404)” or “Discovery” and export or copy its example URLs. Each list holds up to 1,000
          examples. Choose which list a file is, then upload or paste it.
        </p>
        <div className="row">
          <label className="control">
            Which list is this?
            <select value={listId} onChange={(e) => setListId(e.target.value)} style={{ minWidth: 320 }}>
              {LIST_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="btn" style={{ cursor: "pointer" }}>
            Upload CSV / TXT
            <input
              type="file"
              accept=".csv,.txt,.tsv"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                onFiles(files);
              }}
            />
          </label>
          <button className="btn" onClick={fromIndexing}>Use the Indexing tab’s not-indexed URLs</button>
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="…or paste URLs or CSV text here"
          style={{ width: "100%", minHeight: 80, marginTop: 10, font: "inherit", padding: 8 }}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn" onClick={onPaste} disabled={!paste.trim()}>Add pasted URLs</button>
        </div>
        {listRows.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <DataTable
              rows={listRows}
              cols={[
                { key: "label", label: "List" },
                { key: "urls", label: "URLs", num: true },
                { key: "checked", label: "Checked", num: true },
                { key: "from", label: "From" },
                { key: "updated", label: "Updated" },
                { key: "id", label: "", render: (r) => <button className="btn small" onClick={() => removeList(r.id)}>Remove</button> },
              ]}
              pageSize={10}
              empty="No lists yet."
            />
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <PanelTitle>2. Check them against Google and the live site</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Each URL gets Google’s current record from the URL Inspection API (about 2,000 per property per day), a live fetch from this server
          that records every redirect hop, the robots.txt rule that applies, and a re-fetch of up to 3 referring pages on your site to confirm
          the link is really still there.
        </p>
        <div className="row">
          <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            Check up to
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[50, 200, 500, 1000, 2000].map((n) => (
                <option key={n} value={n}>{num(n)}</option>
              ))}
              <option value={0}>All ({num(listed.size)})</option>
            </select>
            URLs
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Only URLs not checked yet
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live fetch + verify referring pages
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={runCheck} disabled={!!scan || !listed.size}>Check URLs</button>
          {scan && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {!scan && rows.length > 0 && (
            <button
              className="btn"
              onClick={async () => {
                await clearPart(site, "checks");
                checksRef.current = {};
                setChecks({});
                onChange?.();
              }}
            >
              Clear results
            </button>
          )}
        </div>
        {scan && (
          <div style={{ marginTop: 12 }}>
            <div className="progress"><div style={{ width: `${(scan.done / Math.max(1, scan.total)) * 100}%` }} /></div>
            <p className="muted">Checked {num(scan.done)} of {num(scan.total)}</p>
          </div>
        )}
        {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
      </div>

      {rows.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <Kpis
            items={[
              { label: "URLs checked", value: num(rows.length) },
              { label: "Still failing", value: num(counts.failing || 0), sub: "needs a fix on your site" },
              { label: "Fixed since Google’s crawl", value: num(counts.fixed || 0), sub: "click Validate fix in Search Console" },
              { label: "Needs a decision", value: num(counts.review || 0) },
              { label: "Working as intended", value: num(counts.expected || 0) },
              { label: "Check failed", value: num(counts.error || 0) },
            ]}
          />
          <div style={{ marginTop: 16 }}>
            <SubTabs
              value={view}
              onChange={setView}
              options={[
                { id: "results", label: `All results (${rows.length})` },
                { id: "sources", label: `404 sources (${sourceRows.length})` },
                { id: "chains", label: `Redirect chains (${chainRows.length})` },
              ]}
            />
            {view === "results" && (
              <DataTable
                rows={rows}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "list", label: "Search Console list" },
                  { key: "google", label: "Google now" },
                  { key: "live", label: "Live (hop by hop)" },
                  { key: "verdict", label: "Verdict", render: (r) => <span className={`pill ${VERDICT_PILL[r.verdict]}`}>{VERDICT_LABEL[r.verdict]}</span> },
                  {
                    key: "todo",
                    label: "What to do",
                    render: (r) => (
                      <span>
                        {r.summary}
                        {r.todo ? (<><br /><span className="muted">{r.todo}</span></>) : null}
                      </span>
                    ),
                  },
                  { key: "lastCrawl", label: "Google last crawled" },
                  { key: "link", label: "", render: (r) => (r.link ? <a href={r.link} target="_blank" rel="noreferrer">Inspect</a> : "") },
                ]}
                initialSort="verdict"
                initialDesc={false}
                csvName="url-check.csv"
              />
            )}
            {view === "sources" && (
              <DataTable
                rows={sourceRows}
                cols={[
                  { key: "url", label: "404 URL", url: true },
                  { key: "now", label: "Live now" },
                  { key: "type", label: "Source type" },
                  { key: "source", label: "Source", render: (r) => (/^https?:/.test(r.source) ? <a href={r.source} target="_blank" rel="noreferrer">{r.source}</a> : r.source) },
                  { key: "evidence", label: "Evidence" },
                  { key: "confirmed", label: "Link confirmed" },
                ]}
                initialSort="confirmed"
                csvName="404-sources.csv"
                empty="No 404 URLs checked yet. Import the “Not found (404)” export and run the check."
              />
            )}
            {view === "chains" && (
              <DataTable
                rows={chainRows}
                cols={[
                  { key: "url", label: "URL", url: true },
                  { key: "hops", label: "Hops", num: true },
                  { key: "chain", label: "Every hop" },
                  { key: "final", label: "Ends at", url: true },
                  { key: "status", label: "Final status" },
                ]}
                initialSort="hops"
                csvName="redirect-chains.csv"
                empty="No redirecting URLs among those checked."
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
