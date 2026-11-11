// components/AiTraffic.tsx
"use client";
// Overview section: site-wide visits from AI assistants, from GA4 (sessions whose source is ChatGPT, Perplexity, Gemini and others).
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Source, Sources } from "@/lib/types";
import type { Compare } from "@/lib/dates";
import type { AiTrafficResponse } from "@/app/api/ga4/ai-traffic/route";
import { AI_ASSISTANT_LIST, AI_SOURCE_PATTERN } from "@/lib/aiSources";
import { Bars, DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, num, pct, useSources, type Col, type KpiItem } from "./ui";

const axis = { fontSize: 12, fill: "#5b6573" };
const SRC = ["ga4.aiTraffic"];

type PageRow = { page: string; url: string; sessions: number; rate: number; keyEvents: number };

const PAGE_COLS: Col<PageRow>[] = [
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
  { key: "rate", label: "Engagement rate", num: true, render: (r) => pct(r.rate) },
  { key: "keyEvents", label: "Key events", num: true, render: (r) => num(r.keyEvents) },
];

const change = (cur: number, prev: number) => {
  if (!prev) return cur ? "new" : "–";
  const d = ((cur - prev) / prev) * 100;
  return `${d > 0 ? "+" : ""}${d.toFixed(0)}%`;
};

export default function AiTraffic({ site, ga4, days, compare }: { site: string; ga4: string; days: number; compare: Compare }) {
  const outer = useSources();
  const [data, setData] = useState<AiTrafficResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    if (!ga4) return;
    const q = new URLSearchParams({ property: ga4, days: String(days), compare });
    fetch(`/api/ga4/ai-traffic?${q}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        return j as AiTrafficResponse;
      })
      .then((j) => live && setData(j))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load GA4 data"));
    return () => {
      live = false;
    };
  }, [ga4, days, compare]);

  const base = site.startsWith("sc-domain:") ? `https://${site.slice(10)}` : site.replace(/\/$/, "");

  const sources = useMemo<Sources>(() => {
    if (!data) return outer;
    const s = {
      id: "ga4.aiTraffic",
      label: "Visits from AI assistants (GA4)",
      system: "Google Analytics 4 Data API (runReport)",
      endpoint: `POST https://analyticsdata.googleapis.com/v1beta/properties/${ga4}:batchRunReports`,
      range: data.range,
      fetchedAt: new Date().toISOString(),
      formula:
        `Sessions whose session source matches “${AI_SOURCE_PATTERN}” (case-insensitive), grouped into assistants. ` +
        "Share = those sessions ÷ all sessions in the same dates. Visits from AI apps that don't pass a referrer are recorded by GA4 as Direct and can't be counted here.",
      verifyHow:
        "GA4 → Reports → Acquisition → Traffic acquisition, set the same dates, change the table to “Session source”, and search for chatgpt, perplexity, gemini and so on.",
    } as Source;
    return { ...outer, [s.id]: s };
  }, [outer, data, ga4]);

  const pages = useMemo<PageRow[]>(
    () =>
      (data?.pages || []).map((p) => ({
        page: p.page,
        url: p.page.startsWith("/") ? base + p.page : "",
        sessions: p.sessions,
        rate: p.sessions ? p.engaged / p.sessions : 0,
        keyEvents: p.keyEvents,
      })),
    [data, base]
  );

  let kpis: KpiItem[] = [];
  if (data) {
    const c = data.totals.current, p = data.totals.previous;
    const share = data.siteSessions.current ? c.sessions / data.siteSessions.current : 0;
    const prevShare = data.siteSessions.previous ? p.sessions / data.siteSessions.previous : 0;
    kpis = [
      { label: "Sessions from AI assistants", source: SRC, value: num(c.sessions), delta: <Delta cur={c.sessions} prev={p.sessions} /> },
      { label: "Users", source: SRC, value: num(c.users), delta: <Delta cur={c.users} prev={p.users} /> },
      {
        label: "Engagement rate",
        source: SRC,
        value: c.sessions ? pct(c.engaged / c.sessions) : "–",
        delta: c.sessions && p.sessions ? <Delta cur={(c.engaged / c.sessions) * 100} prev={(p.engaged / p.sessions) * 100} asPoints /> : undefined,
      },
      { label: "Key events", source: SRC, value: num(c.keyEvents), delta: <Delta cur={c.keyEvents} prev={p.keyEvents} /> },
      {
        label: "Share of all sessions",
        source: SRC,
        value: pct(share, 2),
        delta: <Delta cur={share * 100} prev={prevShare * 100} asPoints />,
        sub: `of ${num(data.siteSessions.current)} sessions`,
      },
    ];
  }

  return (
    <SourcesProvider value={sources}>
      <Section
        title="Visits from AI assistants"
        source={data ? SRC : undefined}
        lede={`People who clicked through to the site from an AI assistant (${AI_ASSISTANT_LIST}), from GA4. Some AI apps don't pass on where a visitor came from, so GA4 records those visits as Direct; these numbers are the visits GA4 can attribute.`}
      >
        {!ga4 && <div className="notice">Choose a GA4 property in the top bar to see visits from AI assistants.</div>}
        {error && <div className="notice error">{error}</div>}
        {ga4 && !data && !error && <p className="muted">Loading visits from AI assistants…</p>}

        {data && (
          <>
            <Kpis items={kpis} />

            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle source={SRC}>{`AI assistant sessions per day · ${data.range.startDate} to ${data.range.endDate}`}</PanelTitle>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={data.daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#e7ebef" vertical={false} />
                  <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                  <YAxis tick={axis} width={44} allowDecimals={false} />
                  <Tooltip />
                  <Line type="monotone" dataKey="sessions" name="Sessions" stroke="#5e35b1" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="grid-2" style={{ marginTop: 16, alignItems: "stretch" }}>
              <div className="panel">
                <PanelTitle source={SRC}>By assistant</PanelTitle>
                {data.assistants.length ? (
                  <Bars
                    color="#5e35b1"
                    items={data.assistants.map((a) => ({
                      label: a.name,
                      value: a.sessions,
                      note: `${num(a.sessions)} · ${change(a.sessions, a.prevSessions)}`,
                    }))}
                  />
                ) : (
                  <p className="muted">No visits from AI assistants in this period.</p>
                )}
              </div>
              <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
                <PanelTitle source={SRC}>Pages they landed on</PanelTitle>
                <div style={{ flex: "1 1 0", minHeight: 240, overflowY: "auto" }}>
                  <DataTable
                    rows={pages}
                    cols={PAGE_COLS}
                    initialSort="sessions"
                    pageSize={200}
                    csvName="ai-assistant-landing-pages.csv"
                    source={SRC}
                    empty="No visits from AI assistants in this period."
                  />
                </div>
              </div>
            </div>
          </>
        )}
      </Section>
    </SourcesProvider>
  );
}
