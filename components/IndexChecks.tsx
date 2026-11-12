// components/IndexChecks.tsx
"use client";
// The "Index checks" tab. Daily URL Inspection runs on the server for this property (results live in the Google
// Sheet): today's progress, per-sitemap verification and status changes found. It also shows Google's own latest
// count from the Page indexing report (saved by the weekly capture) next to the checker's confirmed counts.
// Anyone who can open the property in Search Console can start the checks; they run as the service account when an
// owner has added it, otherwise with the starter's Google sign-in. The weekly captures have their own tab.
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, Kpis, PanelTitle, Section, num, pct, type Col, type KpiItem } from "./ui";

const SA_LABEL = "Service account";

type Job = {
  tab: string; enabled: boolean; budget: number; planDay: string; planStatus: string;
  queued: number; checkedToday: number; lastRun: string; message: string; runAs: string;
};
type SitemapRow = {
  sitemap: string; urls: number; verified: number; indexed: number; notIndexed: number;
  errors: number; notChecked: number; pctVerified: number; updated: string;
};
type Change = { at: string; url: string; change: string; before: string; after: string; link: string };
type GoogleReport = { indexed: number; notIndexed: number; date: string; savedAt: string; by: string };
type Status = {
  configured: boolean; serviceAccount?: string; saCanRead?: boolean; job?: Job | null; sitemaps?: SitemapRow[];
  changes?: Change[]; sheetUrl?: string; report?: GoogleReport | null;
};

const DAY = 864e5;
const pacificToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const when = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString() : "–");
const ageDays = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? (Date.now() - Date.parse(iso)) / DAY : Infinity);
const agoText = (iso: string) => {
  const d = ageDays(iso);
  if (!isFinite(d)) return "never";
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h ago`;
  return `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};

function Progress({ value }: { value: number }) {
  const p = Math.max(0, Math.min(100, value));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ background: "#e7ebef", borderRadius: 4, height: 8, width: 110 }}>
        <div style={{ width: `${p}%`, background: p >= 100 ? "#1e8e3e" : "#1a73e8", height: 8, borderRadius: 4 }} />
      </div>
      <span>{p.toFixed(p >= 10 ? 0 : 1)}%</span>
    </div>
  );
}

const TONE: Record<string, string> = {
  "Dropped from Google's index": "no",
  "Impressions stopped": "warn",
  "Impressions stopped, still indexed": "warn",
  "Newly indexed": "ok",
  "Now appearing in search": "ok",
};

const SITEMAP_COLS: Col<SitemapRow>[] = [
  {
    key: "sitemap",
    label: "Sitemap",
    render: (r) =>
      /^https?:\/\//.test(r.sitemap) ? (
        <a href={r.sitemap} target="_blank" rel="noreferrer">{r.sitemap}</a>
      ) : (
        <span className="muted">{r.sitemap}</span>
      ),
  },
  { key: "urls", label: "URLs", num: true, render: (r) => num(r.urls) },
  { key: "verified", label: "Verified", num: true, render: (r) => num(r.verified) },
  { key: "indexed", label: "Indexed", num: true, render: (r) => num(r.indexed) },
  { key: "notIndexed", label: "Not indexed", num: true, render: (r) => num(r.notIndexed) },
  { key: "errors", label: "Errors", num: true, render: (r) => num(r.errors) },
  { key: "notChecked", label: "Not checked yet", num: true, render: (r) => num(r.notChecked) },
  { key: "pctVerified", label: "Verified so far", num: true, render: (r) => <Progress value={r.pctVerified} /> },
];

const CHANGE_COLS: Col<Change>[] = [
  { key: "at", label: "When", render: (r) => when(r.at) },
  { key: "change", label: "Change", render: (r) => <span className={`pill ${TONE[r.change] || "warn"}`}>{r.change}</span> },
  { key: "url", label: "URL", url: true },
  { key: "before", label: "Before" },
  { key: "after", label: "After" },
  { key: "link", label: "", render: (r) => (r.link ? <a href={r.link} target="_blank" rel="noreferrer">Search Console</a> : "") },
];

export default function IndexChecks({ site }: { site: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changeFilter, setChangeFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/index-checks?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setSt(j as Status);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load index checks");
    }
  }, [site]);

  useEffect(() => {
    setSt(null);
    setErr(null);
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/index-checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setSt(j as Status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't change the setting");
    }
    setBusy(false);
  };

  const job = st?.job || null;
  const report = st?.report || null;
  const sitemaps = useMemo(() => st?.sitemaps || [], [st]);
  const totals = useMemo(() => {
    const real = sitemaps.filter((x) => x.urls > 0);
    const t = real.reduce(
      (a, x) => ({
        urls: a.urls + x.urls, verified: a.verified + x.verified, indexed: a.indexed + x.indexed,
        notIndexed: a.notIndexed + x.notIndexed, errors: a.errors + x.errors, notChecked: a.notChecked + x.notChecked,
      }),
      { urls: 0, verified: 0, indexed: 0, notIndexed: 0, errors: 0, notChecked: 0 }
    );
    const files = real.filter((x) => /^https?:\/\//.test(x.sitemap));
    return {
      ...t,
      files: files.length,
      complete: files.filter((x) => x.notChecked === 0 && x.errors === 0).length,
      problems: sitemaps.filter((x) => x.urls === 0 && /^Couldn't read/.test(x.updated)),
      updated: sitemaps.map((x) => x.updated).filter((u) => !isNaN(Date.parse(u))).sort().pop() || "",
    };
  }, [sitemaps]);

  const changes = st?.changes || [];
  const changeTypes = useMemo(() => Array.from(new Set(changes.map((c) => c.change))), [changes]);
  const shownChanges = changeFilter === "all" ? changes : changes.filter((c) => c.change === changeFilter);

  const runsAsPerson = !!job && job.runAs !== SA_LABEL;
  const state = !job
    ? "Not started"
    : !job.enabled
      ? "Paused"
      : job.planStatus === "error" || /^Checks paused/.test(job.message)
        ? "Needs attention"
        : job.planStatus === "planning"
          ? "Planning today's checks"
          : job.planDay !== pacificToday()
            ? "Waiting for today's plan"
            : job.queued > 0
              ? "Checking"
              : "Done for today";

  /** Days until every tracked URL has been checked once, at the daily budget. */
  const daysLeft = job && totals.notChecked ? Math.ceil(totals.notChecked / Math.max(1, job.budget)) : 0;

  const kpis: KpiItem[] = job
    ? [
        { label: "Status", value: state, sub: job.lastRun ? `last run ${agoText(job.lastRun)}` : undefined },
        {
          label: "Indexed (Google's report)",
          value: report ? num(report.indexed) : "–",
          sub: report ? `as of ${report.date} · Page indexing report` : "no weekly capture yet",
        },
        {
          label: "Not indexed (Google's report)",
          value: report ? num(report.notIndexed) : "–",
          sub: report ? `of ${num(report.indexed + report.notIndexed)} pages Google knows` : undefined,
        },
        {
          label: "Confirmed indexed",
          value: num(totals.indexed),
          sub: totals.verified ? `${pct(totals.indexed / totals.verified, 1)} of URLs checked so far` : "checked by this tool",
        },
        { label: "Confirmed not indexed", value: num(totals.notIndexed), sub: "by URL Inspection" },
        {
          label: "Not checked yet",
          value: num(totals.notChecked),
          sub: daysLeft ? `about ${num(daysLeft)} day${daysLeft === 1 ? "" : "s"} to finish at ${num(job.budget)} a day` : "every URL checked",
        },
        { label: "URLs tracked", value: num(totals.urls), sub: `${num(totals.files)} sitemap file(s) + pages seen in search` },
        { label: "Inspected today", value: num(job.checkedToday), sub: `of ${num(job.budget)} a day · ${num(job.queued)} still queued` },
        {
          label: "Runs as",
          value: runsAsPerson ? "Google sign-in" : "Service account",
          sub: runsAsPerson ? job.runAs : st?.serviceAccount,
        },
      ]
    : [];

  return (
    <Section
      title="Index checks"
      lede="Google's URL Inspection, run every day by the server for this property, so nobody needs to keep a tab open. Pages with Search impressions count as indexed for free; the daily inspections go to pages whose impressions stopped, new and changed pages, and results older than 30 days. Every result is saved in the shared Google Sheet, so anyone who opens this property sees the same data and nothing is checked twice."
    >
      {err && <div className="notice error">{err}</div>}
      {!st && !err && <p className="muted">Loading…</p>}

      {st && !st.configured && (
        <div className="notice">
          Index checks need the service account and the Google Sheet. Add <code>GOOGLE_SERVICE_ACCOUNT_JSON</code>,{" "}
          <code>INDEX_SHEET_ID</code> and <code>CRON_SECRET</code> in Vercel → Settings → Environment Variables, then redeploy.
        </div>
      )}

      {st?.configured && !job && (
        <div className="panel">
          <PanelTitle>Start daily index checks for this property</PanelTitle>
          <p style={{ marginTop: 0 }}>
            The server will read this property&apos;s sitemaps every day and inspect up to 1,800 URLs a day, saving each result
            in this property&apos;s tab of the shared Google Sheet. Google allows 2,000 inspections a day per property, so about
            200 stay free for people using the dashboard.
          </p>
          <p className="muted">
            {st.saCanRead
              ? "The service account already has access to this property, so the checks will run as the service account."
              : `The service account (${st.serviceAccount || "not set"}) hasn't been added to this property, so the checks will run with your own Google sign-in. You don't need to be an owner. If an owner adds the service account later, the checks switch to it automatically.`}
          </p>
          <button className="btn primary" onClick={() => post({ enabled: true })} disabled={busy}>
            {busy ? "Starting…" : "Start daily index checks"}
          </button>
        </div>
      )}

      {st?.configured && job && (
        <>
          {!job.enabled && (
            <div className="notice" style={{ marginBottom: 12 }}>
              Daily checks are paused for this property, so no URLs are being inspected. Click <b>Resume daily checks</b> below to
              continue where they stopped.
            </div>
          )}

          <Kpis items={kpis} />

          <p className="muted" style={{ margin: "8px 0 0" }}>
            <b>Google&apos;s report</b> is Google&apos;s own total for every page it knows about, from the Page indexing report
            (saved by the weekly capture; Google updates it with a delay of a few days). <b>Confirmed</b> counts are this tool&apos;s
            page-by-page checks of the URLs in your sitemaps and search results; they fill in over the coming days until every URL
            has been checked.
          </p>

          <div className="panel" style={{ marginTop: 12 }}>
            <p style={{ marginTop: 0 }}>{job.message || "Waiting for the first daily plan (it runs every hour)."}</p>
            {runsAsPerson && (
              <p className="muted">
                These checks use <b>{job.runAs}</b>&apos;s Google sign-in because the service account hasn&apos;t been added to this
                property. If that stops working (for example the person leaves or loses access), anyone who can open the
                property can take over with “Use my Google sign-in”. Ask an owner to add {st.serviceAccount} to make it
                independent of any one person.
              </p>
            )}
            <div className="row" style={{ alignItems: "center" }}>
              <button className={`btn${job.enabled ? "" : " primary"}`} onClick={() => post({ enabled: !job.enabled })} disabled={busy}>
                {job.enabled ? "Pause daily checks" : "Resume daily checks"}
              </button>
              {!st.saCanRead && (
                <button className="btn" onClick={() => post({ enabled: true, useMine: true })} disabled={busy}>
                  Use my Google sign-in
                </button>
              )}
              {st.sheetUrl && (
                <a className="btn" href={st.sheetUrl} target="_blank" rel="noreferrer">
                  Open the Google Sheet (tab “{job.tab}”)
                </a>
              )}
              <button className="btn" onClick={load}>Refresh</button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              The plan runs once a day after Google&apos;s quota resets (midnight Pacific time, 13:30 India time); checks then
              run every 10 minutes until the day&apos;s queue is done. The browser&apos;s Live index monitor is switched off for
              this property so the two don&apos;t share Google&apos;s daily limit.
            </p>
          </div>

          <details className="panel" style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer" }}>
              <b>Sitemaps</b>: {num(totals.complete)} of {num(totals.files)} fully verified ·{" "}
              {totals.urls ? pct(totals.verified / totals.urls, 1) : "0%"} of URLs verified
              {totals.problems.length ? ` · ${totals.problems.length} couldn't be read` : ""}
              {totals.updated ? <span className="muted"> · updated {agoText(totals.updated)}</span> : null}
            </summary>
            <div style={{ marginTop: 12 }}>
              <DataTable
                rows={sitemaps.filter((x) => x.urls > 0)}
                cols={SITEMAP_COLS}
                initialSort="urls"
                pageSize={25}
                csvName="sitemap-verification.csv"
                empty="No sitemap summary yet. It appears after the first daily plan."
              />
              {totals.problems.length > 0 && (
                <div className="notice error" style={{ marginTop: 12 }}>
                  {totals.problems.map((p) => (
                    <div key={p.sitemap}>
                      {p.sitemap}: {p.updated.replace(/^Couldn't read:\s*/, "")}
                    </div>
                  ))}
                </div>
              )}
              <p className="muted" style={{ marginBottom: 0 }}>
                Verified = Google&apos;s answer is known (indexed or not), from URL Inspection or from Search impressions. The list
                of pages for each sitemap is in the Sheet.
              </p>
            </div>
          </details>

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
              <PanelTitle>Status changes found</PanelTitle>
              <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                Show
                <select value={changeFilter} onChange={(e) => setChangeFilter(e.target.value)}>
                  <option value="all">All changes ({changes.length})</option>
                  {changeTypes.map((t) => (
                    <option key={t} value={t}>
                      {t} ({changes.filter((c) => c.change === t).length})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DataTable
              rows={shownChanges}
              cols={CHANGE_COLS}
              initialSort="at"
              pageSize={20}
              csvName="index-status-changes.csv"
              csvRow={(r) => ({ when: r.at, change: r.change, url: r.url, before: r.before, after: r.after, search_console_link: r.link })}
              empty="No status changes yet. They appear once pages have been checked at least twice, or when their impressions stop."
            />
          </div>
        </>
      )}
    </Section>
  );
}
