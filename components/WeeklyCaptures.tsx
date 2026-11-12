// components/WeeklyCaptures.tsx
"use client";
// The "Weekly captures" tab. Page indexing, Crawl stats and AI impressions have no Google API, so the team's Chrome
// extension copies them from Search Console once a week. Everyone sees what was updated, by whom and when; only the
// capture accounts (CAPTURE_EMAILS) see the Chrome extension section and can download it.
import { useCallback, useEffect, useState } from "react";
import { PanelTitle, Section } from "./ui";
import { viaOf } from "./UpdatedBy";

type Update = { report: string; at: string; by: string; source: string; from: string; to: string };
type Status = { configured: boolean; canCapture: boolean; captures?: Update[]; history?: Update[] };

const DAY = 864e5;
const STALE_DAYS = 8;
const when = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString() : "–");
const ageDays = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? (Date.now() - Date.parse(iso)) / DAY : Infinity);
const agoText = (iso: string) => {
  const d = ageDays(iso);
  if (!isFinite(d)) return "never";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h ago`;
  return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};
const how = (u: Update) => (u.source === "Deleted" ? "Deleted" : viaOf(u.source) || "–");
const dates = (u: Update) => (u.from && u.to ? `${u.from} to ${u.to}` : "–");

export default function WeeklyCaptures({ site }: { site: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/captures?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setSt(j as Status);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load the weekly captures");
    }
  }, [site]);

  useEffect(() => {
    setSt(null);
    setErr(null);
    load();
  }, [load]);

  /** Downloads the extension zip, already set up with this dashboard's address and the person's key. */
  const downloadExtension = async () => {
    setDownloading(true);
    setKeyErr(null);
    try {
      const r = await fetch("/api/extension", { cache: "no-store" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Download failed (${r.status})`);
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "kr-search-capture.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setKeyErr(e instanceof Error ? e.message : "Couldn't download the extension");
    }
    setDownloading(false);
  };

  const showKey = async () => {
    setKeyErr(null);
    try {
      const r = await fetch("/api/capture/key", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setKey(String(j.key || ""));
    } catch (e) {
      setKeyErr(e instanceof Error ? e.message : "Couldn't get your key");
    }
  };
  const copyKey = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setKeyErr("Couldn't copy. Select the key and press Ctrl+C.");
    }
  };

  const history = st?.history || [];

  return (
    <>
      <Section
        title="Weekly Search Console captures"
        lede="Page indexing counts, Crawl stats and AI impressions have no Google API. They're copied from Search Console once a week and saved in the Google Sheet with their full history. Here you can see when each report was last updated and by whom."
      >
        {err && <div className="notice error">{err}</div>}
        {!st && !err && <p className="muted">Loading…</p>}
        {st && !st.configured && <div className="notice">The Google Sheet isn&apos;t set up yet, so there are no captures to show.</div>}

        {st?.configured && (
          <>
            <div className="panel">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Report</th>
                      <th>Last updated</th>
                      <th>By</th>
                      <th>How</th>
                      <th>Dates covered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(st.captures || []).map((c) => {
                      const stale = ageDays(c.at) > STALE_DAYS;
                      return (
                        <tr key={c.report}>
                          <td>{c.report}</td>
                          <td>
                            <span className={`delta ${!c.at ? "flat" : stale ? "bad" : "good"}`}>{c.at ? agoText(c.at) : "Never"}</span>
                            {stale && <span className="muted"> · due</span>}
                            {c.at && <div className="muted">{when(c.at)}</div>}
                          </td>
                          <td>{c.by || "–"}</td>
                          <td>{c.at ? how(c) : "–"}</td>
                          <td>{dates(c)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ marginBottom: 0 }}>
                A report shows as <b>due</b> when its last update is more than a week old.
              </p>
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle>Update history</PanelTitle>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Report</th>
                      <th>By</th>
                      <th>How</th>
                      <th>Dates covered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((u, i) => (
                      <tr key={`${u.report}-${u.at}-${i}`}>
                        <td>
                          {when(u.at)}
                          <div className="muted">{agoText(u.at)}</div>
                        </td>
                        <td>{u.report}</td>
                        <td>{u.by || "–"}</td>
                        <td>{how(u)}</td>
                        <td>{dates(u)}</td>
                      </tr>
                    ))}
                    {!history.length && (
                      <tr>
                        <td colSpan={5} className="muted">No updates yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {st && !st.canCapture && (
          <p className="muted" style={{ marginBottom: 0 }}>
            These reports are updated by the team members who run the weekly captures.
          </p>
        )}
      </Section>

      {st?.canCapture && (
        <Section
          title="Chrome extension"
          lede="You're one of the people who run the weekly captures. The extension copies the three reports from Search Console once a week for every property with daily index checks, using your Google sign-in. Only capture accounts see this section and can send updates."
        >
          <div className="panel">
            <div className="row" style={{ alignItems: "center" }}>
              <button className="btn primary" onClick={downloadExtension} disabled={downloading}>
                {downloading ? "Preparing…" : "Download the extension"}
              </button>
              <span className="muted">Already set up with this dashboard&apos;s address and your personal key.</span>
            </div>
            <ol className="muted" style={{ marginTop: 12, paddingLeft: 18 }}>
              <li>
                Unzip <b>kr-search-capture.zip</b> (right-click → Extract All) and keep the folder somewhere permanent, such as
                Documents. Chrome runs the extension from that folder, so don&apos;t delete it.
              </li>
              <li>
                In Chrome, open <code>chrome://extensions</code>, turn on <b>Developer mode</b> (top right), click{" "}
                <b>Load unpacked</b> and choose the <b>kr-search-capture</b> folder.
              </li>
              <li>
                That&apos;s it. Keep this Chrome profile signed in to the Google account you use for Search Console. The first capture
                starts within a few minutes, then once a week for every property with daily index checks. Click the extension&apos;s
                icon to see its status or to capture now.
              </li>
            </ol>
            <p className="muted" style={{ marginBottom: 0 }}>
              The download is personal: captures are saved under your name, so don&apos;t share the file. An admin can cancel every key
              by changing <code>CAPTURE_SECRET</code> in Vercel (then the capture accounts download again).
            </p>

            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: "pointer" }}>Set up by hand instead</summary>
              <p className="muted">
                If you installed the extension from the project files, open its settings and enter this dashboard&apos;s address (
                {typeof window !== "undefined" ? window.location.origin : ""}) and your key:
              </p>
              <div className="row" style={{ alignItems: "center" }}>
                {!key ? (
                  <button className="btn" onClick={showKey}>Show my extension key</button>
                ) : (
                  <>
                    <input
                      readOnly
                      value={key}
                      onFocus={(e) => e.target.select()}
                      style={{ minWidth: 360, fontFamily: "monospace" }}
                      aria-label="Your extension key"
                    />
                    <button className="btn" onClick={copyKey}>{copied ? "Copied" : "Copy"}</button>
                  </>
                )}
              </div>
            </details>
            {keyErr && <p className="notice error" style={{ marginBottom: 0 }}>{keyErr}</p>}
          </div>
        </Section>
      )}
    </>
  );
}
