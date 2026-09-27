// components/Rankings.tsx
"use client";
import { useState } from "react";
import type { GscData, PageRow } from "@/lib/types";
import { DataTable, Section, SubTabs, num, pct, pos, Col } from "./ui";

type B = "top10" | "top20" | "top30";
const LABEL: Record<string, string> = { top10: "Positions 1–10", top20: "Positions 11–20", top30: "Positions 21–30", beyond: "Beyond 30" };

function Change({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="muted">new</span>;
  const cls = v > 0.05 ? "bad" : v < -0.05 ? "good" : "flat";
  return <span className={`delta ${cls}`}>{v > 0 ? `▼ ${v.toFixed(1)}` : v < 0 ? `▲ ${Math.abs(v).toFixed(1)}` : "0.0"}</span>;
}

export default function Rankings({ gsc }: { gsc: GscData }) {
  const [bucket, setBucket] = useState<B>("top10");
  const [lossView, setLossView] = useState<"dropped" | "vanished">("dropped");
  const b = gsc.buckets;
  const total = b.top10 + b.top20 + b.top30 + b.beyond || 1;

  const pageCols: Col<PageRow>[] = [
    { key: "key", label: "Page", url: true },
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
    { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
    { key: "prevPosition", label: "Previous", num: true, render: (r) => pos(r.prevPosition) },
  ];

  const withChange = gsc.bucketPages[bucket].map((r) => ({
    ...r,
    change: r.prevPosition == null ? undefined : +(r.position - r.prevPosition).toFixed(1),
  }));

  return (
    <>
      <Section
        title="Where pages rank"
        source={["calc.buckets"]}
        lede="Each page is placed by its average position across all queries in the period. Select a band to list its pages."
      >
        <div className="panel">
          <div className="ladder" role="group" aria-label="Pages by ranking band">
            {(["top10", "top20", "top30", "beyond"] as const).map((k) => (
              <button
                key={k}
                className={`rung r${k === "beyond" ? "beyond" : k.slice(3)}`}
                style={{ flexGrow: Math.max(b[k], total * 0.06) }}
                aria-pressed={bucket === k}
                disabled={k === "beyond"}
                onClick={() => k !== "beyond" && setBucket(k)}
                title={LABEL[k]}
              >
                <span className="n">{num(b[k])}</span>
                <span className="t">{LABEL[k]}</span>
              </button>
            ))}
          </div>
          <div className="ladder-scale"><span>Position 1</span><span>{num(gsc.pageCount)} pages with impressions</span></div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Cumulative: {num(b.top10)} in the top 10, {num(b.top10 + b.top20)} in the top 20, {num(b.top10 + b.top20 + b.top30)} in the top 30.
          </p>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>{LABEL[bucket]}</h3>
          <DataTable
            key={bucket}
            rows={withChange}
            cols={[...pageCols, { key: "change", label: "Change", num: true, render: (r) => <Change v={r.change} /> }]}
            initialSort="clicks"
            csvName={`pages-${bucket}.csv`}
            source={["calc.buckets"]}
          />
        </div>
      </Section>

      <Section
        title="Pages that lost rankings"
        source={["calc.losers", "calc.vanished"]}
        lede={`Compared with ${gsc.previousRange.startDate} to ${gsc.previousRange.endDate}. Listed pages dropped at least 5 positions and had 20+ impressions before the drop.`}
      >
        <div className="panel">
          <SubTabs
            value={lossView}
            onChange={setLossView}
            options={[
              { id: "dropped", label: `Dropped (${gsc.losers.length})` },
              { id: "vanished", label: `No longer showing (${gsc.vanished.length})` },
            ]}
          />
          {lossView === "dropped" ? (
            <DataTable
              rows={gsc.losers}
              cols={[
                { key: "key", label: "Page", url: true },
                { key: "prevPosition", label: "Was", num: true, render: (r) => pos(r.prevPosition) },
                { key: "position", label: "Now", num: true, render: (r) => pos(r.position) },
                { key: "change", label: "Lost", num: true, render: (r) => <Change v={r.change} /> },
                { key: "prevClicks", label: "Clicks before", num: true, render: (r) => num(r.prevClicks) },
                { key: "clicks", label: "Clicks now", num: true, render: (r) => num(r.clicks) },
                { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
              ]}
              initialSort="change"
              csvName="pages-lost-rank.csv"
              source={["calc.losers"]}
              empty="No page dropped 5 or more positions. Rankings held steady."
            />
          ) : (
            <DataTable
              rows={gsc.vanished}
              cols={[
                { key: "key", label: "Page", url: true },
                { key: "prevPosition", label: "Previous position", num: true, render: (r) => pos(r.prevPosition) },
                { key: "prevImpressions", label: "Previous impressions", num: true, render: (r) => num(r.prevImpressions) },
                { key: "prevClicks", label: "Previous clicks", num: true, render: (r) => num(r.prevClicks) },
              ]}
              initialSort="prevImpressions"
              csvName="pages-no-longer-showing.csv"
              source={["calc.vanished"]}
              empty="Every page that showed last period is still showing."
            />
          )}
        </div>
      </Section>
    </>
  );
}
