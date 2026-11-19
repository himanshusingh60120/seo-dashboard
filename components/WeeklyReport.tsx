// components/WeeklyReport.tsx
"use client";
// Weekly report tab (WEEKLY_REPORT_EMAILS only): the Data Demand properties' week, Monday to Sunday, side by side, then a
// full review of one property at a time. /api/weekly says which week and which properties; /api/weekly/property loads
// each property in parallel, so each one appears as soon as it's ready.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Sources } from "@/lib/types";
import type { Area, Mover, NewQuery, PropertyWeek, SitemapRow, SourceGroup, Split, Status, WeekInfo, WeeklySite } from "@/lib/weekly";
import { DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, num, pct, pos, type Col, type KpiItem } from "./ui";

type Meta = { week: WeekInfo; sites: WeeklySite[]; missing: string[]; alsoMatched: Record<string, string[]>; rules: string[] };
type Result = { loading: boolean; data?: PropertyWeek; error?: string };

const axis = { fontSize: 12, fill: "#5b6573" };
const STATUS: Record<Status, { label: string; bg: string; fg: string }> = {
  good: { label: "Good", bg: "#e6f4ea", fg: "#137333" },
  watch: { label: "Watch", bg: "#fef7e0", fg: "#b06000" },
  problem: { label: "Problem", bg: "#fce8e6", fg: "#c5221f" },
  pending: { label: "Coming next", bg: "#f1f3f4", fg: "#5f6368" },
};
const DAY_COLOR = { final: "#1a73e8", provisional: "#8ab4f8", partial: "#c6cad1", future: "#eceff1" } as const;
const DAY_NOTE = { final: "final", provisional: "provisional", partial: "still running", future: "not yet" } as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

function addDaysLocal(d: string, n: number) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const fmtDate = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const weekLabel = (start: string, end: string) =>
  `${fmtDate(start, { weekday: "short", day: "numeric", month: "short" })} – ${fmtDate(end, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`;

function Pill({ s, children }: { s: Status; children?: ReactNode }) {
  const c = STATUS[s];
  return (
    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, background: c.bg, color: c.fg, fontSize: 12, fontWeight: 600, marginRight: 4 }}>
      {children ?? c.label}
    </span>
  );
}

function Chg({ now, base }: { now: number; base: number }) {
  if (!base) return <span className="delta flat">{now ? "new" : "–"}</span>;
  const d = ((now - base) / base) * 100;
  const cls = Math.abs(d) < 0.5 ? "flat" : d > 0 ? "good" : "bad";
  return (
    <span className={`delta ${cls}`}>
      {d > 0 ? "+" : ""}
      {d.toFixed(0)}%
    </span>
  );
}

function PosChg({ now, base }: { now: number; base: number }) {
  if (!now || !base) return <span className="delta flat">–</span>;
  const d = base - now;
  if (Math.abs(d) < 0.05) return <span className="delta flat">no change</span>;
  return <span className={`delta ${d > 0 ? "good" : "bad"}`}>{`${Math.abs(d).toFixed(1)} ${d > 0 ? "better" : "worse"}`}</span>;
}

const counts = (areas: Area[]) => {
  const c = { good: 0, watch: 0, problem: 0 };
  for (const a of areas) if (a.status !== "pending") c[a.status]++;
  return c;
};

/* ---------------- Tables ---------------- */

const changeCell = (r: Mover) => (
  <span className={`delta ${r.change > 0 ? "good" : "bad"}`}>
    {r.change > 0 ? "+" : ""}
    {num(r.change)}
  </span>
);
const PAGE_COLS: Col<Mover>[] = [
  { key: "key", label: "Page", url: true },
  { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
  { key: "prevClicks", label: "Last week", num: true, render: (r) => num(r.prevClicks) },
  { key: "change", label: "Change", num: true, render: changeCell },
  { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
];
const QUERY_COLS: Col<Mover>[] = [{ key: "key", label: "Query" }, ...PAGE_COLS.slice(1)];
const NEW_COLS: Col<NewQuery>[] = [
  { key: "query", label: "Query" },
  { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
  { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
  { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
];
const splitCols = (label: string, upper = false): Col<Split>[] => [
  { key: "name", label, render: (r) => (upper ? r.name.toUpperCase() : r.name) },
  { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
  { key: "prevClicks", label: "Last week", num: true, render: (r) => num(r.prevClicks) },
  { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
];
const MAP_COLS: Col<SitemapRow>[] = [
  { key: "path", label: "Sitemap", url: true },
  { key: "submitted", label: "Submitted URLs", num: true, render: (r) => num(r.submitted) },
  { key: "errors", label: "Errors", num: true, render: (r) => (r.errors ? <span className="delta bad">{num(r.errors)}</span> : "0") },
  { key: "warnings", label: "Warnings", num: true, render: (r) => num(r.warnings) },
  { key: "lastDownloaded", label: "Last read by Google", render: (r) => (r.lastDownloaded ? r.lastDownloaded.slice(0, 10) : "never") },
  { key: "isPending", label: "Pending", render: (r) => (r.isPending ? "yes" : "") },
];
type ChannelRow = { name: string; sessions: number; prevSessions: number; keyEvents: number };
const CHANNEL_COLS: Col<ChannelRow>[] = [
  { key: "name", label: "Channel" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "prevSessions", label: "Last week", num: true, render: (r) => num(r.prevSessions) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
];
type LandingRow = { page: string; sessions: number; prevSessions: number | null };
const LANDING_COLS: Col<LandingRow>[] = [
  { key: "page", label: "Landing page" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "prevSessions", label: "Last week", num: true, render: (r) => (r.prevSessions == null ? "–" : num(r.prevSessions)) },
];
const groupCols = (label: string): Col<SourceGroup>[] => [
  { key: "name", label },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "prevSessions", label: "Last week", num: true, render: (r) => num(r.prevSessions) },
  { key: "engaged", label: "Engagement rate", num: true, render: (r) => (r.sessions ? pct(r.engaged / r.sessions) : "–") },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
];
type AiLandingRow = { page: string; sessions: number; keyEvents: number };
const AI_LANDING_COLS: Col<AiLandingRow>[] = [
  { key: "page", label: "Landing page" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
];

/* ---------------- One property ---------------- */

function PropertyDetail({ site, r }: { site: WeeklySite; r?: Result }) {
  if (!r || r.loading) return <p className="muted">Loading {site.host}…</p>;
  if (r.error || !r.data) return <div className="notice error">{site.host}: {r.error || "no data"}</div>;
  const d = r.data;
  const g = d.gsc;
  const a = d.ga;
  const wk = d.week;
  const S = d.sourceIds;
  const compared = wk.partial
    ? `change compares Mon–${fmtDate(addDaysLocal(wk.start, wk.compareDays - 1), { weekday: "short" })}`
    : "change compares the full week";

  const gscKpis: KpiItem[] = g
    ? [
        { label: "Clicks", source: [S.gsc], value: num(g.week.clicks), delta: <Delta cur={g.cmp.clicks} prev={g.prev.clicks} />, sub: `4-wk avg ${num(g.avg4.clicks)} · ${compared}` },
        { label: "Impressions", source: [S.gsc], value: num(g.week.impressions), delta: <Delta cur={g.cmp.impressions} prev={g.prev.impressions} />, sub: `4-wk avg ${num(g.avg4.impressions)}` },
        { label: "CTR", source: [S.gsc], value: pct(g.week.ctr, 2), delta: <Delta cur={g.cmp.ctr * 100} prev={g.prev.ctr * 100} asPoints /> },
        { label: "Average position", source: [S.gsc], value: pos(g.week.position), delta: <PosChg now={g.cmp.position} base={g.prev.position} /> },
        { label: "Pages with clicks", source: [S.gsc], value: num(g.pages.withClicks), delta: <Delta cur={g.pages.withClicks} prev={g.pages.prevWithClicks} /> },
        { label: "Queries with clicks", source: [S.gsc], value: num(g.queries.withClicks), delta: <Delta cur={g.queries.withClicks} prev={g.queries.prevWithClicks} /> },
      ]
    : [];
  const gaKpis: KpiItem[] = a
    ? [
        { label: "Sessions", source: [S.ga], value: num(a.week.sessions), delta: <Delta cur={a.cmp.sessions} prev={a.prev.sessions} />, sub: `4-wk avg ${num(a.avg4.sessions)}` },
        { label: "Users", source: [S.ga], value: num(a.cmp.users), delta: <Delta cur={a.cmp.users} prev={a.prev.users} />, sub: "compared days" },
        {
          label: "Engagement rate",
          source: [S.ga],
          value: a.cmp.sessions ? pct(a.cmp.engaged / a.cmp.sessions) : "–",
          delta: a.cmp.sessions && a.prev.sessions ? <Delta cur={(a.cmp.engaged / a.cmp.sessions) * 100} prev={(a.prev.engaged / a.prev.sessions) * 100} asPoints /> : undefined,
        },
        { label: "Key events", source: [S.ga], value: num(a.week.keyEvents), delta: <Delta cur={a.cmp.keyEvents} prev={a.prev.keyEvents} /> },
        { label: "Page views", source: [S.ga], value: num(a.week.views), delta: <Delta cur={a.cmp.views} prev={a.prev.views} /> },
      ]
    : [];
  const sourceKpis: KpiItem[] = a
    ? [
        { label: "AI-assistant visits", source: [S.ga], value: num(a.ai.sessions), delta: <Delta cur={a.ai.sessions} prev={a.ai.prevSessions} />, sub: "compared days" },
        { label: "AI engagement rate", source: [S.ga], value: a.ai.sessions ? pct(a.ai.engaged / a.ai.sessions) : "–" },
        { label: "AI key events", source: [S.ga], value: num(a.ai.keyEvents) },
        {
          label: "AI share of sessions",
          source: [S.ga],
          value: a.cmp.sessions ? pct(a.ai.sessions / a.cmp.sessions, 2) : "–",
          delta: a.cmp.sessions && a.prev.sessions ? <Delta cur={(a.ai.sessions / a.cmp.sessions) * 100} prev={(a.ai.prevSessions / a.prev.sessions) * 100} asPoints /> : undefined,
        },
        { label: "Social visits", source: [S.ga], value: num(a.social.sessions), delta: <Delta cur={a.social.sessions} prev={a.social.prevSessions} />, sub: "compared days" },
      ]
    : [];
  const chart = g ? g.days.map((x) => ({ day: fmtDate(x.date, { weekday: "short", day: "numeric" }), clicks: x.clicks, state: x.state })) : [];

  return (
    <>
      <div className="panel" style={{ marginBottom: 16 }}>
        <PanelTitle>Week at a glance</PanelTitle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginBottom: 12 }}>
          {d.areas.map((x) => (
            <div key={x.id} title={x.note} style={{ background: "#f8f9fa", borderRadius: 8, padding: "8px 10px" }}>
              <div className="muted" style={{ fontSize: 12 }}>{x.label}</div>
              <Pill s={x.status} />
              <div style={{ fontSize: 12, marginTop: 4, color: "#5f6368" }}>{x.note}</div>
            </div>
          ))}
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          {d.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>

      <h3 style={{ margin: "8px 0" }}>Search performance</h3>
      {d.gscError && <div className="notice error">Search Console: {d.gscError}</div>}
      {g && (
        <>
          <Kpis items={gscKpis} />
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle source={[S.gsc]}>Clicks per day</PanelTitle>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e7ebef" vertical={false} />
                <XAxis dataKey="day" tick={axis} />
                <YAxis tick={axis} width={48} allowDecimals={false} />
                <Tooltip formatter={(v: number, _n: string, p: any) => [`${num(v)} (${DAY_NOTE[p.payload.state as keyof typeof DAY_NOTE]})`, "Clicks"]} />
                <Bar dataKey="clicks" radius={[4, 4, 0, 0]}>
                  {chart.map((x) => (
                    <Cell key={x.day} fill={DAY_COLOR[x.state]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
              Dark blue: final · light blue: provisional (Google can still adjust it) · grey: day still running in Pacific time. Final through {g.finalThrough}.
            </p>
          </div>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>Pages gaining clicks</PanelTitle>
              <DataTable rows={g.pages.gainers} cols={PAGE_COLS} initialSort="change" pageSize={10} csvName={`${d.name}-pages-gaining-${wk.start}.csv`} source={[S.gsc]} empty="No page gained clicks." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>Pages losing clicks</PanelTitle>
              <DataTable rows={g.pages.losers} cols={PAGE_COLS} initialSort="change" initialDesc={false} pageSize={10} csvName={`${d.name}-pages-losing-${wk.start}.csv`} source={[S.gsc]} empty="No page lost clicks." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>Queries gaining clicks</PanelTitle>
              <DataTable rows={g.queries.gainers} cols={QUERY_COLS} initialSort="change" pageSize={10} csvName={`${d.name}-queries-gaining-${wk.start}.csv`} source={[S.gsc]} empty="No query gained clicks." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>Queries losing clicks</PanelTitle>
              <DataTable rows={g.queries.losers} cols={QUERY_COLS} initialSort="change" initialDesc={false} pageSize={10} csvName={`${d.name}-queries-losing-${wk.start}.csv`} source={[S.gsc]} empty="No query lost clicks." />
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>{`New queries this week (${num(g.queries.newCount)})`}</PanelTitle>
              <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>Queries with impressions this week that weren&apos;t in last week&apos;s top {num(g.listRows)}.</p>
              <DataTable rows={g.queries.newTop} cols={NEW_COLS} initialSort="impressions" pageSize={10} csvName={`${d.name}-new-queries-${wk.start}.csv`} source={[S.gsc]} empty="No new queries." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>Branded search</PanelTitle>
              <p style={{ marginTop: 0 }}>
                Queries containing “{g.queries.branded.term}”: <b>{num(g.queries.branded.clicks)}</b> clicks (
                <Chg now={g.queries.branded.clicks} base={g.queries.branded.prevClicks} /> vs last week), {pct(g.queries.branded.share)} of clicks from named
                queries (last week {pct(g.queries.branded.prevShare)}).
              </p>
              <p className="muted" style={{ fontSize: 12 }}>Google hides rare queries, so this share counts only clicks on queries it shows.</p>
              <PanelTitle source={[S.gsc]}>Devices</PanelTitle>
              <DataTable rows={g.devices} cols={splitCols("Device")} initialSort="clicks" pageSize={5} source={[S.gsc]} />
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="panel">
              <PanelTitle source={[S.gsc]}>Top countries</PanelTitle>
              <DataTable rows={g.countries} cols={splitCols("Country", true)} initialSort="clicks" pageSize={10} csvName={`${d.name}-countries-${wk.start}.csv`} source={[S.gsc]} />
            </div>
            <div className="panel">
              <PanelTitle source={[S.maps]}>Sitemaps</PanelTitle>
              {g.sitemaps ? (
                <DataTable rows={g.sitemaps} cols={MAP_COLS} initialSort="submitted" pageSize={10} source={[S.maps]} empty="No sitemap is submitted for this property." />
              ) : (
                <p className="muted">Couldn&apos;t read the sitemaps.</p>
              )}
            </div>
          </div>
        </>
      )}

      <h3 style={{ margin: "24px 0 8px" }}>Traffic outcome (GA4)</h3>
      {d.gaError && <div className="notice">{d.gaError}</div>}
      {a && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {d.ga4Name} · dates in {a.timeZone}
            {a.partial ? ` · Sunday is still running there, so changes compare ${a.compareDays} day(s)` : ""}.
          </p>
          <Kpis items={gaKpis} />
          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="panel">
              <PanelTitle source={[S.ga]}>Channels</PanelTitle>
              <DataTable rows={a.channels} cols={CHANNEL_COLS} initialSort="sessions" pageSize={10} csvName={`${d.name}-channels-${wk.start}.csv`} source={[S.ga]} />
            </div>
            <div className="panel">
              <PanelTitle source={[S.ga]}>Top landing pages</PanelTitle>
              <DataTable rows={a.landing} cols={LANDING_COLS} initialSort="sessions" pageSize={15} csvName={`${d.name}-landing-${wk.start}.csv`} source={[S.ga]} />
            </div>
          </div>

          <h3 style={{ margin: "24px 0 8px" }}>AI assistants, social media and referrals (GA4)</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Visits whose source is an AI assistant (ChatGPT, Perplexity, Gemini, Claude, Copilot and others), a social network, or another website. Figures cover
            the compared days.
          </p>
          <Kpis items={sourceKpis} />
          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="panel">
              <PanelTitle source={[S.ga]}>Visits by AI assistant</PanelTitle>
              <DataTable rows={a.ai.tools} cols={groupCols("AI assistant")} initialSort="sessions" pageSize={10} csvName={`${d.name}-ai-assistants-${wk.start}.csv`} source={[S.ga]} empty="No visits from AI assistants this week." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.ga]}>Pages AI assistants sent visitors to</PanelTitle>
              <DataTable rows={a.ai.landing} cols={AI_LANDING_COLS} initialSort="sessions" pageSize={10} csvName={`${d.name}-ai-landing-${wk.start}.csv`} source={[S.ga]} empty="No visits from AI assistants this week." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.ga]}>Visits by social network</PanelTitle>
              <DataTable rows={a.socialNetworks} cols={groupCols("Network")} initialSort="sessions" pageSize={10} csvName={`${d.name}-social-${wk.start}.csv`} source={[S.ga]} empty="No visits from social media this week." />
            </div>
            <div className="panel">
              <PanelTitle source={[S.ga]}>Top referring sites</PanelTitle>
              <DataTable rows={a.referrals} cols={groupCols("Site")} initialSort="sessions" pageSize={10} csvName={`${d.name}-referrals-${wk.start}.csv`} source={[S.ga]} empty="No referral visits this week." />
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- The tab ---------------- */

export default function WeeklyReport() {
  const [week, setWeek] = useState("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState("");
  const req = useRef(0);

  const load = useCallback(async (w: string) => {
    const id = ++req.current;
    setError(null);
    setResults({});
    try {
      const m = await getJson<Meta>(`/api/weekly${w ? `?week=${w}` : ""}`);
      if (id !== req.current) return;
      setMeta(m);
      setSel((s) => (m.sites.some((x) => x.siteUrl === s) ? s : m.sites[0]?.siteUrl || ""));
      setResults(Object.fromEntries(m.sites.map((s) => [s.siteUrl, { loading: true }])));
      await Promise.all(
        m.sites.map(async (s) => {
          let r: Result;
          try {
            r = { loading: false, data: await getJson<PropertyWeek>(`/api/weekly/property?site=${encodeURIComponent(s.siteUrl)}&week=${m.week.start}`) };
          } catch (e) {
            r = { loading: false, error: e instanceof Error ? e.message : "Couldn't load this property" };
          }
          if (id === req.current) setResults((cur) => ({ ...cur, [s.siteUrl]: r }));
        })
      );
    } catch (e) {
      if (id === req.current) setError(e instanceof Error ? e.message : "Couldn't load the weekly report");
    }
  }, []);

  useEffect(() => {
    load(week);
  }, [week, load]);

  const sources = useMemo<Sources>(
    () => Object.values(results).reduce<Sources>((acc, r) => ({ ...acc, ...(r.data?.sources || {}) }), {}),
    [results]
  );

  const wk = meta?.week;
  const selected = meta?.sites.find((s) => s.siteUrl === sel);

  return (
    <SourcesProvider value={sources}>
      <Section
        title="Weekly report"
        lede="The Data Demand properties' week, Monday to Sunday in Search Console's time zone (Pacific), compared with the week before and the 4-week average. Pick a property below for its full review."
      >
        {error && <div className="notice error">{error}</div>}
        {!meta && !error && <p className="muted">Finding the properties…</p>}

        {meta && wk && (
          <>
            <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{weekLabel(wk.start, wk.end)}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {wk.partial
                    ? "Sunday is still running in Pacific time: it's shown as partial, and changes compare Monday to Saturday. Refresh after 1:30 PM IST for the full week."
                    : "Full week. Days Google hasn't finalised yet are marked provisional."}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <label className="control">
                  Week
                  <select value={wk.start} onChange={(e) => setWeek(e.target.value)}>
                    {wk.weeks.map((m) => (
                      <option key={m} value={m}>{weekLabel(m, addDaysLocal(m, 6))}</option>
                    ))}
                  </select>
                </label>
                <button className="btn" onClick={() => load(week)}>Refresh</button>
                <button className="btn" onClick={() => window.print()}>Print / PDF</button>
              </div>
            </div>

            {meta.missing.length > 0 && (
              <div className="notice">Not found in your Search Console properties: {meta.missing.join(", ")}.</div>
            )}
            {Object.entries(meta.alsoMatched).map(([site, others]) => (
              <div key={site} className="notice">
                Using {site} for this report; also matched {others.join(", ")}. To choose exactly, set WEEKLY_SITES in Vercel.
              </div>
            ))}

            <div className="panel" style={{ marginBottom: 16 }}>
              <PanelTitle>Portfolio at a glance</PanelTitle>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th className="num">Clicks</th>
                      <th className="num">Impressions</th>
                      <th className="num">Position</th>
                      <th className="num">Sessions</th>
                      <th className="num">AI visits</th>
                      <th className="num">Key events</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.sites.map((s) => {
                      const r = results[s.siteUrl];
                      const d = r?.data;
                      const g = d?.gsc;
                      const a = d?.ga;
                      const c = d ? counts(d.areas) : null;
                      return (
                        <tr key={s.siteUrl} onClick={() => setSel(s.siteUrl)} style={{ cursor: "pointer" }}>
                          <td>
                            <b>{s.name}</b>
                            <div className="muted" style={{ fontSize: 12 }}>{s.host}</div>
                          </td>
                          {!d ? (
                            <td colSpan={7} className="muted">{r?.error ? `Couldn't load: ${r.error}` : "Loading…"}</td>
                          ) : (
                            <>
                              <td className="num">{g ? <>{num(g.week.clicks)} <Chg now={g.cmp.clicks} base={g.prev.clicks} /></> : "–"}</td>
                              <td className="num">{g ? <>{num(g.week.impressions)} <Chg now={g.cmp.impressions} base={g.prev.impressions} /></> : "–"}</td>
                              <td className="num">{g ? <>{pos(g.week.position)} <PosChg now={g.cmp.position} base={g.prev.position} /></> : "–"}</td>
                              <td className="num">{a ? <>{num(a.week.sessions)} <Chg now={a.cmp.sessions} base={a.prev.sessions} /></> : "–"}</td>
                              <td className="num">{a ? <>{num(a.ai.sessions)} <Chg now={a.ai.sessions} base={a.ai.prevSessions} /></> : "–"}</td>
                              <td className="num">{a ? <>{num(a.week.keyEvents)} <Chg now={a.cmp.keyEvents} base={a.prev.keyEvents} /></> : "–"}</td>
                              <td>
                                {c && (
                                  <>
                                    <Pill s="good">{c.good}</Pill>
                                    <Pill s="watch">{c.watch}</Pill>
                                    <Pill s="problem">{c.problem}</Pill>
                                  </>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Changes compare the same days of last week. AI visits cover the compared days. Status counts: <Pill s="good">Good</Pill>
                <Pill s="watch">Watch</Pill>
                <Pill s="problem">Problem</Pill> across the areas checked so far.
              </p>
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>How the statuses are decided</summary>
                <ul style={{ fontSize: 12, margin: "6px 0 0", paddingLeft: 18 }}>
                  {meta.rules.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </details>
            </div>

            {meta.sites.length > 0 && (
              <>
                <SubTabs value={sel} onChange={setSel} options={meta.sites.map((s) => ({ id: s.siteUrl, label: s.name }))} />
                {selected && <PropertyDetail site={selected} r={results[selected.siteUrl]} />}
              </>
            )}
          </>
        )}
      </Section>
    </SourcesProvider>
  );
}
