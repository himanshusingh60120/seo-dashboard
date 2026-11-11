// components/UrlCheck.tsx
"use client";
// Indexing tab, bottom: check specific pages with Google's URL Inspection API (indexed or not, Google's reason, last crawl).
import { useMemo, useState } from "react";
import { DataTable, PanelTitle, Section, num, shortUrl, type Col } from "./ui";

type Insp = {
  url: string;
  verdict: string;
  coverageState: string;
  lastCrawlTime: string;
  crawledAs: string;
  googleCanonical: string;
  link: string;
};
type Row = { url: string; status: string; reason: string; lastCrawl: string; crawledAs: string; canonical: string; link: string };

const MAX = 100;
const BATCH = 20; // the inspect route accepts up to 20 URLs per request

const statusOf = (verdict: string) => (verdict === "PASS" ? "Indexed" : verdict === "ERROR" ? "Check failed" : "Not indexed");
const same = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

function toRow(x: Insp): Row {
  return {
    url: x.url,
    status: statusOf(x.verdict),
    reason: x.coverageState || "",
    lastCrawl: x.lastCrawlTime ? x.lastCrawlTime.slice(0, 16).replace("T", " ") : "Never",
    crawledAs: /MOBILE/i.test(x.crawledAs) ? "Smartphone" : /DESKTOP/i.test(x.crawledAs) ? "Desktop" : "–",
    canonical: x.googleCanonical && !same(x.googleCanonical, x.url) ? x.googleCanonical : "",
    link: x.link || "",
  };
}

function Status({ s }: { s: string }) {
  const cls = s === "Indexed" ? "good" : s === "Not indexed" ? "bad" : "flat";
  return <span className={`delta ${cls}`}>{s}</span>;
}

const COLS: Col<Row>[] = [
  { key: "url", label: "Page", url: true },
  { key: "status", label: "Status", render: (r) => <Status s={r.status} /> },
  { key: "reason", label: "Google's reason" },
  { key: "lastCrawl", label: "Last crawled" },
  { key: "crawledAs", label: "Crawled as" },
  {
    key: "canonical",
    label: "Google-chosen canonical",
    render: (r) =>
      r.canonical ? (
        <a href={r.canonical} target="_blank" rel="noreferrer">
          {shortUrl(r.canonical)}
        </a>
      ) : (
        <span className="muted">same</span>
      ),
  },
  {
    key: "link",
    label: "",
    render: (r) =>
      r.link ? (
        <a href={r.link} target="_blank" rel="noreferrer">
          Open in Search Console
        </a>
      ) : (
        ""
      ),
  },
];

export default function UrlCheck({ site }: { site: string }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const urls = useMemo(
    () => Array.from(new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))),
    [text]
  );
  const base = site.startsWith("sc-domain:") ? `https://${site.slice(10)}/` : site;

  const run = async () => {
    const list = urls.slice(0, MAX);
    if (!list.length) return;
    setBusy(true);
    setMsg(null);
    setRows([]);
    const out: Row[] = [];
    let notAccepted = 0;
    let notChecked = 0;
    let stop = "";
    for (let i = 0; i < list.length; i += BATCH) {
      try {
        const r = await fetch("/api/gsc/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteUrl: site, urls: list.slice(i, i + BATCH) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        for (const x of (j.results || []) as Insp[]) out.push(toRow(x));
        notAccepted += j.notAccepted || 0;
        notChecked += (j.skipped || []).length;
        setRows([...out]);
        if (j.quotaExceeded) {
          stop = "Google's daily URL Inspection limit for this property (about 2,000) is used up. Check the rest tomorrow.";
          notChecked += Math.max(0, list.length - i - BATCH);
          break;
        }
        if (j.rateLimited) {
          stop = "Google asked to slow down. Wait a minute, then check the remaining pages.";
          notChecked += Math.max(0, list.length - i - BATCH);
          break;
        }
      } catch (e) {
        stop = e instanceof Error ? e.message : "Check failed";
        break;
      }
    }
    const indexed = out.filter((r) => r.status === "Indexed").length;
    const notIndexed = out.filter((r) => r.status === "Not indexed").length;
    const parts = [`Checked ${num(out.length)} page${out.length === 1 ? "" : "s"}: ${num(indexed)} indexed, ${num(notIndexed)} not indexed.`];
    if (urls.length > MAX) parts.push(`Only the first ${MAX} were checked.`);
    if (notAccepted) parts.push(`${notAccepted} skipped because they aren't part of this property.`);
    if (notChecked) parts.push(`${notChecked} not checked.`);
    if (stop) parts.push(stop);
    setMsg({ text: parts.join(" "), error: !!stop });
    setBusy(false);
  };

  return (
    <Section
      title="Check specific pages"
      lede="Paste page URLs to see whether Google has indexed them, Google's reason if not, and when Googlebot last crawled them. Uses Google's URL Inspection API, which allows about 2,000 checks per property per day."
    >
      <div className="panel">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          style={{ width: "100%" }}
          placeholder={`${base}page-1\n${base}page-2`}
          aria-label="Pages to check"
        />
        <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
          <button className="btn primary" onClick={run} disabled={busy || !urls.length}>
            {busy ? "Checking…" : urls.length ? `Check ${num(Math.min(urls.length, MAX))} page${urls.length === 1 ? "" : "s"}` : "Check pages"}
          </button>
          <span className="muted">One URL per line, up to {MAX} at a time.</span>
        </div>
        {msg && (
          <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>
            {msg.text}
          </p>
        )}
      </div>

      {rows.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <PanelTitle>Results</PanelTitle>
          <DataTable rows={rows} cols={COLS} initialSort="status" csvName="url-checks.csv" />
        </div>
      )}
    </Section>
  );
}
