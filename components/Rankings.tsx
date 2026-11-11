// components/Rankings.tsx
"use client";
import { useCallback, useMemo, useState } from "react";
import type { GscData, PageRow } from "@/lib/types";
import { DataTable, Section, SubTabs, num, pct, pos, shortUrl, Col } from "./ui";
import PageQueries from "./PageQueries";
import { useAiStore } from "@/lib/aiImpressions";
import { latestAiSnapshot } from "@/lib/aiStore";
import { normalizeUrl } from "@/lib/url";

type B = "top10" | "top20" | "top30";
const LABEL: Record<string, string> = { top10: "Positions 1–10", top20: "Positions 11–20", top30: "Positions 21–30", beyond: "Beyond 30" };

type Ai = { ai: number | null };
type Row = PageRow & Ai;
type Lost = GscData["losers"][number] & Ai;
type Gone = GscData["vanished"][number] & Ai;

function Change({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="muted">new</span>;
  const cls = v > 0.05 ? "bad" : v < -0.05 ? "good" : "flat";
  return <span className={`delta ${cls}`}>{v > 0 ? `▼ ${v.toFixed(1)}` : v < 0 ? `▲ ${Math.abs(v).toFixed(1)}` : "0.0"}</span>;
}

/** Page name opens the query panel; the arrow opens the page itself. */
function PageCell({ url, onOpen }: { url: string; onOpen: (url: string) => void }) {
  return (
    <span className="page-cell">
      <button type="button" className="linkish" onClick={() => onOpen(url)} title="Show the queries this page ranked for">
        {shortUrl(url)}
      </button>
      <a href={url} target="_blank" rel="noreferrer" title="Open the page" aria-label={`Open ${url} in a new tab`}>
        ↗
      </a>
    </span>
  );
}

export default function Rankings({ gsc, site }: { gsc: GscData; site: string }) {
  const [bucket, setBucket] = useState<B>("top10");
  const [lossView, setLossView] = useState<"dropped" | "vanished">("dropped");
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);

  const aiState = useAiStore(site);
  const snap = latestAiSnapshot(aiState?.store ?? null);
  const aiOf = useCallback((url: string): number | null => (snap ? snap.pages[normalizeUrl(url)] ?? 0 : null), [snap]);

  const b = gsc.buckets;
  const total = b.top10 + b.top20 + b.top30 + b.beyond || 1;

  function pageCol<T extends { key: string }>(): Col<T> {
    return { key: "key" as keyof T & string, label: "Page", render: (r) => <PageCell url={r.key} onOpen={setOpen} /> };
  }
  function aiCols<T extends Ai>(): Col<T>[] {
    return snap ? [{ key: "ai" as keyof T & string, label: "AI impr.", num: true, render: (r) => (r.ai == null ? "–" : num(r.ai)) }] : [];
  }

  const rows = useMemo<Row[]>(
    () =>
      gsc.bucketPages[bucket].map((r) => ({
        ...r,
        change: r.prevPosition == null ? undefined : +(r.position - r.prevPosition).toFixed(1),
        ai: aiOf(r.key),
      })),
    [gsc, bucket, aiOf]
  );
  const losers = useMemo<Lost[]>(() => gsc.losers.map((r) => ({ ...r, ai: aiOf(r.key) })), [gsc, aiOf]);
  const vanished = useMemo<Gone[]>(() => gsc.vanished.map((r) => ({ ...r, ai: aiOf(r.key) })), [gsc, aiOf]);

  const pageCols: Col<Row>[] = [
    pageCol<Row>(),
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
    { key: "position", label: "Position", num: true, render: (r) => pos(r.position) },
    { key: "prevPosition", label: "Previous", num: true, render: (r) => pos(r.prevPosition) },
    { key: "change", label: "Change", num: true, render: (r) => <Change v={r.change} /> },
    ...aiCols<Row>(),
  ];

  const aiNote = snap ? (
    <p className="muted" style={{ marginBottom: 0 }}>
      AI impr. = impressions in Google&apos;s AI Overviews and AI Mode for {snap.from} to {snap.to}, from the latest imported Generative AI report
      (Overview tab). It covers that export&apos;s dates, not the period above.
    </p>
  ) : (
    <p className="muted" style={{ marginBottom: 0 }}>
      Import a Generative AI report in the Overview tab to add AI impressions per page.
    </p>
  );

  return (
    <>
      <Section
        title="Where pages rank"
        source={["calc.buckets"]}
        lede="Each page is placed by its average position across all queries in the period. Select a band to list its pages, and click a page to see the queries it ranked for."
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
          <div className="ladder-scale">
            <span>Position 1</span>
            <span>{num(gsc.pageCount)} pages with impressions</span>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Cumulative: {num(b.top10)} in the top 10, {num(b.top10 + b.top20)} in the top 20, {num(b.top10 + b.top20 + b.top30)} in the top 30.
          </p>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>{LABEL[bucket]}</h3>
          <DataTable key={bucket} rows={rows} cols={pageCols} initialSort="clicks" csvName={`pages-${bucket}.csv`} source={["calc.buckets"]} />
          {aiNote}
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
              rows={losers}
              cols={[
                pageCol<Lost>(),
                { key: "prevPosition", label: "Was", num: true, render: (r) => pos(r.prevPosition) },
                { key: "position", label: "Now", num: true, render: (r) => pos(r.position) },
                { key: "change", label: "Lost", num: true, render: (r) => <Change v={r.change} /> },
                { key: "prevClicks", label: "Clicks before", num: true, render: (r) => num(r.prevClicks) },
                { key: "clicks", label: "Clicks now", num: true, render: (r) => num(r.clicks) },
                { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
                ...aiCols<Lost>(),
              ]}
              initialSort="change"
              csvName="pages-lost-rank.csv"
              source={["calc.losers"]}
              empty="No page dropped 5 or more positions. Rankings held steady."
            />
          ) : (
            <DataTable
              rows={vanished}
              cols={[
                pageCol<Gone>(),
                { key: "prevPosition", label: "Previous position", num: true, render: (r) => pos(r.prevPosition) },
                { key: "prevImpressions", label: "Previous impressions", num: true, render: (r) => num(r.prevImpressions) },
                { key: "prevClicks", label: "Previous clicks", num: true, render: (r) => num(r.prevClicks) },
                ...aiCols<Gone>(),
              ]}
              initialSort="prevImpressions"
              csvName="pages-no-longer-showing.csv"
              source={["calc.vanished"]}
              empty="Every page that showed last period is still showing."
            />
          )}
        </div>
      </Section>

      {open && (
        <PageQueries
          site={site}
          page={open}
          gsc={gsc}
          ai={snap ? { impressions: aiOf(open) ?? 0, from: snap.from, to: snap.to } : null}
          onClose={close}
        />
      )}
    </>
  );
}
