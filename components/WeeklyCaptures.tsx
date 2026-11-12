// components/WeeklyCaptures.tsx
"use client";
// The "Weekly captures" tab. Page indexing, Crawl stats and AI impressions have no Google API, so the team's Chrome
// extension copies them from Search Console once a week, for every property with daily index checks and every property
// added here with "Capture this property now". Everyone sees what was updated, by whom and when; only the capture
// accounts (CAPTURE_EMAILS) see the capture button and the Chrome extension section.
import { useCallback, useEffect, useState } from "react";
import { PanelTitle, Section } from "./ui";
import { viaOf } from "./UpdatedBy";

type Update = { report: string; at: string; by: string; source: string; from: string; to: string };
type Status = {
  configured: boolean; canCapture: boolean; captures?: Update[]; history?: Update[]; weekly?: boolean; why?: string;
};

type Kind = "indexing" | "crawl" | "ai";
const KINDS: { id: Kind; label: string }[] = [
  { id: "indexing", label: "Page indexing" },
  { id: "crawl", label: "Crawl stats" },
  { id: "ai", label: "AI impressions" },
];
type ExtReport = { ok?: boolean; okAt?: number; triedAt?: number; message?: string } | null;
type ExtStatus = { running: boolean; now: string; error?: string; reports: Record<Kind, ExtReport> };
type Run = { startedAt: number; status: ExtStatus | null; done: boolean };

const DAY = 864e5;
const STALE_DAYS = 8;
/** Stop following a capture after this long. */
const RUN_LIMIT = 20 * 60e3;
const when = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString() : "–");
const ageDays = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? (Date.now() - Date.parse(iso)) / DAY : Infinity);
const agoText = (iso: string) => {
  const d = ageDays(iso);
  if (!isFinite(d)) return "never";
  const mins = d * 24 * 60;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (d < 1) return `${Math.round(d * 24)} h ago`;
  return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};
const how = (u: Update) => (u.source === "Deleted" ? "Deleted" : viaOf(u.source) || "–");
const dates = (u: Update) => (u.from && u.to ? `${u.from} to ${u.to}` : "–");
const shortName = (site: string) => site.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Sends a message to the Chrome extension through bridge.js on this page; null if nothing answers in time. */
function askExtension(type: string, extra: Record<string, unknown> = {}, timeout = 1500): Promise<any | null> {
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const d = e.data;
      if (d && d.kind === "kr-capture-reply" && d.id === id) finish(d);
    };
    const timer = setTimeout(() => finish(null), timeout);
    function finish(v: any | null) {
      window.removeEventListener("message", on);
      clearTimeout(timer);
      resolve(v);
    }
    window.addEventListener("message", on);
    window.postMessage({ kind: "kr-capture", type, id, ...extra }, window.location.origin);
  });
}

/** How one report of a capture started from this page is going. */
function reportState(kind: Kind, label: string, run: Run): { text: string; tone: "good" | "bad" | "flat" } {
  const s = run.status;
  const r = s?.reports?.[kind];
  if (r?.okAt && r.okAt >= run.startedAt) return { text: "Saved", tone: "good" };
  if (s?.running && s.now.startsWith(label)) return { text: "Working…", tone: "flat" };
  if (r?.triedAt && r.triedAt >= run.startedAt && r.ok === false) return { text: `Failed: ${r.message || "unknown error"}`, tone: "bad" };
  return { text: run.done ? "Not captured" : "Waiting", tone: "flat" };
}

export default function WeeklyCaptures({ site }: { site: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [ext, setExt] = useState<"checking" | "ready" | "missing">("checking");
  const [run, setRun] = useState<Run | null>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);

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
    setRun(null);
    setNote(null);
    setRunErr(null);
    load();
  }, [load]);

  // Is the Chrome extension (with the dashboard bridge) installed in this browser?
  const canCapture = !!st?.canCapture;
  useEffect(() => {
    if (!canCapture) return;
    let live = true;
    askExtension("ping").then((r) => {
      if (live) setExt(r ? "ready" : "missing");
    });
    return () => {
      live = false;
    };
  }, [canCapture]);

  // Follow a capture started from this page.
  const following = !!run && !run.done;
  useEffect(() => {
    if (!following) return;
    let live = true;
    const t = setInterval(async () => {
      const s = (await askExtension("status", { site })) as ExtStatus | null;
      if (!live) return;
      setRun((cur) => {
        if (!cur || cur.done) return cur;
        const status = s || cur.status;
        const elapsed = Date.now() - cur.startedAt;
        const tried = (k: Kind) => (status?.reports?.[k]?.triedAt || 0) >= cur.startedAt;
        const finished = !!status && !status.running && KINDS.every(({ id }) => tried(id));
        const stalled = !!status && !status.running && elapsed > 30_000 && KINDS.every(({ id }) => !tried(id));
        return { ...cur, status, done: finished || stalled || elapsed > RUN_LIMIT };
      });
    }, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [following, site]);

  // When it finishes, reload the table and the history.
  const runDone = !!run?.done;
  useEffect(() => {
    if (runDone) load();
  }, [runDone, load]);

  /** Adds the property to the weekly captures (the server checks access) and asks the extension to capture it now. */
  const captureNow = async () => {
    setStarting(true);
    setNote(null);
    setRunErr(null);
    try {
      const r = await fetch("/api/captures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setSt((cur) => (cur ? { ...cur, weekly: j.weekly, why: j.why } : cur));
      if (ext !== "ready") {
        setNote(
          j.added
            ? "Added to the weekly captures. The Chrome extension captures it at its next hourly check."
            : "This property is already in the weekly captures."
        );
        return;
      }
      const t0 = Date.now();
      const res = await askExtension("run", { site }, 5000);
      if (!res || !res.ok) throw new Error(res?.error || "The Chrome extension didn't answer. Reload this page and try again.");
      setRun({ startedAt: t0, status: null, done: false });
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : "Couldn't start the capture");
    } finally {
      setStarting(false);
    }
  };

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
  const name = shortName(site);
  const buttonLabel =
    ext === "ready"
      ? st?.weekly
        ? `Capture ${name} now`
        : `Capture ${name} now and add it to the weekly captures`
      : "Add to the weekly captures";

  return (
    <>
      <Section
        title="Weekly Search Console captures"
        lede="Page indexing counts, Crawl stats and AI impressions have no Google API. They're copied from Search Console once a week and saved in the Google Sheets with their full history. Here you can see when each report was last updated and by whom."
      >
        {err && <div className="notice error">{err}</div>}
        {!st && !err && <p className="muted">Loading…</p>}
        {st && !st.configured && <div className="notice">The Google Sheet isn&apos;t set up yet, so there are no captures to show.</div>}

        {st?.configured && st.canCapture && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <PanelTitle>{name}</PanelTitle>
            <p style={{ marginTop: 0 }}>
              {st.weekly ? (
                <>
                  <span className="delta good">In the weekly captures</span>
                  <span className="muted"> · {st.why}</span>
                </>
              ) : (
                <span className="muted">Not in the weekly captures yet.</span>
              )}
            </p>
            {!(ext === "missing" && st.weekly) && (
              <button
                className="btn primary"
                onClick={captureNow}
                disabled={starting || ext === "checking" || following}
              >
                {starting ? "Starting…" : following ? "Capturing…" : buttonLabel}
              </button>
            )}
            {ext === "missing" && (
              <p className="muted" style={{ marginBottom: 0 }}>
                The Chrome extension wasn&apos;t found in this browser, or it&apos;s an older version. Download it again below to
                capture from here; it still captures this property every week on its own.
              </p>
            )}

            {run && (
              <ul style={{ margin: "12px 0 0", paddingLeft: 18 }}>
                {KINDS.map(({ id, label }) => {
                  const r = reportState(id, label, run);
                  return (
                    <li key={id}>
                      {label}: <span className={`delta ${r.tone}`}>{r.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {run && !run.done && (
              <p className="muted" style={{ marginBottom: 0 }}>
                A small Chrome window opens and closes by itself; this takes a few minutes. You can keep working.
              </p>
            )}
            {run?.done && run.status?.error && <div className="notice error" style={{ marginTop: 8 }}>{run.status.error}</div>}
            {note && <p className="muted" style={{ marginBottom: 0 }}>{note}</p>}
            {runErr && <div className="notice error" style={{ marginTop: 8 }}>{runErr}</div>}
          </div>
        )}

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
          lede="You're one of the people who run the weekly captures. The extension copies the three reports from Search Console once a week for every property in the weekly captures, using your Google sign-in. Only capture accounts see this section and can send updates."
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
                Documents. Chrome runs the extension from that folder, so don&apos;t delete it. Updating? Extract over the old
                folder (replace the files).
              </li>
              <li>
                In Chrome, open <code>chrome://extensions</code>, turn on <b>Developer mode</b> (top right), click{" "}
                <b>Load unpacked</b> and choose the <b>kr-search-capture</b> folder. Updating? Click the extension&apos;s reload
                icon (↻) instead, then reload this page.
              </li>
              <li>
                That&apos;s it. Keep this Chrome profile signed in to the Google account you use for Search Console. The extension
                captures every property in the weekly captures once a week; use the button at the top of this tab to capture one
                right away. Click the extension&apos;s icon to see its status.
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
