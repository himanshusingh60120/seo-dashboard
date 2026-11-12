// components/IndexChecks.tsx
"use client";
// The "Index checks" tab. Every tracked URL is checked with Google's URL Inspection by the server, within the daily
// budget, in a rotation (oldest result first). The tab shows four numbers (Indexed, Not indexed, Not checked yet,
// and Google's own count from the Page indexing report), the progress of the checks, and the status changes found.
// Everything else is folded under "More details". Results live in the shared Google Sheet; one job per property,
// whoever started it, so nothing is checked twice.
import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, Kpis, PanelTitle, Section, num, pct, type Col, type KpiItem } from "./ui";

const SA_LABEL = "Service account";

type PlanStats = {
  tracked: number; verified: number; unchecked: number; seenInSearch: number; quiet: number;
  oldest: string; cycleDays: number; firstPassDays: number;
};
type Job = {
  tab: string; enabled: boolean; budget: number; planDay: string; planStatus: string;
  queued: number; checkedToday: number; lastRun: string; message: string; runAs: string; stats?: PlanStats | null;
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

/** Full-width bar: how many tracked URLs have a URL Inspection result. */
function CheckedBar({ done, total }: { done: number; total: number }) {
  const p = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div style={{ background: "#e7ebef", borderRadius: 6, height: 12, width: "100%" }} aria-label={`${p.toFixed(0)}% checked`}>
      <div style={{ width: `${p}%`, background: p >= 100 ? "#1e8e3e" : "#1a73e8", height: 12, borderRadius: 6 }} />
    </div>
  );
}

const TONE: Record<string, string> = {
  "Dropped from Google's index": "no",
  "Impressions stopped": "warn",
  "No impressions, still indexed": "ok",
  "Back in search": "ok",
  "Newly indexed": "ok",
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
  { key: "indexed", label: "Indexed", num: true, render: (r) => num(r.indexed) },
  { key: "notIndexed", label: "Not indexed", num: true, render: (r) => num(r.notIndexed) },
  { key: "notChecked", label: "Not checked yet", num: true, render: (r) => num(r.notChecked + r.errors) },
  { key: "pctVerified", label: "Checked", num: true, render: (r) => <Progress value={r.pctVerified} /> },
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
  const stats = job?.stats || null;
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
  const stateColor = state === "Checking" || state === "Done for today" ? "#1e8e3e" : state === "Paused" || state === "Needs attention" ? "#b3261e" : "#5b6573";

  const notChecked = totals.notChecked + totals.errors;
  const firstPassDays = job ? Math.ceil(notChecked / Math.max(1, job.budget)) : 0;
  const cycleDays = stats?.cycleDays || (job && totals.urls ? Math.ceil(totals.urls / Math.max(1, job.budget)) : 0);

  const kpis: KpiItem[] = job
    ? [
        { label: "Indexed", value: num(totals.indexed), sub: "confirmed by Google's URL Inspection" },
        { label: "Not indexed", value: num(totals.notIndexed), sub: "confirmed by Google's URL Inspection" },
        {
          label: "Not checked yet",
          value: num(notChecked),
          sub: notChecked ? `all checked in about ${num(firstPassDays)} day${firstPassDays === 1 ? "" : "s"}` : "every URL has been checked",
        },
        {
          label: "Google's own count",
          value: report ? num(report.indexed) : "–",
          sub: report ? `indexed of ${num(report.indexed + report.notIndexed)} pages Google knows · ${report.date}` : "from the weekly capture",
        },
      ]
    : [];

  return (
    <Section
      title="Index checks"
      lede="Every URL in your sitemaps (and every page seen in search) is checked with Google's URL Inspection by the server, up to 1,800 a day, in a rotation that never stops. Only URL Inspection decides whether a page is indexed."
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
            The server will check every URL in this property&apos;s sitemaps with Google&apos;s URL Inspection, up to 1,800 a day,
            and save each result in the shared Google Sheet. Google allows 2,000 a day per property, so about 200 stay free for
            people using the dashboard.
          </p>
          <p className="muted">
            {st.saCanRead
              ? "The service account already has access to this property, so the checks will run as the service account."
              : `The checks will run with your own Google sign-in (the service account ${st.serviceAccount || ""} hasn't been added to this property). You don't need to be an owner.`}
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
              Checks are paused for this property. Click <b>Resume</b> to continue where they stopped.
            </div>
          )}

          <Kpis items={kpis} />

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
              <div>
                <b style={{ color: stateColor }}>● {state}</b>
                <span className="muted">
                  {" "}
                  · {num(job.checkedToday)} of {num(job.budget)} checked today · {num(job.queued)} left
                  {job.lastRun ? ` · last run ${agoText(job.lastRun)}` : ""}
                </span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className={`btn${job.enabled ? "" : " primary"}`} onClick={() => post({ enabled: !job.enabled })} disabled={busy}>
                  {job.enabled ? "Pause" : "Resume"}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <CheckedBar done={totals.verified} total={totals.urls} />
              <p className="muted" style={{ margin: "6px 0 0" }}>
                Checked <b>{num(totals.verified)}</b> of {num(totals.urls)} URLs ({totals.urls ? pct(totals.verified / totals.urls, 0) : "0%"}).
                {cycleDays ? ` After the first pass, every URL is re-checked about every ${num(cycleDays)} days, automatically.` : ""}
              </p>
            </div>

            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: "pointer" }}>More details</summary>
              <ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                <li>Today&apos;s plan: {job.message || "waiting for the first daily plan (it runs every hour)."}</li>
                <li>
                  Runs as: {runsAsPerson ? `${job.runAs}'s Google sign-in` : `the service account (${st.serviceAccount})`}.
                  {runsAsPerson && " If that sign-in stops working, anyone who can open the property can take over with “Use my Google sign-in”."}
                </li>
                {stats && (
                  <li>
                    {num(stats.seenInSearch)} URLs had search impressions in the last 4 days
                    {stats.quiet ? ` · ${num(stats.quiet)} lost their impressions and are checked first` : ""}
                    {stats.oldest ? ` · oldest result: ${stats.oldest.slice(0, 10)}` : ""}.
                  </li>
                )}
                {report && (
                  <li>
                    Google&apos;s own count comes from the Page indexing report (all pages Google knows, including ones not in your
                    sitemaps), saved by the weekly capture on {when(report.savedAt)}.
                  </li>
                )}
                <li>
                  Order of checks each day: pages that stopped getting impressions, not-indexed pages seen in search again, URLs never
                  checked, pages changed in the sitemap, failed checks, then everything else (oldest result first).
                </li>
                <li>
                  The plan runs once a day after Google&apos;s quota resets (13:30 India time); checks then run every 10 minutes until
                  the day&apos;s list is done. The browser&apos;s Live index monitor is off for this property.
                </li>
              </ul>
              <div className="row" style={{ marginTop: 10, gap: 8 }}>
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
              </div>
            </details>
          </div>

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

          <details className="panel" style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer" }}>
              <b>By sitemap</b>
              <span className="muted">
                {" "}
                · {num(totals.complete)} of {num(totals.files)} fully checked
                {totals.problems.length ? ` · ${totals.problems.length} couldn't be read` : ""}
                {totals.updated ? ` · updated ${agoText(totals.updated)}` : ""}
              </span>
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
              <p className="muted" style={{ marginBottom: 0 }}>The list of pages for each sitemap, with every result, is in the Google Sheet.</p>
            </div>
          </details>
        </>
      )}
    </Section>
  );
}
