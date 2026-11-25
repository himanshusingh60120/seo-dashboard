// components/WeeklyReport.tsx
"use client";
// Weekly report tab (accounts with "Weekly report" ticked in Manage access): the week for the properties in this
// person's report (picked in Manage access, or the Data Demand properties by default), Monday to Sunday, side by side,
// then a full review of one property at a time. /api/weekly says which week and which properties; /api/weekly/property
// loads each property in parallel, so each one appears as soon as it's ready. "Download Excel" builds one workbook from
// what's on screen: a Summary sheet plus one sheet per property (lib/weeklyExcel.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Sources } from "@/lib/types";
import type { Area, Mover, NewQuery, PropertyWeek, SitemapRow, SourceGroup, Split, Status, WeekInfo, WeeklySite } from "@/lib/weekly";
import type { CrawlDayRow, IndexChange, Link404, ReasonRow } from "@/lib/weeklyHealth";
import { downloadWeeklyExcel } from "@/lib/weeklyExcel";
import { DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, num, pct, pos, type Col, type KpiItem } from "./ui";

type Meta = { week: WeekInfo; sites: WeeklySite[]; missing: string[]; alsoMatched: Record<string, string[]>; rules: string[] };
type Result = { loading: boolean; data?: PropertyWeek; error?: string };

const axis = { fontSize: 12, fill: "#5b6573" };
const STATUS: Record<Status, { label: string; bg: string; fg: string }> = {
  good: { label: "Good", bg: "#e6f4ea", fg: "#137333" },
  watch: { label: "Watch", bg: "#fef7e0", fg: "#b06000" },
  problem: { label: "Problem", bg: "#fce8e6", fg: "#c5221f" },
  none: { label: "No data", bg: "#f1f3f4", fg: "#5f6368" },
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
/** Plain change text, for figures where a rise isn't good news (404s, not indexed). */
const chgText = (now: number, base: number) => (base ? `${now >= base ? "+" : ""}${(((now - base) / base) * 100).toFixed(0)}%` : now ? "new" : "no change");

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
  for (const a of areas) if (a.status === "good" || a.status === "watch" || a.status === "problem") c[a.status]++;
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
type ChannelRow = { name: string; sessions: number; prevSessions: number; engaged: number; keyEvents: number };
const CHANNEL_COLS: Col<ChannelRow>[] = [
  { key: "name", label: "Channel" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "prevSessions", label: "Last week", num: true, render: (r) => num(r.prevSessions) },
  { key: "engaged", label: "Engagement rate", num: true, render: (r) => (r.sessions ? pct(r.engaged / r.sessions) : "–") },
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
const CHANGE_COLS: Col<IndexChange>[] = [
  { key: "url", label: "Page", url: true },
  { key: "date", label: "Found on" },
  { key: "change", label: "Change", render: (r) => <span className={`delta ${/^Dropped/i.test(r.change) ? "bad" : "good"}`}>{r.change}</span> },
  { key: "after", label: "Google now says" },
];
const REASON_COLS: Col<ReasonRow>[] = [
  { key: "reason", label: "Reason" },
  { key: "pages", label: "Pages", num: true, render: (r) => num(r.pages) },
  { key: "prevPages", label: "Previous capture", num: true, render: (r) => (r.prevPages == null ? "–" : num(r.prevPages)) },
];
const LINK_COLS: Col<Link404>[] = [
  { key: "url", label: "URL", url: true },
  { key: "inSitemap", label: "In a sitemap", render: (r) => (r.inSitemap ? <span className="delta bad">yes</span> : "") },
  { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
  { key: "linkedFrom", label: "Linked from", render: (r) => r.linkedFrom || "–" },
  { key: "checked", label: "Last checked" },
];
const CRAWL_COLS: Col<CrawlDayRow>[] = [
  { key: "date", label: "Date", render: (r) => fmtDate(r.date, { weekday: "short", day: "numeric", month: "short" }) },
  { key: "requests", label: "Requests", num: true, render: (r) => (r.requests == null ? "not captured" : num(r.requests)) },
  { key: "prevRequests", label: "Same day last week", num: true, render: (r) => (r.prevRequests == null ? "–" : num(r.prevRequests)) },
  { key: "ms", label: "Response (ms)", num: true, render: (r) => (r.ms == null ? "–" : num(Math.round(r.ms))) },
];

/* ---------------- Indexing, 404s and crawling ---------------- */

function HealthDetail({ d }: { d: PropertyWeek }) {
  const h = d.health;
  const S = d.sourceIds;
  const wk = d.week;
  if (!h) {
    return <div className="notice">{d.healthError ? `Couldn't read the saved captures: ${d.healthError}` : "No saved captures for this property."}</div>;
  }
  const c = h.index.capture;
  const k = h.index.checks;
  const r = h.errors.reasons;
  const l = h.errors.links;
  const cr = h.crawl;
  const p = h.problems;
  const nf = r ? r.notFound + r.soft404 : 0;
  const pnf = r && r.prevAsOf != null ? (r.prevNotFound || 0) + (r.prevSoft404 || 0) : null;
  const fails = [p.idx && `Page indexing (${p.idx})`, p.crawl && `Crawl stats (${p.crawl})`, p.checks && `daily index checks (${p.checks})`].filter(Boolean);

  const items: KpiItem[] = [];
  if (c) {
    items.push({
      label: "Indexed (Google)",
      source: [S.health],
      value: num(c.indexed),
      delta: c.baseIndexed != null ? <Delta cur={c.indexed} prev={c.baseIndexed} /> : undefined,
      sub: c.baseDate ? `${c.date} vs ${c.baseDate}` : c.date,
    });
    items.push({
      label: "Not indexed (Google)",
      source: [S.health],
      value: num(c.notIndexed),
      sub: c.baseNotIndexed != null && c.baseDate ? `${chgText(c.notIndexed, c.baseNotIndexed)} vs ${c.baseDate}` : c.date,
    });
  }
  if (k) {
    items.push({
      label: "Dropped from the index",
      source: [S.health],
      value: num(k.dropped),
      sub: `daily checks · ${num(k.newlyIndexed)} newly indexed${k.enabled ? "" : " · paused"}`,
    });
  }
  if (r) {
    items.push({
      label: "404 + soft 404 (Google)",
      source: [S.health],
      value: num(nf),
      sub: `${r.asOf}${pnf != null ? ` · ${chgText(nf, pnf)} vs ${r.prevAsOf}` : ""}${r.server ? ` · ${num(r.server)} server errors` : ""}`,
    });
  }
  if (l) {
    items.push({
      label: "404 URLs still in a sitemap",
      source: [S.health],
      value: num(l.inSitemap),
      sub: `${num(l.total)} known 404 URLs · ${num(l.withImpressions)} got impressions`,
    });
  }
  if (cr && cr.pairs) {
    items.push({
      label: "Crawl requests",
      source: [S.health],
      value: num(cr.requests),
      delta: <Delta cur={cr.requests} prev={cr.prevRequests} />,
      sub: `${cr.pairs} day(s) vs the same days last week`,
    });
  }
  if (cr && cr.ms != null) {
    items.push({
      label: "Avg response time",
      source: [S.health],
      value: `${num(Math.round(cr.ms))} ms`,
      sub: cr.prevMs != null ? `last week ${num(Math.round(cr.prevMs))} ms` : undefined,
    });
  }

  return (
    <>
      {fails.length > 0 && <div className="notice error">Couldn&apos;t read: {fails.join(" · ")}</div>}
      {items.length ? (
        <Kpis items={items} />
      ) : (
        <p className="muted">
          No Page indexing or Crawl stats capture and no daily index checks for this week. Capture the reports with the extension, or start daily checks in
          the Index checks tab.
        </p>
      )}
      <div className="grid-2" style={{ marginTop: 16 }}>
        {k && (
          <div className="panel">
            <PanelTitle source={[S.health]}>Index changes this week (daily checks)</PanelTitle>
            <DataTable
              rows={k.changes}
              cols={CHANGE_COLS}
              initialSort="date"
              pageSize={10}
              csvName={`${d.name}-index-changes-${wk.start}.csv`}
              source={[S.health]}
              empty="No page was dropped from or newly added to the index this week."
            />
          </div>
        )}
        {r && (
          <div className="panel">
            <PanelTitle source={[S.health]}>{`Why pages aren't indexed (Google, ${r.asOf})`}</PanelTitle>
            <DataTable rows={r.list} cols={REASON_COLS} initialSort="pages" pageSize={10} csvName={`${d.name}-not-indexed-reasons-${wk.start}.csv`} source={[S.health]} />
          </div>
        )}
        {l && (
          <div className="panel">
            <PanelTitle source={[S.health]}>{`404 URLs found by the daily checks (${num(l.total)})`}</PanelTitle>
            <DataTable
              rows={l.rows}
              cols={LINK_COLS}
              initialSort="impressions"
              pageSize={10}
              csvName={`${d.name}-404-urls-${wk.start}.csv`}
              source={[S.health]}
              empty="No URL returns 404."
            />
          </div>
        )}
        {cr && (
          <div className="panel">
            <PanelTitle source={[S.health]}>Crawl requests by day</PanelTitle>
            <DataTable rows={cr.days} cols={CRAWL_COLS} initialSort="date" initialDesc={false} pageSize={7} source={[S.health]} />
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
              {cr.covered} of 7 days captured · latest day saved {cr.latestSaved || "none"}.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------- One property ---------------- */

function PropertyDetail({ site, r }: { site: WeeklySite; r?: Result }) {
  if (!r || r.loading) return <p className="muted">Loading {site.host}…</p>;
  if (r.error || !r.data) return <div className="notice error">{site.host}: {r.error || "no data"}</div>;
  const d = r.data;
  const g = d.gsc;
  const a = d.ga;
  const wk = d.week;
  const S = d.sourceIds;
  const quality = d.areas.find((x) => x.id === "quality");
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
        {
          label: "Engaged sessions",
          source: [S.ga],
          value: num(a.cmp.engaged),
          delta: <Delta cur={a.cmp.engaged} prev={a.prev.engaged} />,
          sub: `compared days · 4-wk avg ${num(a.avg4.engaged)}`,
        },
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

      <h3 style={{ margin: "24px 0 8px" }}>Indexing, 404s and crawling</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        From Google&apos;s Page indexing and Crawl stats reports (the extension captures) and the daily index checks, as saved in this property&apos;s Google
        Sheet.
      </p>
      <HealthDetail d={d} />

      <h3 style={{ margin: "24px 0 8px" }}>Traffic outcome (GA4)</h3>
      {d.gaError && <div className="notice">{d.gaError}</div>}
      {a && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {d.ga4Name} · dates in {a.timeZone}
            {a.partial ? ` · Sunday is still running there, so changes compare ${a.compareDays} day(s)` : ""}.
          </p>
          {quality && (quality.status === "watch" || quality.status === "problem") && (
            <div className="notice">
              <Pill s={quality.status} /> Traffic quality: {quality.note}
            </div>
          )}
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
            {a.spamReferrals.sites.length > 0 && (
              <div className="panel">
                <PanelTitle source={[S.ga]}>{`Spam-looking referrers (${num(a.spamReferrals.sessions)} visits)`}</PanelTitle>
                <DataTable rows={a.spamReferrals.sites} cols={groupCols("Site")} initialSort="sessions" pageSize={10} csvName={`${d.name}-spam-referrers-${wk.start}.csv`} source={[S.ga]} />
              </div>
            )}
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
  const [xlsBusy, setXlsBusy] = useState(false);
  const [xlsError, setXlsError] = useState<string | null>(null);
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
  /** Every property has finished loading (or failed), so the Excel file has everything that can be shown. */
  const ready = !!meta && meta.sites.length > 0 && meta.sites.every((s) => results[s.siteUrl] && !results[s.siteUrl].loading);

  const exportExcel = async () => {
    if (!meta) return;
    setXlsBusy(true);
    setXlsError(null);
    try {
      await downloadWeeklyExcel({ week: meta.week, sites: meta.sites, results, rules: meta.rules });
    } catch (e) {
      setXlsError(e instanceof Error ? e.message : "Couldn't build the Excel file");
    }
    setXlsBusy(false);
  };

  return (
    <SourcesProvider value={sources}>
      <Section
        title="Weekly report"
        lede="The week for the properties in your report (the Data Demand properties unless an admin picked others for you in Manage access), Monday to Sunday in Search Console's time zone (Pacific), compared with the week before and the 4-week average. Pick a property below for its full review."
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
                <button
                  className="btn primary"
                  onClick={exportExcel}
                  disabled={!ready || xlsBusy}
                  title={ready ? "One Excel file: a Summary sheet plus one sheet per property" : "Waiting for every property to load"}
                >
                  {xlsBusy ? "Building Excel…" : ready ? "Download Excel" : "Loading…"}
                </button>
                <button className="btn" onClick={() => window.print()}>Print / PDF</button>
              </div>
            </div>

            {xlsError && <div className="notice error">Excel: {xlsError}</div>}
            {meta.missing.length > 0 && (
              <div className="notice">Not found in your Search Console properties: {meta.missing.join(", ")}.</div>
            )}
            {Object.entries(meta.alsoMatched).map(([site, others]) => (
              <div key={site} className="notice">
                Using {site} for this report; also matched {others.join(", ")}. An admin can pick exact properties for you in Manage access.
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
                <Pill s="problem">Problem</Pill> across the areas that have data.
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
