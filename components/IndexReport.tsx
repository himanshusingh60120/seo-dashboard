// components/IndexReport.tsx
"use client";
// Indexing tab, top: exact Page indexing numbers from Search Console (All known / All submitted / Unsubmitted pages).
// Google has no API for that report, so the team's Chrome extension copies it once a week into the Google Sheet.
// This screen only shows the data and who updated it; nothing can be changed or deleted here.
import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Source, Sources } from "@/lib/types";
import { addDays } from "@/lib/dates";
import { IDX_LABEL, IDX_VIEWS, latestIdxDay, type IdxView } from "@/lib/indexStats";
import { pageIndexingUrl, useIdxStore } from "@/lib/indexCapture";
import UpdatedBy, { BOOKMARKS_RETIRED, type UpdateEntry } from "./UpdatedBy";
import { DataTable, Delta, Kpis, PanelTitle, Section, SourcesProvider, SubTabs, num, pct, useSources, type Col, type KpiItem } from "./ui";

const axis = { fontSize: 12, fill: "#5b6573" };
const DAY = 864e5;
const SRC = ["client.idxImport"];
/** 0 = everything saved. Ranges longer than the saved history are disabled in the dropdown. */
const WINDOWS: [number, string][] = [
  [28, "Last 28 days"],
  [90, "Last 90 days"],
  [180, "Last 180 days"],
  [365, "Last 12 months"],
  [0, "Everything saved"],
];

type ReasonRow = { reason: string; source: string; validation: string; pages: number; share: number; prev: number | null; change: number | null };

function Change({ v }: { v: number | null }) {
  if (v == null) return <span className="muted">–</span>;
  if (v === 0) return <span className="delta flat">0</span>;
  // More pages not indexed is worse.
  return <span className={`delta ${v > 0 ? "bad" : "good"}`}>{v > 0 ? `+${num(v)}` : `−${num(-v)}`}</span>;
}

const REASON_COLS: Col<ReasonRow>[] = [
  { key: "reason", label: "Reason" },
  { key: "source", label: "Source" },
  { key: "validation", label: "Validation" },
  { key: "pages", label: "Pages", num: true, render: (r) => num(r.pages) },
  { key: "share", label: "Share", num: true, render: (r) => pct(r.share) },
  { key: "change", label: "Change since last update", num: true, render: (r) => <Change v={r.change} /> },
];

export default function IndexReport({
  site,
  inbox = null,
  onInboxHandled,
}: {
  site: string;
  /** Data from an old bookmark. Bookmarks are retired, so it's only acknowledged (kept so the Dashboard's call still compiles). */
  inbox?: string | null;
  waiting?: boolean;
  onInboxHandled?: () => void;
}) {
  const outer = useSources();
  const state = useIdxStore(site);
  const [view, setView] = useState<IdxView>("ALL_URLS");
  const [win, setWin] = useState(90);
  const [retired, setRetired] = useState(false);

  // Old bookmark clicks: nothing is saved any more; say so and clear it.
  useEffect(() => {
    if (!inbox) return;
    setRetired(true);
    onInboxHandled?.();
  }, [inbox, onInboxHandled]);

  const store = state?.store ?? null;
  const vd = store?.views[view];
  const L = latestIdxDay(vd);
  const last = store?.imports.length ? store.imports[store.imports.length - 1] : null;
  const hasData = !!store && IDX_VIEWS.some((v) => Object.keys(store.views[v]?.days || {}).length);
  const dates = useMemo(() => Object.keys(vd?.days || {}).sort(), [vd]);
  /** Days from the first to the latest saved day, inclusive. */
  const span = dates.length && L ? Math.round((Date.parse(L.date) - Date.parse(dates[0])) / DAY) + 1 : 0;

  // Compare with the saved day closest to 28 days before the latest one.
  const ref = useMemo(() => {
    if (!L || !vd) return null;
    const target = addDays(L.date, -28);
    const d = dates.filter((x) => x <= target).pop();
    return d ? { date: d, ...vd.days[d] } : null;
  }, [L, vd, dates]);

  const chart = useMemo(() => {
    if (!vd) return [];
    const ds = win && L ? dates.filter((d) => d > addDays(L.date, -win)) : dates;
    return ds.map((d) => ({ date: d, Indexed: vd.days[d].indexed, "Not indexed": vd.days[d].notIndexed }));
  }, [vd, dates, win, L]);

  const reasonRows = useMemo<ReasonRow[]>(() => {
    const list = vd?.reasons || [];
    const hist = vd?.reasonsHistory || {};
    const prevKey = Object.keys(hist).sort().filter((k) => k < (vd?.reasonsAsOf || "")).pop();
    const prev = prevKey ? hist[prevKey] : null;
    const total = list.reduce((s, r) => s + r.pages, 0) || 1;
    return list.map((r) => ({
      ...r,
      share: r.pages / total,
      prev: prev ? prev[r.reason] ?? 0 : null,
      change: prev ? r.pages - (prev[r.reason] ?? 0) : null,
    }));
  }, [vd]);

  const updates = useMemo<UpdateEntry[]>(
    () =>
      (store?.imports || []).map((i) => ({
        at: i.at,
        by: i.by,
        note: [i.from && i.to ? `${i.from} to ${i.to}` : "", (i.views || []).map((v) => IDX_LABEL[v]).join(", ")].filter(Boolean).join(" · "),
      })),
    [store]
  );

  const sources = useMemo<Sources>(() => {
    if (!hasData || !store) return outer;
    const all = IDX_VIEWS.flatMap((v) => Object.keys(store.views[v]?.days || {})).sort();
    const s = {
      id: "client.idxImport",
      label: "Page indexing (Search Console)",
      system: `Search Console Page indexing report, copied by the team's Chrome extension and saved ${state?.shared ? "in the shared Google Sheet" : "in this browser"}`,
      range: { startDate: all[0], endDate: all[all.length - 1] },
      fetchedAt: last?.at || new Date().toISOString(),
      rowCount: all.length,
      formula:
        "Daily Indexed and Not indexed counts are the exact numbers behind the report's chart (the ones its tooltip shows), merged by date across updates. " +
        "Each update is saved only when the latest day matches the report's Indexed / Not indexed tiles. " +
        "The reasons table is the report's “Why pages aren't indexed” table at the latest chart date; “Change since last update” compares it with the previous update.",
      verifyUrl: pageIndexingUrl(site, view),
      verifyLabel: "Open Page indexing in Search Console",
      verifyHow: `Search Console → Indexing → Pages, choose “${IDX_LABEL[view]}” in the dropdown, and hover the last bar of the chart: Indexed and Not indexed should match.`,
    } as Source;
    return { ...outer, [s.id]: s };
  }, [outer, hasData, store, state?.shared, last, site, view]);

  const total = L ? L.indexed + L.notIndexed : 0;
  const kpis: KpiItem[] = L
    ? [
        {
          label: "Indexed",
          source: SRC,
          value: num(L.indexed),
          delta: ref ? <Delta cur={L.indexed} prev={ref.indexed} /> : undefined,
          sub: `as of ${L.date}${ref ? ` · vs ${ref.date}` : ""}`,
        },
        {
          label: "Not indexed",
          source: SRC,
          value: num(L.notIndexed),
          delta: ref ? <Delta cur={L.notIndexed} prev={ref.notIndexed} invert /> : undefined,
          sub: `${reasonRows.length} reason${reasonRows.length === 1 ? "" : "s"}`,
        },
        { label: "Pages known", source: SRC, value: num(total), sub: "indexed + not indexed" },
        { label: "Indexed share", source: SRC, value: total ? pct(L.indexed / total) : "–" },
        { label: "Days saved", source: SRC, value: num(dates.length), sub: dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : undefined },
      ]
    : [];

  return (
    <SourcesProvider value={sources}>
      <Section
        title="Page indexing"
        source={hasData ? SRC : undefined}
        lede="Exact numbers from Search Console's Page indexing report: how many pages Google has indexed and why the rest aren't, for all known pages, the pages in your sitemaps, and pages Google found elsewhere. Google has no API for this report, so the team's Chrome extension copies it once a week; every update adds to the saved history."
      >
        {retired && <div className="notice">{BOOKMARKS_RETIRED}</div>}
        {state?.note && <div className="notice error">{state.note}</div>}
        {state && !state.shared && !state.note && (
          <div className="notice">The Google Sheet isn&apos;t set up, so only page indexing data saved earlier in this browser is shown.</div>
        )}
        {!state && <p className="muted">Loading saved page indexing data…</p>}
        {state && !hasData && (
          <div className="notice">
            No page indexing data saved for this property yet. The Chrome extension adds it with its weekly update (see the Index checks tab).
          </div>
        )}

        {hasData && (
          <>
            <SubTabs
              value={view}
              onChange={setView}
              options={IDX_VIEWS.map((v) => {
                const l = latestIdxDay(store?.views[v]);
                return { id: v, label: l ? `${IDX_LABEL[v]} (${num(l.indexed)} indexed)` : IDX_LABEL[v] };
              })}
            />

            {!L ? (
              <div className="notice" style={{ marginTop: 12 }}>
                Nothing saved for {IDX_LABEL[view]} yet. It&apos;s included in the next weekly update.
              </div>
            ) : (
              <>
                <div style={{ marginTop: 12 }}>
                  <Kpis items={kpis} />
                </div>

                <div className="panel" style={{ marginTop: 16 }}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <PanelTitle source={SRC}>{`Indexed and not indexed pages per day · ${IDX_LABEL[view]}`}</PanelTitle>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="muted">
                        Saved: {dates[0]} to {L.date} ({num(span)} days); grows with each update
                      </span>
                      <select value={win} onChange={(e) => setWin(Number(e.target.value))} aria-label="Days to show">
                        {WINDOWS.map(([d, label]) => {
                          const tooLong = d !== 0 && d > span && d !== 28;
                          return (
                            <option key={d} value={d} disabled={tooLong}>
                              {label}
                              {tooLong ? " (not enough history yet)" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={260}>
                    <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="#e7ebef" vertical={false} />
                      <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                      <YAxis tick={axis} width={56} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 13 }} />
                      <Bar dataKey="Not indexed" stackId="p" fill="#b8bcc2" />
                      <Bar dataKey="Indexed" stackId="p" fill="#1e8e3e" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="panel" style={{ marginTop: 16 }}>
                  <PanelTitle source={SRC}>{`Why pages aren't indexed · ${IDX_LABEL[view]}${vd?.reasonsAsOf ? ` · ${vd.reasonsAsOf}` : ""}`}</PanelTitle>
                  <DataTable
                    rows={reasonRows}
                    cols={REASON_COLS}
                    initialSort="pages"
                    pageSize={20}
                    csvName={`not-indexed-reasons-${view.toLowerCase()}.csv`}
                    source={SRC}
                    empty="The reasons for this view weren't saved yet. They're included in the next weekly update."
                  />
                </div>
              </>
            )}
          </>
        )}

        <UpdatedBy title="Page indexing updates" updates={updates} shared={!!state?.shared} />
      </Section>
    </SourcesProvider>
  );
}
