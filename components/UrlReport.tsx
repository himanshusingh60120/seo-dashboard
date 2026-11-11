// components/UrlReport.tsx
"use client";
// Everything about one page, opened from the "Look up a URL" box in the top bar:
// Google index status (URL Inspection), Google Search performance and queries (Search Console), AI impressions,
// and site traffic for the page (GA4), including visits from AI assistants.
import { useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GscData, Inspection } from "@/lib/types";
import type { Compare } from "@/lib/dates";
import type { PageQueriesResponse, PageQueryRow } from "@/app/api/gsc/page-queries/route";
import type { Ga4PageResponse, Ga4SourceRow } from "@/app/api/ga4/page/route";
import { useAiStore } from "@/lib/aiImpressions";
import { latestAiSnapshot } from "@/lib/aiStore";
import { normalizeUrl } from "@/lib/url";
import { Bars, DataTable, Delta, Kpis, PanelTitle, SourcesProvider, duration, num, pct, pos, shortUrl, useSources, type Col, type KpiItem } from "./ui";

const axis = { fontSize: 12, fill: "#5b6573" };
const DAY = 864e5;

const nice = (s?: string) => (s ? s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "–");
const same = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
const ago = (iso: string) => {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = (Date.now() - t) / DAY;
  return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};

async function getJson<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(input, { cache: "no-store", ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j as T;
}

function Status({ verdict }: { verdict: string }) {
  const s = verdict === "PASS" ? "Indexed" : verdict === "ERROR" ? "Check failed" : "Not indexed";
  return <span className={`delta ${s === "Indexed" ? "good" : s === "Not indexed" ? "bad" : "flat"}`}>{s}</span>;
}

function Change({ r }: { r: PageQueryRow }) {
  if (r.change == null) return <span className="muted">{r.status === "new" ? "new" : "–"}</span>;
  const v = r.change;
  const cls = v > 0.05 ? "bad" : v < -0.05 ? "good" : "flat";
  return <span className={`delta ${cls}`}>{v > 0 ? `▼ ${v.toFixed(1)}` : v < 0 ? `▲ ${Math.abs(v).toFixed(1)}` : "0.0"}</span>;
}

const QUERY_COLS: Col<PageQueryRow>[] = [
  { key: "query", label: "Query" },
  { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
  { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
  { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
  { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
  { key: "change", label: "Change", num: true, render: (r) => <Change r={r} /> },
];

type SourceRow = Ga4SourceRow & { sourceMedium: string; rate: number };
const SOURCE_COLS: Col<SourceRow>[] = [
  { key: "channel", label: "Channel" },
  { key: "sourceMedium", label: "Source / medium" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "rate", label: "Engagement rate", num: true, render: (r) => pct(r.rate) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
];

export default function UrlReport({
  site, url, gsc, ga4, days, compare, onClose,
}: { site: string; url: string; gsc: GscData; ga4: string; days: number; compare: Compare; onClose: () => void }) {
  const outer = useSources();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [insp, setInsp] = useState<Inspection | null>(null);
  const [inspErr, setInspErr] = useState<string | null>(null);
  const [pq, setPq] = useState<PageQueriesResponse | null>(null);
  const [pqErr, setPqErr] = useState<string | null>(null);
  const [ga, setGa] = useState<Ga4PageResponse | null>(null);
  const [gaErr, setGaErr] = useState<string | null>(null);
  const ai = useAiStore(site);
  const snap = latestAiSnapshot(ai?.store ?? null);
  const aiImpr = snap ? snap.pages[normalizeUrl(url)] ?? 0 : null;
  const path = useMemo(() => {
    try {
      return new URL(url).pathname || "/";
    } catch {
      return "/";
    }
  }, [url]);

  // Google index status (URL Inspection: 1 of about 2,000 daily checks)
  useEffect(() => {
    let live = true;
    setInsp(null);
    setInspErr(null);
    getJson<{ results?: Inspection[]; quotaExceeded?: boolean; rateLimited?: boolean }>("/api/gsc/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl: site, urls: [url] }),
    })
      .then((j) => {
        if (j.quotaExceeded) throw new Error("Google's daily URL Inspection limit for this property is used up. Try again tomorrow.");
        if (j.rateLimited) throw new Error("Google asked to slow down. Try again in a minute.");
        const x = (j.results || [])[0];
        if (!x) throw new Error("This URL isn't part of the property.");
        if (live) setInsp(x);
      })
      .catch((e) => live && setInspErr(e instanceof Error ? e.message : "Inspection failed"));
    return () => {
      live = false;
    };
  }, [site, url]);

  // Google Search performance and queries, same dates as the top bar
  useEffect(() => {
    let live = true;
    setPq(null);
    setPqErr(null);
    const q = new URLSearchParams({
      site, page: url, type: gsc.searchType || "web",
      start: gsc.range.startDate, end: gsc.range.endDate,
      pstart: gsc.previousRange.startDate, pend: gsc.previousRange.endDate,
    });
    getJson<PageQueriesResponse>(`/api/gsc/page-queries?${q}`)
      .then((j) => live && setPq(j))
      .catch((e) => live && setPqErr(e instanceof Error ? e.message : "Couldn't load Search Console data"));
    return () => {
      live = false;
    };
  }, [site, url, gsc.searchType, gsc.range.startDate, gsc.range.endDate, gsc.previousRange.startDate, gsc.previousRange.endDate]);

  // Site traffic for the page (GA4)
  useEffect(() => {
    let live = true;
    setGa(null);
    setGaErr(null);
    if (!ga4) return;
    const q = new URLSearchParams({ property: ga4, path, days: String(days), compare });
    getJson<Ga4PageResponse>(`/api/ga4/page?${q}`)
      .then((j) => live && setGa(j))
      .catch((e) => live && setGaErr(e instanceof Error ? e.message : "Couldn't load GA4 data"));
    return () => {
      live = false;
    };
  }, [ga4, path, days, compare]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const merged = useMemo(() => ({ ...outer, ...(pq?.sources || {}) }), [outer, pq]);

  /* ---------- Index status ---------- */
  const inspKpis: KpiItem[] = insp
    ? [
        { label: "Status", value: <Status verdict={insp.verdict} />, sub: insp.coverageState },
        {
          label: "Last crawled",
          value: insp.lastCrawlTime ? insp.lastCrawlTime.slice(0, 10) : "Never",
          sub: insp.lastCrawlTime ? ago(insp.lastCrawlTime) : undefined,
        },
        { label: "Crawled as", value: /MOBILE/i.test(insp.crawledAs) ? "Smartphone" : /DESKTOP/i.test(insp.crawledAs) ? "Desktop" : "–" },
        {
          label: "Google-chosen canonical",
          value: !insp.googleCanonical ? "–" : same(insp.googleCanonical, url) ? "This URL" : "A different URL",
          sub: insp.googleCanonical && !same(insp.googleCanonical, url) ? shortUrl(insp.googleCanonical) : undefined,
        },
      ]
    : [];
  const inspDetails: [string, React.ReactNode][] = insp
    ? [
        ["Indexing allowed", nice(insp.indexingState)],
        ["Page fetch", nice(insp.pageFetchState)],
        ["robots.txt", nice(insp.robotsTxtState)],
        ["Your canonical", insp.userCanonical ? shortUrl(insp.userCanonical) : "None declared"],
        ["In sitemaps", insp.sitemaps.length ? insp.sitemaps.map(shortUrl).join(", ") : "Not found in a sitemap"],
        ["Linked from", insp.referringUrls.length ? insp.referringUrls.map(shortUrl).join(", ") : "–"],
        ["Rich result issues", insp.richIssues.length ? insp.richIssues.map((i) => `${i.type}: ${i.message}`).join("; ") : "None"],
      ]
    : [];

  /* ---------- Google Search ---------- */
  const queryRows = useMemo(() => (pq ? pq.rows.filter((r) => r.status !== "lost") : []), [pq]);
  let gscKpis: KpiItem[] = [];
  if (pq) {
    const c = pq.totals.current, p = pq.totals.previous;
    const S = ["pq.totals.current", "pq.totals.previous"];
    gscKpis = [
      { label: "Clicks", source: S, value: num(c.clicks), delta: <Delta cur={c.clicks} prev={p.clicks} /> },
      { label: "Impressions", source: S, value: num(c.impressions), delta: <Delta cur={c.impressions} prev={p.impressions} /> },
      { label: "CTR", source: S, value: pct(c.ctr, 2), delta: <Delta cur={c.ctr * 100} prev={p.ctr * 100} asPoints /> },
      {
        label: "Avg. position", source: S,
        value: c.impressions ? pos(c.position) : "–",
        delta: c.impressions && p.impressions ? <Delta cur={c.position} prev={p.position} invert asPoints /> : undefined,
      },
      { label: "Queries", source: ["pq.status"], value: num(pq.counts.now), sub: `${num(pq.counts.new)} new · ${num(pq.counts.lost)} lost` },
    ];
    if (aiImpr != null && snap) gscKpis.push({ label: "AI impressions", value: num(aiImpr), sub: `AI Overviews & AI Mode, ${snap.from} to ${snap.to}` });
  }
  const noSearchData = !!pq && !pq.totals.current.impressions && !pq.totals.previous.impressions;

  /* ---------- Site traffic ---------- */
  let gaKpis: KpiItem[] = [];
  const sourceRows = useMemo<SourceRow[]>(
    () => (ga ? ga.sources.map((s) => ({ ...s, sourceMedium: `${s.source} / ${s.medium}`, rate: s.sessions ? s.engaged / s.sessions : 0 })) : []),
    [ga]
  );
  if (ga) {
    const pc = ga.page.current, pp = ga.page.previous, lc = ga.landing.current, lp = ga.landing.previous;
    gaKpis = [
      { label: "Views", value: num(pc.views), delta: <Delta cur={pc.views} prev={pp.views} /> },
      { label: "Users", value: num(pc.users), delta: <Delta cur={pc.users} prev={pp.users} /> },
      { label: "Avg. engagement time", value: pc.users ? duration(pc.engagementSec / pc.users) : "–", sub: "per user" },
      { label: "Sessions starting here", value: num(lc.sessions), delta: <Delta cur={lc.sessions} prev={lp.sessions} />, sub: "as the landing page" },
      { label: "Engagement rate", value: lc.sessions ? pct(lc.engagedSessions / lc.sessions) : "–", sub: "of those sessions" },
      { label: "Key events", value: num(pc.keyEvents), delta: <Delta cur={pc.keyEvents} prev={pp.keyEvents} /> },
      {
        label: "Visits from AI assistants",
        value: num(ga.ai.sessions),
        sub: ga.ai.sources.length ? ga.ai.sources.slice(0, 3).map((s) => `${s.source} ${num(s.sessions)}`).join(" · ") : "none in this period",
      },
    ];
  }

  return (
    <div className="src-overlay" onClick={onClose}>
      <div className="src-dialog pq-dialog" role="dialog" aria-modal="true" aria-label={`Report for ${url}`} onClick={(e) => e.stopPropagation()}>
        <SourcesProvider value={merged}>
          <div className="src-head">
            <div style={{ minWidth: 0 }}>
              <div className="muted">URL report</div>
              <h3 style={{ overflowWrap: "anywhere" }}>
                <a href={url} target="_blank" rel="noreferrer">{url}</a>
              </h3>
              <div className="muted">
                Search data {gsc.range.startDate} to {gsc.range.endDate} vs {gsc.previousRange.startDate} to {gsc.previousRange.endDate}
                {ga ? ` · GA4 ${ga.range.startDate} to ${ga.range.endDate} (${ga.timeZone})` : ""}
              </div>
            </div>
            <button ref={closeRef} className="btn" onClick={onClose}>Close</button>
          </div>

          {/* Google index status */}
          <div className="panel" style={{ marginTop: 12 }}>
            <PanelTitle>Google index status</PanelTitle>
            {inspErr && <div className="notice error">{inspErr}</div>}
            {!insp && !inspErr && <p className="muted">Checking with Google&apos;s URL Inspection…</p>}
            {insp && (
              <>
                <Kpis items={inspKpis} />
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table>
                    <tbody>
                      {inspDetails.map(([k, v]) => (
                        <tr key={k}>
                          <td style={{ width: 200 }} className="muted">{k}</td>
                          <td className="url">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {insp.link && (
                  <p style={{ marginBottom: 0 }}>
                    <a href={insp.link} target="_blank" rel="noreferrer">Open this URL&apos;s inspection in Search Console</a>
                  </p>
                )}
              </>
            )}
          </div>

          {/* Google Search */}
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle>Google Search</PanelTitle>
            {pqErr && <div className="notice error">{pqErr}</div>}
            {!pq && !pqErr && <p className="muted">Loading Search Console data…</p>}
            {pq && (
              <>
                <Kpis items={gscKpis} />
                {noSearchData ? (
                  <p className="muted" style={{ marginBottom: 0 }}>
                    No Google Search data for this exact URL in these dates. If you expected some, check the URL matches Search Console exactly
                    (https, www, trailing slash).
                  </p>
                ) : (
                  <div style={{ marginTop: 12 }}>
                    <DataTable
                      rows={queryRows}
                      cols={QUERY_COLS}
                      initialSort="clicks"
                      pageSize={10}
                      csvName="page-queries.csv"
                      source={["pq.queries.current", "pq.queries.previous", "pq.status"]}
                      empty="No queries listed for this page."
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Site traffic (GA4) */}
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle>Site traffic (GA4)</PanelTitle>
            {!ga4 && <div className="notice">Pick a GA4 property in the top bar to see traffic for this page.</div>}
            {gaErr && <div className="notice error">{gaErr}</div>}
            {ga4 && !ga && !gaErr && <p className="muted">Loading GA4 data…</p>}
            {ga && (
              <>
                <Kpis items={gaKpis} />
                {ga.daily.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={ga.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="#e7ebef" vertical={false} />
                        <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                        <YAxis tick={axis} width={44} />
                        <Tooltip />
                        <Line type="monotone" dataKey="views" name="Views" stroke="#1a73e8" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="users" name="Users" stroke="#9bb0d9" dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <div style={{ marginTop: 16 }}>
                  <PanelTitle>Where sessions that started on this page came from</PanelTitle>
                  <DataTable rows={sourceRows} cols={SOURCE_COLS} initialSort="sessions" pageSize={10} csvName="page-traffic-sources.csv" empty="No sessions started on this page in this period." />
                </div>
                <div className="grid-2" style={{ marginTop: 16 }}>
                  <div>
                    <PanelTitle>Countries (users)</PanelTitle>
                    {ga.countries.length ? <Bars items={ga.countries.slice(0, 10).map((c) => ({ label: c.country, value: c.users }))} /> : <p className="muted">No data.</p>}
                  </div>
                  <div>
                    <PanelTitle>Devices (users)</PanelTitle>
                    {ga.devices.length ? <Bars items={ga.devices.map((d) => ({ label: d.device, value: d.users }))} /> : <p className="muted">No data.</p>}
                  </div>
                </div>
              </>
            )}
          </div>
        </SourcesProvider>
      </div>
    </div>
  );
}
