"use client";
import { useState } from "react";
import type { GscData, QueryRow } from "@/lib/types";
import { DataTable, Kpis, Section, SubTabs, Bars, num, pct, pos, Col } from "./ui";

type V = "clicks" | "impressions" | "opportunities" | "rising" | "falling" | "questions" | "new";

export default function Queries({ gsc }: { gsc: GscData }) {
  const q = gsc.queries;
  const [view, setView] = useState<V>("clicks");

  const base: Col<QueryRow>[] = [
    { key: "key", label: "Query" },
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
    { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
  ];
  const withPrev: Col<QueryRow>[] = [
    ...base,
    { key: "prevPosition", label: "Previous", num: true, render: (r) => pos(r.prevPosition) },
    { key: "change", label: "Change", num: true, render: (r) => (r.change == null ? "–" : <span className={`delta ${r.change < 0 ? "good" : "bad"}`}>{r.change > 0 ? `▼ ${r.change}` : `▲ ${Math.abs(r.change)}`}</span>) },
  ];

  const tables: Record<V, { rows: QueryRow[]; cols: Col<QueryRow>[]; sort: keyof QueryRow & string; desc?: boolean; note: string }> = {
    clicks: { rows: q.byClicks, cols: base, sort: "clicks", note: "The 100 queries that brought the most clicks." },
    impressions: { rows: q.byImpressions, cols: base, sort: "impressions", note: "The 100 queries the site was shown for most often." },
    opportunities: { rows: q.opportunities, cols: base, sort: "impressions", note: "Queries at positions 4–20 with 20+ impressions. Small ranking gains here move the most clicks." },
    rising: { rows: q.rising, cols: withPrev, sort: "change", desc: false, note: "Biggest position gains versus the previous period." },
    falling: { rows: q.falling, cols: withPrev, sort: "change", note: "Biggest position losses versus the previous period." },
    questions: { rows: q.questions, cols: base, sort: "impressions", note: `Queries phrased as questions (${num(q.questionCount)} in total). Good candidates for FAQ and how-to content.` },
    new: { rows: q.newTop, cols: base, sort: "impressions", note: `Queries that did not appear in the previous period (${num(q.newCount)} in total).` },
  };
  const t = tables[view];

  return (
    <>
      <Section title="Query summary" lede={`What people searched before finding the site, ${gsc.range.startDate} to ${gsc.range.endDate}.`}>
        <div className="panel">
          <ul className="narrative">{q.narrative.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
        <div style={{ marginTop: 16 }}>
          <Kpis
            items={[
              { label: "Distinct queries", value: num(q.count) },
              { label: "Top 3", value: num(q.buckets.top3) },
              { label: "Page one (1–10)", value: num(q.buckets.top3 + q.buckets.top10) },
              { label: "Page two (11–20)", value: num(q.buckets.top20) },
              { label: "Page three (21–30)", value: num(q.buckets.top30) },
              { label: "Branded click share", value: q.clicks ? pct(q.branded.clicks / q.clicks) : "–", sub: `queries containing “${q.brand}”` },
              { label: "New / lost queries", value: `${num(q.newCount)} / ${num(q.lostCount)}` },
            ]}
          />
        </div>
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="panel">
            <h3>Queries by position</h3>
            <Bars
              items={[
                { label: "1–3", value: q.buckets.top3 },
                { label: "4–10", value: q.buckets.top10 },
                { label: "11–20", value: q.buckets.top20 },
                { label: "21–30", value: q.buckets.top30 },
                { label: "Beyond 30", value: q.buckets.beyond },
              ]}
            />
          </div>
          <div className="panel">
            <h3>Queries by length</h3>
            <Bars
              color="var(--r10)"
              items={[
                { label: "1–2 words", value: q.lengths.short },
                { label: "3–4 words", value: q.lengths.medium },
                { label: "5+ words", value: q.lengths.long },
              ]}
            />
            <p className="muted" style={{ marginBottom: 0 }}>
              Google hides rare queries for privacy, so query totals ({num(q.clicks)} clicks) are lower than the site total ({num(gsc.totals.current.clicks)}).
            </p>
          </div>
        </div>
      </Section>

      <Section title="Query lists">
        <div className="panel">
          <SubTabs
            value={view}
            onChange={setView}
            options={[
              { id: "clicks", label: "Top by clicks" },
              { id: "impressions", label: "Top by impressions" },
              { id: "opportunities", label: "Close to page one" },
              { id: "rising", label: "Rising" },
              { id: "falling", label: "Falling" },
              { id: "questions", label: "Questions" },
              { id: "new", label: "New" },
            ]}
          />
          <p className="muted" style={{ marginTop: 0 }}>{t.note}</p>
          <DataTable key={view} rows={t.rows} cols={t.cols} initialSort={t.sort} initialDesc={t.desc ?? true} csvName={`queries-${view}.csv`} />
        </div>
      </Section>
    </>
  );
}
