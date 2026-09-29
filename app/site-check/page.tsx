"use client";
// app/site-check/page.tsx  ->  /site-check  (sign-in required via middleware)

import { useRef, useState } from "react";
import Link from "next/link";
import { DataTable, Kpis, Section, shortUrl, num, type Col } from "@/components/ui";
import { loadIndexCache, classify } from "@/lib/indexCache";
import type { PageCheckRow, GoogleResult } from "@/app/api/site-check/route";

const GOOGLE: Record<GoogleResult, { label: string; tone: string }> = {
  found: { label: "In results", tone: "ok" },
  not_found: { label: "No results", tone: "no" },
  other_urls_only: { label: "Other URLs only", tone: "warn" },
  blocked: { label: "Blocked by Google", tone: "no" },
  js_required: { label: "Google wants JavaScript", tone: "no" },
  consent_page: { label: "Consent page", tone: "warn" },
  redirected: { label: "Redirected", tone: "warn" },
  unknown: { label: "Unclear", tone: "warn" },
  error: { label: "Request failed", tone: "no" },
  skipped: { label: "Skipped", tone: "info" },
  off: { label: "Not run", tone: "info" },
};

const statusTone = (s: number) => (s === 200 ? "ok" : s >= 300 && s < 400 ? "warn" : "no");
const ext = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;

const cols: Col<PageCheckRow>[] = [
  { key: "url", label: "URL", url: true },
  {
    key: "pageStatus",
    label: "Page status",
    render: (r) => <span className={`pill ${r.pageStatus ? statusTone(r.pageStatus) : "no"}`}>{r.chain || "–"}</span>,
  },
  {
    key: "finalUrl",
    label: "Ends at",
    render: (r) => (!r.finalUrl ? <span className="muted">–</span> : r.finalUrl === r.url ? <span className="muted">same</span> : ext(r.finalUrl, shortUrl(r.finalUrl))),
  },
  {
    key: "noindex",
    label: "noindex",
    render: (r) => (r.noindex === "yes" ? <span className="pill no">noindex</span> : <span className="muted">{r.noindex || "–"}</span>),
  },
  {
    key: "canonical",
    label: "Canonical",
    render: (r) =>
      !r.canonical ? <span className="muted">–</span>
      : r.canonicalElsewhere ? <span><span className="pill warn">elsewhere</span> {ext(r.canonical, shortUrl(r.canonical))}</span>
      : <span className="muted">self</span>,
  },
  {
    key: "googleResult",
    label: "Google site:",
    render: (r) => (
      <span style={{ whiteSpace: "nowrap" }}>
        <span className={`pill ${GOOGLE[r.googleResult].tone}`}>
          {GOOGLE[r.googleResult].label}{r.googleHttp ? ` · ${r.googleHttp}` : ""}
        </span>{" "}
        {ext(r.googleUrl, "open")}
      </span>
    ),
  },
  { key: "error", label: "Note", render: (r) => <span className="muted">{r.error}</span> },
];

const failedRow = (url: string, error: string): PageCheckRow => ({
  url, pageStatus: 0, chain: "", finalUrl: "", noindex: "", canonical: "", canonicalElsewhere: false,
  googleHttp: null, googleResult: "off", googleUrl: `https://www.google.com/search?q=${encodeURIComponent(`site:${url}`)}`,
  error, checkedAt: new Date().toISOString(),
});

export default function SiteCheckPage() {
  const [input, setInput] = useState("");
  const [google, setGoogle] = useState(true);
  const [rows, setRows] = useState<PageCheckRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const stop = useRef(false);

  async function loadNotIndexed() {
    setNotice("");
    setError("");
    try {
      const prefs = JSON.parse(localStorage.getItem("dash:prefs") || "{}") as { site?: string };
      if (!prefs.site) return setError("No property selected yet. Open the dashboard and pick a property first.");
      const cache = await loadIndexCache(prefs.site);
      const urls = cache ? classify(cache).notIndexed.map((r) => r.url) : [];
      if (!urls.length) return setError(`No not-indexed URLs saved for ${prefs.site}. Run "Inspect in Search Console" on the Indexing tab first.`);
      setInput(urls.join("\n"));
      setNotice(`Loaded ${num(urls.length)} not-indexed URLs for ${prefs.site}.`);
    } catch {
      setError("Couldn't read the saved Indexing results in this browser.");
    }
  }

  async function runCheck() {
    const urls = [...new Set(input.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))];
    if (!urls.length) return setError("Paste at least one URL starting with http:// or https://");
    stop.current = false;
    setBusy(true);
    setRows([]);
    setNotice("");
    setError("");
    setProgress({ done: 0, total: urls.length });

    let useGoogle = google;
    let done = 0;
    while (done < urls.length && !stop.current) {
      const batch = urls.slice(done, done + (useGoogle ? 10 : 20));
      try {
        const res = await fetch("/api/site-check", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: batch, google: useGoogle }),
        });
        const data = await res.json();
        if (res.status === 401) {
          setError("Your session expired. Reload the page and sign in again.");
          break;
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setRows((prev) => [...prev, ...(data.results as PageCheckRow[])]);
        if (data.googleBlocked && useGoogle) {
          useGoogle = false;
          setNotice('Google blocked the request from the server, so the Google check is off for the rest of this run. Page checks carry on. Use "open" on any row to run the site: search in your own browser.');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Request failed";
        setRows((prev) => [...prev, ...batch.map((u) => failedRow(u, `Check failed: ${msg}`))]);
      }
      done += batch.length;
      setProgress({ done, total: urls.length });
    }
    setBusy(false);
  }

  const count = (f: (r: PageCheckRow) => boolean) => num(rows.filter(f).length);

  return (
    <main>
      <p style={{ margin: 0 }}><Link href="/">← Back to dashboard</Link></p>

      <Section
        title="Page status & site: check"
        lede="Checks each page's own response: status code, redirects, noindex and canonical. No API key needed. The optional Google site: check asks google.com directly; Google often blocks requests from Vercel's servers, and when it does, use the open link on each row to run the search in your own browser."
      >
        <div className="panel" style={{ display: "grid", gap: 12 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste URLs, one per line"
            rows={8}
            disabled={busy}
            style={{ width: "100%", padding: 10, font: "13px/1.5 ui-monospace, Consolas, monospace", border: "1px solid var(--rule)", borderRadius: "var(--radius)", background: "var(--surface)" }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <button className="btn primary" onClick={runCheck} disabled={busy}>{busy ? "Checking…" : "Run check"}</button>
            {busy && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
            <button className="btn" onClick={loadNotIndexed} disabled={busy}>Load not-indexed from Indexing tab</button>
            <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={google} onChange={(e) => setGoogle(e.target.checked)} disabled={busy} />
              Also try Google site: check
            </label>
            {progress.total > 0 && <span className="muted">Checked {num(progress.done)} of {num(progress.total)}</span>}
          </div>
        </div>
      </Section>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {rows.length > 0 && (
        <>
          <Kpis
            items={[
              { label: "HTTP 200", value: count((r) => r.pageStatus === 200) },
              { label: "Redirects (3xx)", value: count((r) => r.pageStatus >= 300 && r.pageStatus < 400) },
              { label: "Errors (4xx/5xx/none)", value: count((r) => r.pageStatus === 0 || r.pageStatus >= 400) },
              { label: "noindex", value: count((r) => r.noindex === "yes") },
              { label: "Canonical elsewhere", value: count((r) => r.canonicalElsewhere) },
              { label: "Google: in results", value: count((r) => r.googleResult === "found") },
            ]}
          />
          <DataTable rows={rows} cols={cols} csvName="site-check.csv" pageSize={50} empty="No results yet." />
        </>
      )}
    </main>
  );
}
