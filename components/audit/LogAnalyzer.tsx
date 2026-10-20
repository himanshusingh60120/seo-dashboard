// components/audit/LogAnalyzer.tsx
"use client";
import { useEffect, useState } from "react";
import { DataTable, Kpis, Bars, PanelTitle, num } from "../ui";
import { analyzeLogs, type LogReport } from "@/lib/logParse";
import { googlebotRanges } from "@/lib/auditClient";
import { loadPart, savePart, clearPart } from "@/lib/auditStore";

type Saved = { report: LogReport; knownUrls: string[] };

export default function LogAnalyzer({ site }: { site: string }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ file: number; files: number; lines: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    loadPart<Saved>(site, "logs").then((s) => { if (alive) setSaved(s); });
    return () => { alive = false; };
  }, [site]);

  const analyze = async () => {
    if (!files.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const ranges = verify ? (await googlebotRanges()).prefixes : null;
      const known = new Set(saved?.knownUrls || []);
      const report = await analyzeLogs(files, { ranges, known, onProgress: setProgress });
      const knownUrls = Array.from(new Set((saved?.knownUrls || []).concat(report.urls.map((u) => u.path))));
      const next = { report, knownUrls };
      setSaved(next);
      savePart(site, "logs", next, true);
      if (!report.parsed) setMsg({ text: `No lines matched a known log format. First unrecognised line: ${report.sample}`, error: true });
      else if (!report.claimed) setMsg({ text: `Read ${num(report.parsed)} requests but none from Googlebot. Make sure the logs include the user-agent field.`, error: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Could not read the logs", error: true });
    }
    setBusy(false);
    setProgress(null);
  };

  const r = saved?.report;
  const basisNote = !r
    ? ""
    : r.basis === "verified"
    ? `Only requests from Google’s published crawler IPs are counted. ${num(r.claimed - r.verified)} more requests used a Googlebot user-agent from other IPs (fake bots, or proxy IPs).`
    : r.verifyRequested
    ? "No IP matched Google’s crawler ranges, so counts use the user-agent only. Your logs probably record CDN or proxy IPs instead of the visitor’s IP."
    : "Counted by user-agent only (IP check off).";

  return (
    <>
      <div className="panel">
        <PanelTitle>Count Googlebot’s real visits from your access logs</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Search Console shows crawl requests only as percentages and samples. Your access log records every request, so it answers exactly
          how often Googlebot fetched each URL, which URLs it fetched once or repeatedly, and which 404s and redirects it keeps hitting. Files
          are read in this browser and never uploaded. Apache/Nginx combined or common format and JSON lines (Vercel log drains, Cloudflare,
          Google Cloud and similar) are supported; .gz files are unzipped automatically. Googlebot normally sends no Referer header, so logs
          can’t show where a 404 link lives; use URL check or Site crawl for that.
        </p>
        <div className="row">
          <label className="btn" style={{ cursor: "pointer" }}>
            Choose log files
            <input type="file" multiple hidden onChange={(e) => { setFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
          </label>
          <span className="muted">{files.length ? `${files.length} file(s): ${files.map((f) => f.name).join(", ")}` : "No files chosen"}</span>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Verify IPs against Google’s published ranges
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={analyze} disabled={busy || !files.length}>{busy ? "Reading…" : "Analyze"}</button>
          {saved && !busy && (
            <button className="btn" onClick={async () => { await clearPart(site, "logs"); setSaved(null); }}>Clear saved analysis</button>
          )}
        </div>
        {progress && <p className="muted">File {progress.file} of {progress.files} · {num(progress.lines)} lines read</p>}
        {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
      </div>

      {r && r.urls.length > 0 && (
        <>
          <div className="panel" style={{ marginTop: 16 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              {r.files.join(", ")} · {num(r.lines)} lines, {num(r.parsed)} parsed · {r.from} → {r.to} · {basisNote}
            </p>
            <Kpis
              items={[
                { label: "Googlebot requests", value: num(r.basis === "verified" ? r.verified : r.claimed), sub: `${num(Math.round((r.basis === "verified" ? r.verified : r.claimed) / Math.max(1, r.days)))} per day over ${r.days} day(s)` },
                { label: "Unique URLs crawled", value: num(r.urls.length) },
                { label: "Crawled once", value: num(r.once) },
                { label: "Crawled 2+ times", value: num(r.multi), sub: `${num(r.repeatRequests)} repeat requests` },
                { label: "New since last import", value: r.newUrls == null ? "–" : num(r.newUrls), sub: r.newUrls == null ? "first import: load later logs to compare" : "URLs not seen in earlier logs" },
              ]}
            />
          </div>
          <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 16 }}>
            <div className="panel"><PanelTitle>By response</PanelTitle><Bars items={r.byStatus} /></div>
            <div className="panel"><PanelTitle>By Google crawler</PanelTitle><Bars items={r.byBot} /></div>
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle>Requests per day</PanelTitle>
            <Bars items={r.byDay.slice(-62)} />
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle>Every URL Googlebot requested</PanelTitle>
            <DataTable
              rows={r.urls.map((u) => ({ ...u, isNewText: u.isNew ? "Yes" : "" }))}
              cols={[
                { key: "path", label: "Path" },
                { key: "hits", label: "Requests", num: true },
                { key: "statuses", label: "Responses" },
                { key: "first", label: "First seen" },
                { key: "last", label: "Last seen" },
                { key: "isNewText", label: "New" },
              ]}
              initialSort="hits"
              csvName="googlebot-urls.csv"
            />
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle>404 / 410 that Googlebot keeps requesting</PanelTitle>
            <DataTable
              rows={r.urls.filter((u) => u.s404 > 0)}
              cols={[
                { key: "path", label: "Path" },
                { key: "s404", label: "404/410 responses", num: true },
                { key: "hits", label: "All requests", num: true },
                { key: "last", label: "Last requested" },
              ]}
              initialSort="s404"
              csvName="googlebot-404s.csv"
              empty="Googlebot didn't get any 404 or 410 in these logs."
            />
          </div>
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle>Redirects and server errors Googlebot hit</PanelTitle>
            <DataTable
              rows={r.urls.filter((u) => u.s3xx > 0 || u.s5xx > 0)}
              cols={[
                { key: "path", label: "Path" },
                { key: "s3xx", label: "3xx responses", num: true },
                { key: "s5xx", label: "5xx responses", num: true },
                { key: "hits", label: "All requests", num: true },
              ]}
              initialSort="s3xx"
              csvName="googlebot-redirects-errors.csv"
              empty="No redirects or server errors in these logs."
            />
          </div>
        </>
      )}
    </>
  );
}
