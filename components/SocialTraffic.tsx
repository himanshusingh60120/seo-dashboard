// components/SocialTraffic.tsx
"use client";
// Traffic & geography section: visits from social media (LinkedIn, Facebook, Instagram, X and others), from GA4.
// Pick a network to see every landing page it sent visitors to, its tagged links (UTM campaigns) and its daily sessions.
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Source, Sources } from "@/lib/types";
import type { Compare } from "@/lib/dates";
import type { SocialResponse } from "@/app/api/ga4/social/route";
import { SOCIAL_CHANNELS, SOCIAL_NETWORK_LIST, SOCIAL_SOURCE_PATTERN } from "@/lib/socialSources";
import { Bars, DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, duration, num, pct, useSources, type Col, type KpiItem } from "./ui";

const axis = { fontSize: 12, fill: "#5b6573" };
const SRC = ["ga4.social"];

type NetView = {
  name: string; sessions: number; prevSessions: number; change: number | null; users: number;
  rate: number; avgSec: number; keyEvents: number; sources: string;
};
type PageView = {
  network: string; page: string; url: string; sessions: number; users: number; rate: number; avgSec: number; keyEvents: number; sources: string;
};
type CampaignView = {
  network: string; campaign: string; sourceMedium: string; sessions: number; rate: number; keyEvents: number;
};

const changeText = (change: number | null, sessions: number) =>
  change == null ? (sessions ? "new" : "–") : `${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}%`;

const NET_COLS: Col<NetView>[] = [
  { key: "name", label: "Network" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "prevSessions", label: "Before", num: true, render: (r) => num(r.prevSessions) },
  {
    key: "change",
    label: "Change",
    num: true,
    render: (r) => (
      <span className={`delta ${r.change == null ? "flat" : r.change > 0 ? "good" : r.change < 0 ? "bad" : "flat"}`}>{changeText(r.change, r.sessions)}</span>
    ),
  },
  { key: "users", label: "Users", num: true, render: (r) => num(r.users) },
  { key: "rate", label: "Engagement rate", num: true, render: (r) => pct(r.rate) },
  { key: "avgSec", label: "Avg time / session", num: true, render: (r) => duration(r.avgSec) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
  { key: "sources", label: "Sources (source / medium)" },
];

const PAGE_COLS: Col<PageView>[] = [
  { key: "network", label: "Network" },
  {
    key: "page",
    label: "Landing page",
    render: (r) =>
      r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer">
          {r.page}
        </a>
      ) : (
        r.page
      ),
  },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "users", label: "Users", num: true, render: (r) => num(r.users) },
  { key: "rate", label: "Engagement rate", num: true, render: (r) => pct(r.rate) },
  { key: "avgSec", label: "Avg time / session", num: true, render: (r) => duration(r.avgSec) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
  { key: "sources", label: "Came from" },
];

const CAMPAIGN_COLS: Col<CampaignView>[] = [
  { key: "network", label: "Network" },
  { key: "campaign", label: "Campaign (utm_campaign)" },
  { key: "sourceMedium", label: "Source / medium" },
  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
  { key: "rate", label: "Engagement rate", num: true, render: (r) => pct(r.rate) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export default function SocialTraffic({ site, ga4, days, compare }: { site: string; ga4: string; days: number; compare: Compare }) {
  const outer = useSources();
  const [data, setData] = useState<SocialResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [net, setNet] = useState("all");

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setNet("all");
    if (!ga4) return;
    const q = new URLSearchParams({ property: ga4, days: String(days), compare });
    fetch(`/api/ga4/social?${q}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        return j as SocialResponse;
      })
      .then((j) => live && setData(j))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load social media traffic"));
    return () => {
      live = false;
    };
  }, [ga4, days, compare]);

  const base = site.startsWith("sc-domain:") ? `https://${site.slice(10)}` : site.replace(/\/$/, "");

  const sources = useMemo<Sources>(() => {
    if (!data) return outer;
    const s = {
      id: "ga4.social",
      label: "Visits from social media (GA4)",
      system: "Google Analytics 4 Data API (batchRunReports)",
      endpoint: `POST https://analyticsdata.googleapis.com/v1beta/properties/${ga4}:batchRunReports`,
      range: data.range,
      fetchedAt: new Date().toISOString(),
      formula:
        `Sessions in the ${SOCIAL_CHANNELS.join(" or ")} channel, or whose session source matches “${SOCIAL_SOURCE_PATTERN}” (case-insensitive), ` +
        "grouped into networks (linkedin.com, lnkd.in and linkedin are all LinkedIn). Landing page = the first page of the session. " +
        "Share = social sessions ÷ all sessions in the same dates. Users per network and per page are added up across sources, so one person can count twice.",
      verifyHow:
        "GA4 → Reports → Acquisition → Traffic acquisition, same dates, change the table to “Session source / medium” and search for linkedin, facebook and so on. " +
        "For landing pages: Reports → Engagement → Landing page, then add a filter Session source contains linkedin.",
    } as Source;
    return { ...outer, [s.id]: s };
  }, [outer, data, ga4]);

  const nets = useMemo<NetView[]>(
    () =>
      (data?.networks || []).map((n) => ({
        name: n.name,
        sessions: n.sessions,
        prevSessions: n.prevSessions,
        change: n.prevSessions ? (n.sessions - n.prevSessions) / n.prevSessions : null,
        users: n.users,
        rate: n.sessions ? n.engaged / n.sessions : 0,
        avgSec: n.sessions ? n.durationSec / n.sessions : 0,
        keyEvents: n.keyEvents,
        sources: n.sources.join(", "),
      })),
    [data]
  );

  const pages = useMemo<PageView[]>(
    () =>
      (data?.pages || [])
        .filter((p) => net === "all" || p.network === net)
        .map((p) => ({
          network: p.network,
          page: p.page,
          url: p.page.startsWith("/") ? base + p.page : "",
          sessions: p.sessions,
          users: p.users,
          rate: p.sessions ? p.engaged / p.sessions : 0,
          avgSec: p.sessions ? p.durationSec / p.sessions : 0,
          keyEvents: p.keyEvents,
          sources: p.sources,
        })),
    [data, net, base]
  );

  const campaigns = useMemo<CampaignView[]>(
    () =>
      (data?.campaigns || [])
        .filter((c) => net === "all" || c.network === net)
        .map((c) => ({
          network: c.network,
          campaign: c.campaign,
          sourceMedium: `${c.source} / ${c.medium}`,
          sessions: c.sessions,
          rate: c.sessions ? c.engaged / c.sessions : 0,
          keyEvents: c.keyEvents,
        })),
    [data, net]
  );

  const chart = useMemo(
    () => (data?.daily || []).map((d) => ({ date: d.date, sessions: net === "all" ? d.total : d.byNetwork[net] || 0 })),
    [data, net]
  );

  const label = net === "all" ? "all social networks" : net;

  let kpis: KpiItem[] = [];
  if (data) {
    const sel = net === "all" ? null : data.networks.find((n) => n.name === net) || null;
    const prev = data.totals.previous;
    const cur = sel ? { sessions: sel.sessions, users: sel.users, engaged: sel.engaged, keyEvents: sel.keyEvents } : data.totals.current;
    const prevSessions = sel ? sel.prevSessions : prev.sessions;
    const share = data.siteSessions.current ? cur.sessions / data.siteSessions.current : 0;
    const prevShare = data.siteSessions.previous ? prevSessions / data.siteSessions.previous : 0;
    kpis = [
      {
        label: sel ? `Sessions from ${sel.name}` : "Sessions from social media",
        source: SRC,
        value: num(cur.sessions),
        delta: <Delta cur={cur.sessions} prev={prevSessions} />,
      },
      {
        label: "Users",
        source: SRC,
        value: num(cur.users),
        delta: sel ? undefined : <Delta cur={cur.users} prev={prev.users} />,
        sub: sel ? "added up across its sources" : undefined,
      },
      {
        label: "Engagement rate",
        source: SRC,
        value: cur.sessions ? pct(cur.engaged / cur.sessions) : "–",
        delta:
          !sel && cur.sessions && prev.sessions ? (
            <Delta cur={(cur.engaged / cur.sessions) * 100} prev={(prev.engaged / prev.sessions) * 100} asPoints />
          ) : undefined,
      },
      {
        label: "Key events",
        source: SRC,
        value: num(cur.keyEvents),
        delta: sel ? undefined : <Delta cur={cur.keyEvents} prev={prev.keyEvents} />,
      },
      {
        label: "Share of all sessions",
        source: SRC,
        value: pct(share, 2),
        delta: <Delta cur={share * 100} prev={prevShare * 100} asPoints />,
        sub: `of ${num(data.siteSessions.current)} sessions`,
      },
      {
        label: "Landing pages",
        source: SRC,
        value: num(pages.length),
        sub: data.pagesCapped ? "GA4's row limit was reached" : "pages these visitors landed on",
      },
    ];
  }

  const hasTraffic = !!data && data.networks.some((n) => n.sessions > 0 || n.prevSessions > 0);

  return (
    <SourcesProvider value={sources}>
      <Section
        title="Social media traffic"
        source={data ? SRC : undefined}
        lede={`Visits from social media (${SOCIAL_NETWORK_LIST}), from GA4. Pick a network to see every page on your site it sent visitors to. Social networks hide which post a visitor clicked, so GA4 only sees the network itself; to see individual posts, add UTM tags to the links you share (see “Tagged links” below).`}
      >
        {!ga4 && <div className="notice">Choose a GA4 property in the top bar to see social media traffic.</div>}
        {error && <div className="notice error">{error}</div>}
        {ga4 && !data && !error && <p className="muted">Loading social media traffic…</p>}
        {data && !hasTraffic && <div className="notice">No visits from social media in this period.</div>}

        {data && hasTraffic && (
          <>
            <div className="panel" style={{ marginBottom: 16 }}>
              <SubTabs
                value={net}
                onChange={setNet}
                options={[
                  { id: "all", label: `All networks (${num(data.totals.current.sessions)})` },
                  ...data.networks.filter((n) => n.sessions > 0).map((n) => ({ id: n.name, label: `${n.name} (${num(n.sessions)})` })),
                ]}
              />
              <p className="muted" style={{ margin: 0 }}>
                {data.range.startDate} to {data.range.endDate}, compared with {data.previousRange.startDate} to {data.previousRange.endDate} (GA4 time zone{" "}
                {data.timeZone}).
              </p>
            </div>

            <Kpis items={kpis} />

            <div className="grid-2" style={{ marginTop: 16, alignItems: "stretch" }}>
              <div className="panel">
                <PanelTitle source={SRC}>Sessions by network</PanelTitle>
                <Bars
                  color="#0a66c2"
                  items={nets
                    .filter((n) => n.sessions > 0)
                    .map((n) => ({ label: n.name, value: n.sessions, note: `${num(n.sessions)} · ${changeText(n.change, n.sessions)}` }))}
                />
              </div>
              <div className="panel">
                <PanelTitle source={SRC}>{`Sessions per day · ${label}`}</PanelTitle>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#e7ebef" vertical={false} />
                    <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                    <YAxis tick={axis} width={44} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="sessions" name="Sessions" stroke="#0a66c2" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>{`Landing pages · ${label}`}</PanelTitle>
              <p className="muted" style={{ marginTop: 0 }}>
                Every page on your site where a visit from {net === "all" ? "social media" : net} started. “Came from” shows the exact sources GA4
                recorded (for LinkedIn usually linkedin.com, lnkd.in or com.linkedin.android).
              </p>
              <DataTable
                key={`pages-${net}`}
                rows={pages}
                cols={PAGE_COLS}
                initialSort="sessions"
                pageSize={50}
                csvName={`social-landing-pages-${slug(label)}.csv`}
                csvRow={(r) => ({
                  network: r.network,
                  landing_page: r.page,
                  url: r.url,
                  sessions: r.sessions,
                  users: r.users,
                  engagement_rate: Number((r.rate * 100).toFixed(1)),
                  avg_engagement_seconds: Math.round(r.avgSec),
                  key_events: r.keyEvents,
                  came_from: r.sources,
                })}
                source={SRC}
                empty={`No landing pages from ${label} in this period.`}
              />
              {data.pagesCapped && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  This period has more page-and-source combinations than one GA4 report returns ({num(25000)}), so the pages with the fewest visits may be missing.
                  Choose a shorter period for a complete list.
                </p>
              )}
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>{`Tagged links (UTM campaigns) · ${label}`}</PanelTitle>
              <p className="muted" style={{ marginTop: 0 }}>
                The only way to see which post sent a visitor. Add tags to the links you share, for example{" "}
                <code>?utm_source=linkedin&amp;utm_medium=social&amp;utm_campaign=nov-report-launch</code>, and each post shows up here as its own row.
              </p>
              <DataTable
                key={`campaigns-${net}`}
                rows={campaigns}
                cols={CAMPAIGN_COLS}
                initialSort="sessions"
                pageSize={25}
                csvName={`social-campaigns-${slug(label)}.csv`}
                source={SRC}
                empty="No tagged links in this period. Untagged posts are counted in the landing pages above, but can't be told apart."
              />
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>All networks compared</PanelTitle>
              <DataTable rows={nets} cols={NET_COLS} initialSort="sessions" csvName="social-networks.csv" source={SRC} empty="No social networks in this period." />
            </div>
          </>
        )}
      </Section>
    </SourcesProvider>
  );
}
