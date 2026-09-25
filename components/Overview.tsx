"use client";
import { useEffect, useState } from "react";
import type { GscData, Ga4Data } from "@/lib/types";
import { Kpis, Delta, Section, num, pct, pos, KpiItem } from "./ui";
import { SearchTrend, PositionTrend, TrafficTrend } from "./Charts";
import { loadIndexCache, classify } from "@/lib/indexCache";

export default function Overview({ gsc, ga, gaError, hasGa4, site }: { gsc: GscData; ga: Ga4Data | null; gaError: string | null; hasGa4: boolean; site: string }) {
  const c = gsc.totals.current, p = gsc.totals.previous;
  const [index, setIndex] = useState<{ indexed: number; notIndexed: number } | null>(null);

  useEffect(() => {
    const cache = loadIndexCache(site);
    if (cache) {
      const r = classify(cache);
      setIndex({ indexed: r.indexed.length, notIndexed: r.notIndexed.length });
    } else setIndex(null);
  }, [site]);

  const search: KpiItem[] = [
    { label: "Clicks", value: num(c.clicks), delta: <Delta cur={c.clicks} prev={p.clicks} /> },
    { label: "Impressions", value: num(c.impressions), delta: <Delta cur={c.impressions} prev={p.impressions} /> },
    { label: "CTR", value: pct(c.ctr, 2), delta: <Delta cur={c.ctr * 100} prev={p.ctr * 100} asPoints /> },
    { label: "Avg. position", value: pos(c.position), delta: <Delta cur={c.position} prev={p.position} invert asPoints /> },
    { label: "Pages in top 10", value: num(gsc.buckets.top10), sub: `of ${num(gsc.pageCount)} pages with impressions` },
    {
      label: "Indexed / not indexed",
      value: index ? `${num(index.indexed)} / ${num(index.notIndexed)}` : "–",
      sub: index ? "from the Indexing tab scan" : "run a scan in the Indexing tab",
    },
  ];

  const g = ga?.totals;
  const traffic: KpiItem[] = g
    ? [
        { label: "Users", value: num(g.current.totalUsers), delta: <Delta cur={g.current.totalUsers} prev={g.previous.totalUsers} /> },
        { label: "New users", value: num(g.current.newUsers), delta: <Delta cur={g.current.newUsers} prev={g.previous.newUsers} /> },
        { label: "Sessions", value: num(g.current.sessions), delta: <Delta cur={g.current.sessions} prev={g.previous.sessions} /> },
        { label: "Organic search sessions", value: num(ga!.organicTotals.sessions), sub: g.current.sessions ? `${pct(ga!.organicTotals.sessions / g.current.sessions)} of sessions` : undefined },
        { label: "Page views", value: num(g.current.screenPageViews), delta: <Delta cur={g.current.screenPageViews} prev={g.previous.screenPageViews} /> },
        { label: "Active right now", value: ga!.realtime ? num(ga!.realtime.activeUsers) : "–", sub: "last 30 minutes" },
      ]
    : [];

  return (
    <>
      <Section title="Search performance" lede={`Google Search, ${gsc.range.startDate} to ${gsc.range.endDate}, compared with the ${gsc.previousRange.startDate} to ${gsc.previousRange.endDate} period.`}>
        <Kpis items={search} />
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="panel"><h3>Clicks and impressions</h3><SearchTrend data={gsc.trend} /></div>
          <div className="panel"><h3>Average position and CTR</h3><PositionTrend data={gsc.trend} /></div>
        </div>
      </Section>

      <Section title="Site traffic" lede="From Google Analytics 4, all channels.">
        {!hasGa4 && <div className="notice">Choose a GA4 property in the top bar to see users, sessions and geography for this site.</div>}
        {gaError && <div className="notice error">{gaError}</div>}
        {g && (
          <>
            <Kpis items={traffic} />
            <div className="panel" style={{ marginTop: 16 }}><h3>Users and sessions</h3><TrafficTrend data={ga!.trend} /></div>
          </>
        )}
      </Section>
    </>
  );
}
