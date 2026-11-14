// components/History.tsx
"use client";
// The "History" tab. Search Console and GA4 numbers are saved in the Google Sheets whenever someone opens the property
// (lib/archive.ts), so they stay available after Google stops showing them (Search Console keeps about 16 months).
// The last 14 days are fetched again on each day's first open, so numbers that settle late are corrected. Month by
// month, the saved top pages and queries, GA4 breakdowns and AI pages can be opened here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataTable, Kpis, PanelTitle, Section, SubTabs, num, pct, type Col, type KpiItem } from "./ui";

type SearchDay = { date: string; clicks: number; impressions: number; ctr: number; position: number };
type GaDay = {
  date: string; users: number; newUsers: number; sessions: number; views: number; engagementRate: number; avgSessionSec: number; organicSessions: number;
};
type Link = {
  ga4: string; linkedBy: string; linkedAt: string; searchThrough: string; searchFrom: string;
  gaThrough: string; gaFrom: string; lastRun: string; lastBy: string; message: string;
};
type Status = {
  configured: boolean; link?: Link | null; searchDaily?: SearchDay[]; gaDaily?: GaDay[];
  months?: { search: string[]; ga4: string[]; ai: string[] }; parts?: { part: number; url: string }[]; googleKeepsFrom?: string;
};
type Kind = "search" | "ga4" | "ai";
type DRow = {
  type: string; name: string; clicks?: number; impressions?: number; ctr?: number; position?: number;
  sessions?: number; users?: number; engagementRate?: number;
};
type MonthData = { note: string; rows: DRow[] };

const axis = { fontSize: 12, fill: "#5b6573" };
const when = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString() : "–");
const addDays = (iso: string, k: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};
const monthName = (m: string) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  return isNaN(d.getTime()) ? m : d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
};
const link = (u: string) => (/^https?:\/\//.test(u) ? <a href={u} target="_blank" rel="noreferrer">{u}</a> : u);

const COLS: Record<Kind, Col<DRow>[]> = {
  search: [
    { key: "name", label: "Page or query", render: (r) => link(r.name) },
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks ?? 0) },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions ?? 0) },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr ?? 0, 2) },
    { key: "position", label: "Position", num: true, render: (r) => (r.position ?? 0).toFixed(1) },
  ],
  ga4: [
    { key: "name", label: "Name", render: (r) => link(r.name) },
    { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions ?? 0) },
    { key: "users", label: "Active users", num: true, render: (r) => num(r.users ?? 0) },
    { key: "engagementRate", label: "Engagement rate", num: true, render: (r) => pct(r.engagementRate ?? 0) },
  ],
  ai: [
    { key: "name", label: "Page", render: (r) => link(r.name) },
    { key: "impressions", label: "AI impressions", num: true, render: (r) => num(r.impressions ?? 0) },
  ],
};
const TYPES: Record<Kind, string[]> = { search: ["Page", "Query"], ga4: ["Channel", "Country", "Landing page"], ai: ["Page"] };
const SORT: Record<Kind, keyof DRow> = { search: "clicks", ga4: "sessions", ai: "impressions" };

export default function History({ site, ga4 }: { site: string; ga4: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>("search");
  const [month, setMonth] = useState("");
  const [type, setType] = useState("Page");
  const [detail, setDetail] = useState<MonthData | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/archive?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setSt(j as Status);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't load the saved history");
    }
  }, [site]);

  useEffect(() => {
    setSt(null);
    setErr(null);
    setMonth("");
    setDetail(null);
    load();
    // The dashboard updates the history in the background when a property is opened; show progress as it goes.
    const onUpdate = () => load();
    window.addEventListener("archive:updated", onUpdate);
    return () => window.removeEventListener("archive:updated", onUpdate);
  }, [load]);

  const months = useMemo(() => [...(st?.months?.[kind] || [])].reverse(), [st, kind]);
  useEffect(() => {
    setMonth((m) => (m && months.includes(m) ? m : months[0] || ""));
    setType(TYPES[kind][0]);
  }, [months, kind]);

  useEffect(() => {
    if (!month) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetail(null);
    setDetailErr(null);
    fetch(`/api/archive?site=${encodeURIComponent(site)}&kind=${kind}&month=${month}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        return j as MonthData;
      })
      .then((j) => {
        if (live) setDetail(j);
      })
      .catch((e) => {
        if (live) setDetailErr(e instanceof Error ? e.message : "Couldn't load that month");
      });
    return () => {
      live = false;
    };
  }, [site, kind, month]);

  const switchGa4 = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site, ga4 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setSt(j as Status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't change the GA4 property");
    }
    setBusy(false);
  };

  const ln = st?.link || null;
  const sd = st?.searchDaily || [];
  const gd = st?.gaDaily || [];
  const keeps = st?.googleKeepsFrom || "";
  const beyond = keeps ? sd.filter((d) => d.date < keeps).length : 0;
  const firstBeyond = sd.length ? addDays(sd[0].date, 487) : "";
  const parts = st?.parts || [];

  const kpis: KpiItem[] = [
    { label: "Search Console days saved", value: num(sd.length), sub: sd.length ? `${sd[0].date} to ${sd[sd.length - 1].date}` : "filled in when the property is opened" },
    {
      label: "Older than Google keeps",
      value: num(beyond),
      sub: beyond ? "days Search Console no longer shows, kept here" : firstBeyond ? `starts on ${firstBeyond}, then grows every day` : "Search Console shows about 16 months",
    },
    {
      label: "GA4 days saved",
      value: num(gd.length),
      sub: ln?.ga4 ? (gd.length ? `property ${ln.ga4} · ${gd[0].date} to ${gd[gd.length - 1].date}` : `property ${ln.ga4}`) : "no GA4 property linked",
    },
    { label: "Google Sheets used", value: num(parts.length), sub: "a continuation Sheet is added when one fills up" },
  ];

  const rows = (detail?.rows || []).filter((r) => r.type === type);
  const showKeeps = !!keeps && sd.length > 0 && sd[0].date < keeps;

  return (
    <Section
      title="Saved history"
      lede="Search Console and GA4 numbers are copied into the Google Sheets whenever someone opens this property, and kept for good, so the dashboard still has them after Google stops showing them. Search Console only keeps about 16 months. The last 14 days are fetched again each day, because Google keeps adjusting recent numbers for a while."
    >
      {err && <div className="notice error">{err}</div>}
      {!st && !err && <p className="muted">Loading…</p>}
      {st && !st.configured && <div className="notice">The Google Sheet isn&apos;t set up yet, so nothing can be saved.</div>}

      {st?.configured && (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <PanelTitle>Status</PanelTitle>
            {!ln ? (
              <p className="muted" style={{ margin: 0 }}>Saving starts now. The first time, it fills in 16 months in the background; keep the dashboard open for a few minutes.</p>
            ) : (
              <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                <li>Search Console: saved through {ln.searchThrough || "–"}; monthly lists from {ln.searchFrom ? monthName(ln.searchFrom) : "–"}.</li>
                <li>
                  GA4: {ln.ga4 ? `property ${ln.ga4}, saved through ${ln.gaThrough || "–"}; monthly lists from ${ln.gaFrom ? monthName(ln.gaFrom) : "–"}.` : "not linked yet (pick a GA4 property in the top bar)."}
                </li>
                <li>Last update: {when(ln.lastRun)}{ln.lastBy ? ` by ${ln.lastBy}` : ""}{ln.message ? ` · ${ln.message}` : ""}</li>
                <li>Updates when anyone opens this property: once a day, plus any days missed since the last update.</li>
              </ul>
            )}
            {ln?.ga4 && ga4 && ga4 !== ln.ga4 && (
              <div className="row" style={{ marginTop: 10, gap: 8, alignItems: "center" }}>
                <span className="muted">The top bar shows GA4 property {ga4}, but history is saved for {ln.ga4}.</span>
                <button className="btn" onClick={switchGa4} disabled={busy}>
                  {busy ? "Switching…" : `Save history for ${ga4} instead`}
                </button>
              </div>
            )}
          </div>

          <Kpis items={kpis} />

          {sd.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle>{`Google Search, every saved day · ${sd[0].date} to ${sd[sd.length - 1].date}`}</PanelTitle>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={sd} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#e7ebef" vertical={false} />
                  <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(2)} minTickGap={32} />
                  <YAxis yAxisId="c" tick={axis} width={48} />
                  <YAxis yAxisId="i" orientation="right" tick={axis} width={56} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 13 }} />
                  {showKeeps && <ReferenceLine yAxisId="c" x={keeps} stroke="#c5221f" strokeDasharray="4 4" label={{ value: "Search Console's limit", fontSize: 11, fill: "#c5221f" }} />}
                  <Line yAxisId="c" type="monotone" dataKey="clicks" name="Clicks" stroke="#1a73e8" strokeWidth={2} dot={false} />
                  <Line yAxisId="i" type="monotone" dataKey="impressions" name="Impressions" stroke="#9bb0d9" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="muted" style={{ marginBottom: 0 }}>
                {showKeeps ? "Everything left of the red line is no longer in Search Console; it's only here." : "When a day gets older than 16 months, Search Console drops it. It stays here."}
              </p>
            </div>
          )}

          {gd.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <PanelTitle>{`GA4 traffic, every saved day · ${gd[0].date} to ${gd[gd.length - 1].date}`}</PanelTitle>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={gd} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#e7ebef" vertical={false} />
                  <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(2)} minTickGap={32} />
                  <YAxis tick={axis} width={52} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 13 }} />
                  <Line type="monotone" dataKey="users" name="Active users" stroke="#e37400" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="sessions" name="Sessions" stroke="#f6b26b" dot={false} />
                  <Line type="monotone" dataKey="organicSessions" name="Organic sessions" stroke="#1e8e3e" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="panel" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <PanelTitle>Saved months</PanelTitle>
              <SubTabs
                value={kind}
                onChange={setKind}
                options={[
                  { id: "search", label: `Search Console (${st.months?.search.length || 0})` },
                  { id: "ga4", label: `GA4 (${st.months?.ga4.length || 0})` },
                  { id: "ai", label: `AI pages (${st.months?.ai.length || 0})` },
                ]}
              />
            </div>
            {!months.length ? (
              <p className="muted">Nothing saved here yet.</p>
            ) : (
              <>
                <div className="row" style={{ gap: 12, alignItems: "center", margin: "10px 0", flexWrap: "wrap" }}>
                  <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    Month
                    <select value={month} onChange={(e) => setMonth(e.target.value)}>
                      {months.map((m) => (
                        <option key={m} value={m}>{monthName(m)}</option>
                      ))}
                    </select>
                  </label>
                  {TYPES[kind].length > 1 && (
                    <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      Show
                      <select value={type} onChange={(e) => setType(e.target.value)}>
                        {TYPES[kind].map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {detail?.note && <span className="muted">{detail.note}</span>}
                </div>
                {detailErr && <div className="notice error">{detailErr}</div>}
                {!detail && !detailErr && <p className="muted">Loading {monthName(month)}…</p>}
                {detail && (
                  <DataTable
                    rows={rows}
                    cols={COLS[kind]}
                    initialSort={SORT[kind]}
                    pageSize={25}
                    csvName={`${kind}-${type.toLowerCase().replace(/\s+/g, "-")}-${month}.csv`}
                    empty="Nothing of this type was saved for this month."
                  />
                )}
              </>
            )}
          </div>

          {parts.length > 0 && (
            <p className="muted" style={{ marginTop: 12 }}>
              Saved in:{" "}
              {parts.map((p, i) => (
                <span key={p.url}>
                  {i ? " · " : ""}
                  <a href={p.url} target="_blank" rel="noreferrer">{p.part === 1 ? "the property's Google Sheet" : `continuation Sheet ${p.part}`}</a>
                </span>
              ))}
              . Daily totals are the &quot;Search daily&quot; and &quot;Traffic daily&quot; sections at the far right of the main tab; each month has its own tab.
            </p>
          )}
        </>
      )}
    </Section>
  );
}
