// components/Overview.tsx
"use client";
import { useEffect, useState } from "react";
import type { GscData, Ga4Data } from "@/lib/types";
import { Kpis, Delta, Section, PanelTitle, num, pct, pos, KpiItem } from "./ui";
import { SearchTrend, PositionTrend, TrafficTrend } from "./Charts";
import { loadIndexCache, classify } from "@/lib/indexCache";

export default function Overview({ gsc, ga, gaError, hasGa4, site }: { gsc: GscData; ga: Ga4Data | null; gaError: string | null; hasGa4: boolean; site: string }) {
  const c = gsc.totals.current, p = gsc.totals.previous;
  const [index, setIndex] = useState<{ indexed: number; notIndexed: number } | null>(null);

  useEffect(() => {
    let live = true;
    loadIndexCache(site).then((cache) => {
      if (!live) return;
      if (cache) {
        const r = classify(cache);
        setIndex({ indexed: r.indexed.length, notIndexed: r.notIndexed.length });
      } else setIndex(null);
    });
    return () => { live = false; };
  }, [site]);

  const search: KpiItem[] = [
    { label: "Clicks", source: ["gsc.totals.current", "gsc.totals.previous"], value: num(c.clicks), delta: <Delta cur={c.clicks} prev={p.clicks} /> },
    { label: "Impressions", source: ["gsc.totals.current", "gsc.totals.previous"], value: num(c.impressions), delta: <Delta cur={c.impressions} prev={p.impressions} /> },
    { label: "CTR", source: ["gsc.totals.current", "gsc.totals.previous"], value: pct(c.ctr, 2), delta: <Delta cur={c.ctr * 100} prev={p.ctr * 100} asPoints /> },
    { label: "Avg. position", source: ["gsc.totals.current", "gsc.totals.previous"], value: pos(c.position), delta: <Delta cur={c.position} prev={p.position} invert asPoints /> },
    { label: "Pages in top 10", source: ["calc.buckets"], value: num(gsc.buckets.top10), sub: `of ${num(gsc.pageCount)} pages with impressions` },
    {
      label: "Indexed / not indexed",
      source: index ? ["client.indexScan"] : undefined,
      value: index ? `${num(index.indexed)} / ${num(index.notIndexed)}` : "–",
      sub: index ? "from the Indexing tab scan" : "run a scan in the Indexing tab",
    },
  ];

  const g = ga?.totals;
  const traffic: KpiItem[] = g
    ? [
        { label: "Users", source: ["ga4.trend", "ga4.previous"], value: num(g.current.totalUsers), delta: <Delta cur={g.current.totalUsers} prev={g.previous.totalUsers} /> },
        { label: "New users", source: ["ga4.trend", "ga4.previous"], value: num(g.current.newUsers), delta: <Delta cur={g.current.newUsers} prev={g.previous.newUsers} /> },
        { label: "Sessions", source: ["ga4.trend", "ga4.previous"], value: num(g.current.sessions), delta: <Delta cur={g.current.sessions} prev={g.previous.sessions} /> },
        { label: "Organic search sessions", source: ["ga4.organic", "ga4.trend"], value: num(ga!.organicTotals.sessions), sub: g.current.sessions ? `${pct(ga!.organicTotals.sessions / g.current.sessions)} of sessions` : undefined },
        { label: "Page views", source: ["ga4.trend", "ga4.previous"], value: num(g.current.screenPageViews), delta: <Delta cur={g.current.screenPageViews} prev={g.previous.screenPageViews} /> },
        { label: "Active right now", source: ["ga4.realtime"], value: ga!.realtime ? num(ga!.realtime.activeUsers) : "–", sub: "last 30 minutes" },
      ]
    : [];

  return (
    <>
      <Section title="Search performance" lede={`Google Search, ${gsc.range.startDate} to ${gsc.range.endDate}, compared with the ${gsc.previousRange.startDate} to ${gsc.previousRange.endDate} period.`}>
        <Kpis items={search} />
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="panel"><PanelTitle source={["gsc.trend"]}>Clicks and impressions</PanelTitle><SearchTrend data={gsc.trend} /></div>
          <div className="panel"><PanelTitle source={["gsc.trend"]}>Average position and CTR</PanelTitle><PositionTrend data={gsc.trend} /></div>
        </div>
      </Section>

      <Section title="Site traffic" lede="From Google Analytics 4, all channels.">
        {!hasGa4 && <div className="notice">Choose a GA4 property in the top bar to see users, sessions and geography for this site.</div>}
        {gaError && <div className="notice error">{gaError}</div>}
        {g && (
          <>
            <Kpis items={traffic} />
            <div className="panel" style={{ marginTop: 16 }}><PanelTitle source={["ga4.trend", "ga4.organic"]}>Users and sessions</PanelTitle><TrafficTrend data={ga!.trend} /></div>
          </>
        )}
      </Section>
    </>
  );
}
