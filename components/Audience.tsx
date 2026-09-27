// components/Audience.tsx
"use client";
import { useState } from "react";
import type { Ga4Data } from "@/lib/types";
import { DataTable, Kpis, Section, SubTabs, Bars, Delta, PanelTitle, num, pct, duration } from "./ui";
import { TrafficTrend } from "./Charts";

export default function Audience({ ga, gaError, hasGa4, loading }: { ga: Ga4Data | null; gaError: string | null; hasGa4: boolean; loading: boolean }) {
  const [geo, setGeo] = useState<"countries" | "cities">("countries");
  if (!hasGa4) return <div className="notice">Choose a GA4 property in the top bar to see traffic and geography.</div>;
  if (gaError) return <div className="notice error">{gaError}</div>;
  if (!ga) return <div className="notice">{loading ? "Loading GA4 data…" : "No GA4 data yet."}</div>;

  const c = ga.totals.current, p = ga.totals.previous;
  const totalUsers = ga.countries.reduce((s, r) => s + r.users, 0) || 1;
  const countries = ga.countries.map((r) => ({ ...r, share: r.users / totalUsers }));

  return (
    <>
      <Section title="Traffic" lede={`Google Analytics 4, ${ga.range.startDate} to ${ga.range.endDate}. “Users” is GA4's count of unique users.`}>
        <Kpis
          items={[
            { label: "Unique users", source: ["ga4.trend", "ga4.previous"], value: num(c.totalUsers), delta: <Delta cur={c.totalUsers} prev={p.totalUsers} /> },
            { label: "New users", source: ["ga4.trend", "ga4.previous"], value: num(c.newUsers), delta: <Delta cur={c.newUsers} prev={p.newUsers} /> },
            { label: "Sessions", source: ["ga4.trend", "ga4.previous"], value: num(c.sessions), delta: <Delta cur={c.sessions} prev={p.sessions} /> },
            { label: "Page views", source: ["ga4.trend", "ga4.previous"], value: num(c.screenPageViews), delta: <Delta cur={c.screenPageViews} prev={p.screenPageViews} /> },
            { label: "Engagement rate", source: ["ga4.trend", "ga4.previous"], value: pct(c.engagementRate), delta: <Delta cur={c.engagementRate * 100} prev={p.engagementRate * 100} asPoints /> },
            { label: "Avg. session", source: ["ga4.trend", "ga4.previous"], value: duration(c.averageSessionDuration) },
          ]}
        />
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="panel"><PanelTitle source={["ga4.trend", "ga4.organic"]}>Users and sessions by day</PanelTitle><TrafficTrend data={ga.trend} /></div>
          <div className="panel">
            <PanelTitle source={["ga4.channels"]}>Sessions by channel</PanelTitle>
            <Bars items={ga.channels.map((r) => ({ label: r.channel, value: r.sessions }))} />
          </div>
        </div>
        {ga.realtime && (
          <div className="panel" style={{ marginTop: 16 }}>
            <PanelTitle source={["ga4.realtime"]}>Active in the last 30 minutes: {num(ga.realtime.activeUsers)}</PanelTitle>
            {ga.realtime.countries.length ? (
              <Bars color="var(--up)" items={ga.realtime.countries.map((r) => ({ label: r.country, value: r.users }))} />
            ) : (
              <p className="muted" style={{ margin: 0 }}>Nobody on the site right now.</p>
            )}
          </div>
        )}
      </Section>

      <Section title="Where users are" lede="Users by country and city for the selected period.">
        <div className="grid-2">
          <div className="panel">
            <PanelTitle source={["ga4.countries"]}>Top countries</PanelTitle>
            <Bars items={countries.slice(0, 15).map((r) => ({ label: r.country, value: r.users, note: `${num(r.users)} · ${pct(r.share, 0)}` }))} />
          </div>
          <div className="panel">
            <SubTabs value={geo} onChange={setGeo} options={[{ id: "countries", label: "All countries" }, { id: "cities", label: "Top cities" }]} />
            {geo === "countries" ? (
              <DataTable
                rows={countries}
                cols={[
                  { key: "country", label: "Country" },
                  { key: "users", label: "Users", num: true, render: (r) => num(r.users) },
                  { key: "share", label: "Share", num: true, render: (r) => pct(r.share) },
                  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
                  { key: "engagementRate", label: "Engaged", num: true, render: (r) => pct(r.engagementRate) },
                ]}
                initialSort="users"
                pageSize={10}
                csvName="users-by-country.csv"
                source={["ga4.countries"]}
              />
            ) : (
              <DataTable
                rows={ga.cities}
                cols={[
                  { key: "city", label: "City" },
                  { key: "country", label: "Country" },
                  { key: "users", label: "Users", num: true, render: (r) => num(r.users) },
                  { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
                ]}
                initialSort="users"
                pageSize={10}
                csvName="users-by-city.csv"
                source={["ga4.cities"]}
              />
            )}
          </div>
        </div>
      </Section>

      <Section title="Top landing pages" source={["ga4.landing"]}>
        <div className="panel">
          <DataTable
            rows={ga.landingPages}
            cols={[
              { key: "page", label: "Landing page" },
              { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
              { key: "users", label: "Users", num: true, render: (r) => num(r.users) },
              { key: "engagementRate", label: "Engaged", num: true, render: (r) => pct(r.engagementRate) },
            ]}
            initialSort="sessions"
            csvName="landing-pages.csv"
            source={["ga4.landing"]}
          />
        </div>
      </Section>
    </>
  );
}
