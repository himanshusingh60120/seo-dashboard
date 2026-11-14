// components/CompareMode.tsx
"use client";
// Compare months mode. Pick any months for period A and period B (one or many each); every tab then compares them,
// using the history saved in the Google Sheets (lib/compare.ts), including months Search Console no longer shows.
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataTable, Delta, Kpis, PanelTitle, Section, duration, num, pct, type Col, type KpiItem } from "./ui";

export type CompareTab = "summary" | "search" | "pages" | "queries" | "where" | "traffic" | "sources" | "ai" | "crawl";
export const COMPARE_TABS: { id: CompareTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "search", label: "Search performance" },
  { id: "pages", label: "Pages" },
  { id: "queries", label: "Queries" },
  { id: "where", label: "Countries & devices" },
  { id: "traffic", label: "Traffic (GA4)" },
  { id: "sources", label: "Channels & landing pages" },
  { id: "ai", label: "AI visibility" },
  { id: "crawl", label: "Indexing & crawl" },
];

type SearchTotals = { clicks: number; impressions: number; ctr: number; position: number; days: number };
type GaTotals = {
  users: number; usersExact: boolean; newUsers: number; sessions: number; views: number; engagementRate: number;
  avgSessionSec: number; keyEvents: number | null; organicSessions: number; days: number;
};
type MonthRow = {
  month: string; from: string; through: string; partial: boolean; onlyHere: boolean;
  search: SearchTotals | null; ga: GaTotals | null; ai: number | null; crawl: number | null;
  indexed: number | null; notIndexed: number | null; indexedAsOf: string;
};
type SearchItem = { name: string; clicks: number; impressions: number; ctr: number; position: number };
type GaItem = { name: string; sessions: number; users: number; newUsers: number; views: number; engagementRate: number; avgSessionSec: number; keyEvents: number };
type AiItem = { name: string; impressions: number };
type DailyPoint = { date: string; clicks: number | null; impressions: number | null; sessions: number | null; users: number | null };
type Group = {
  months: string[]; partial: boolean; onlyHere: number; notes: string[];
  search: SearchTotals | null; ga: GaTotals | null; ai: number | null; crawl: number | null;
  indexed: number | null; notIndexed: number | null; indexedAsOf: string;
  pages: SearchItem[]; queries: SearchItem[]; countries: SearchItem[]; devices: SearchItem[];
  channels: GaItem[]; gaCountries: GaItem[]; gaDevices: GaItem[]; landing: GaItem[];
  aiPages: { from: string; to: string; items: AiItem[] } | null;
  daily: DailyPoint[];
};
type Resp = { timeline: MonthRow[]; googleKeepsFrom: string; ga4: string; a: Group | null; b: Group | null };
type Sel = { a: string[]; b: string[] };
type Fmt = "num" | "pct" | "pos" | "dur";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const A_COLOR = "#1a73e8";
const B_COLOR = "#e8710a";
const OFF = "#d5dbe3";
const axis = { fontSize: 12, fill: "#5b6573" };

const mName = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shift = (m: string, k: number) => {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const range = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from; m <= to; m = shift(m, 1)) out.push(m);
  return out;
};
const isRun = (ms: string[]) => ms.every((m, i) => i === 0 || shift(ms[i - 1], 1) === m);
function label(ms: string[]) {
  if (!ms.length) return "no months chosen";
  const s = [...ms].sort();
  if (s.length === 1) return mName(s[0]);
  if (isRun(s)) return `${mName(s[0])} – ${mName(s[s.length - 1])} (${s.length} months)`;
  return s.length <= 4 ? s.map(mName).join(", ") : `${s.length} months: ${s.slice(0, 3).map(mName).join(", ")} …`;
}
const flip = (list: string[], m: string) => (list.includes(m) ? list.filter((x) => x !== m) : [...list, m].sort());
const fmt = (v: number | null | undefined, f: Fmt) =>
  v == null ? "–" : f === "num" ? num(v) : f === "pct" ? pct(v, 2) : f === "pos" ? (v ? v.toFixed(1) : "–") : duration(v);
const nameCell = (v: string) => (/^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : v);

function kpi(labelText: string, a: number | null | undefined, b: number | null | undefined, f: Fmt, extra?: string): KpiItem {
  const has = a != null && b != null && !(f === "pos" && (!a || !b));
  return {
    label: labelText,
    value: fmt(a, f),
    delta: has
      ? f === "pct"
        ? <Delta cur={a! * 100} prev={b! * 100} asPoints />
        : f === "pos"
          ? <Delta cur={a!} prev={b!} invert asPoints />
          : <Delta cur={a!} prev={b!} />
      : undefined,
    sub: [b != null ? `B: ${fmt(b, f)}` : "", extra || ""].filter(Boolean).join(" · ") || undefined,
  };
}

/* ---------------- Month picker ---------------- */

function Picker({ timeline, sel, setSel }: { timeline: MonthRow[]; sel: Sel; setSel: (f: (s: Sel) => Sel) => void }) {
  const [picking, setPicking] = useState<"a" | "b">("a");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const byMonth = useMemo(() => new Map(timeline.map((t) => [t.month, t])), [timeline]);
  const avail = useMemo(() => timeline.filter((t) => t.search || t.ga).map((t) => t.month), [timeline]);
  const has = (m: string) => avail.includes(m);
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const firstYear = Number((avail[0] || cur).slice(0, 4));
  const years: number[] = [];
  for (let y = Number(cur.slice(0, 4)); y >= firstYear; y--) years.push(y);
  const complete = timeline.filter((t) => t.search && !t.partial).map((t) => t.month);
  const lc = complete[complete.length - 1] || avail[avail.length - 1] || cur;
  const latest = avail[avail.length - 1] || lc;
  const year = latest.slice(0, 4);

  const presets = [
    { name: "Last month vs the month before", a: [lc], b: [shift(lc, -1)] },
    { name: "Last month vs the same month last year", a: [lc], b: [shift(lc, -12)] },
    { name: "Last 3 months vs the 3 before", a: range(shift(lc, -2), lc), b: range(shift(lc, -5), shift(lc, -3)) },
    { name: "Last 3 months vs the same months last year", a: range(shift(lc, -2), lc), b: range(shift(lc, -14), shift(lc, -12)) },
    { name: "Last 6 months vs the 6 before", a: range(shift(lc, -5), lc), b: range(shift(lc, -11), shift(lc, -6)) },
    { name: "Last 12 months vs the 12 before", a: range(shift(lc, -11), lc), b: range(shift(lc, -23), shift(lc, -12)) },
    { name: `${year} so far vs the same months of ${Number(year) - 1}`, a: range(`${year}-01`, latest), b: range(`${Number(year) - 1}-01`, shift(latest, -12)) },
  ].map((p) => ({ ...p, a: p.a.filter(has), b: p.b.filter(has) }));

  const toggle = (m: string) =>
    setSel((s) => ({
      a: picking === "a" ? flip(s.a, m) : s.a.filter((x) => x !== m),
      b: picking === "b" ? flip(s.b, m) : s.b.filter((x) => x !== m),
    }));
  const addRange = () => {
    if (!from || !to) return;
    const list = range(from < to ? from : to, from < to ? to : from).filter(has);
    setSel((s) => ({
      a: picking === "a" ? [...new Set([...s.a, ...list])].sort() : s.a.filter((x) => !list.includes(x)),
      b: picking === "b" ? [...new Set([...s.b, ...list])].sort() : s.b.filter((x) => !list.includes(x)),
    }));
  };
  const pickBtn = (g: "a" | "b") => {
    const on = picking === g;
    const color = g === "a" ? A_COLOR : B_COLOR;
    return (
      <button
        type="button"
        className="btn"
        onClick={() => setPicking(g)}
        aria-pressed={on}
        style={{ borderColor: color, background: on ? color : "#fff", color: on ? "#fff" : color, fontWeight: 600 }}
      >
        Period {g.toUpperCase()}: {label(sel[g])}
      </button>
    );
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted">Choosing months for</span>
        {pickBtn("a")}
        <span className="muted">compared with</span>
        {pickBtn("b")}
        <button type="button" className="btn" onClick={() => setSel((s) => ({ a: s.b, b: s.a }))} disabled={!sel.a.length && !sel.b.length}>
          Swap
        </button>
        <button type="button" className="btn" onClick={() => setSel(() => ({ a: [], b: [] }))}>Clear</button>
      </div>

      <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Quick pick
          <select
            value=""
            onChange={(e) => {
              const p = presets[Number(e.target.value)];
              if (p) setSel(() => ({ a: p.a, b: p.b }));
            }}
          >
            <option value="">Choose…</option>
            {presets.map((p, i) => (
              <option key={p.name} value={i} disabled={!p.a.length || !p.b.length}>
                {p.name}{!p.a.length || !p.b.length ? " (not enough saved months)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Add a range: from
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">…</option>
            {avail.map((m) => <option key={m} value={m}>{mName(m)}</option>)}
          </select>
          to
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">…</option>
            {avail.map((m) => <option key={m} value={m}>{mName(m)}</option>)}
          </select>
        </label>
        <button type="button" className="btn" onClick={addRange} disabled={!from || !to}>
          Add to period {picking.toUpperCase()}
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        {years.map((y) => (
          <div key={y} className="row" style={{ alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <b style={{ width: 48 }}>{y}</b>
            {MON.map((mn, i) => {
              const m = `${y}-${String(i + 1).padStart(2, "0")}`;
              const t = byMonth.get(m);
              const ok = !!t && !!(t.search || t.ga);
              const inA = sel.a.includes(m);
              const inB = sel.b.includes(m);
              const tip = ok
                ? `${mName(m)}${t!.partial ? ` · saved ${t!.from} to ${t!.through}` : ""}${t!.onlyHere ? " · no longer in Search Console, only in your saved history" : ""}`
                : `${mName(m)} · nothing saved`;
              return (
                <button
                  key={m}
                  type="button"
                  disabled={!ok}
                  onClick={() => toggle(m)}
                  title={tip}
                  aria-pressed={inA || inB}
                  style={{
                    minWidth: 56, padding: "4px 8px", borderRadius: 8,
                    border: `1px solid ${inA ? A_COLOR : inB ? B_COLOR : "#cfd6de"}`,
                    background: inA ? A_COLOR : inB ? B_COLOR : ok ? "#fff" : "#f2f4f7",
                    color: inA || inB ? "#fff" : ok ? "#1f2933" : "#a0a8b3",
                    cursor: ok ? "pointer" : "default",
                    fontWeight: inA || inB ? 600 : 400,
                    fontStyle: t?.partial ? "italic" : undefined,
                    boxShadow: ok && t?.onlyHere ? "inset 0 -3px 0 #7b1fa2" : undefined,
                  }}
                >
                  {mn}{t?.partial ? "*" : ""}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Click months to add them to the period you&apos;re choosing; a period can have one month or many. Purple underline = no longer
        in Search Console, only in your saved history. * = part of the month.
      </p>
    </div>
  );
}

/* ---------------- Charts and tables ---------------- */

type MDef = { id: string; label: string; get: (t: MonthRow) => number | null; f: Fmt };

const SEARCH_DEFS: MDef[] = [
  { id: "clicks", label: "Clicks", get: (t) => t.search?.clicks ?? null, f: "num" },
  { id: "impressions", label: "Impressions", get: (t) => t.search?.impressions ?? null, f: "num" },
  { id: "ctr", label: "CTR", get: (t) => t.search?.ctr ?? null, f: "pct" },
  { id: "position", label: "Average position", get: (t) => t.search?.position || null, f: "pos" },
];
const GA_DEFS: MDef[] = [
  { id: "users", label: "Active users", get: (t) => t.ga?.users ?? null, f: "num" },
  { id: "sessions", label: "Sessions", get: (t) => t.ga?.sessions ?? null, f: "num" },
  { id: "organic", label: "Organic sessions", get: (t) => t.ga?.organicSessions ?? null, f: "num" },
  { id: "newUsers", label: "New users", get: (t) => t.ga?.newUsers ?? null, f: "num" },
  { id: "views", label: "Views", get: (t) => t.ga?.views ?? null, f: "num" },
  { id: "keyEvents", label: "Key events", get: (t) => t.ga?.keyEvents ?? null, f: "num" },
  { id: "engagement", label: "Engagement rate", get: (t) => t.ga?.engagementRate ?? null, f: "pct" },
];
const AI_DEFS: MDef[] = [{ id: "ai", label: "AI impressions", get: (t) => t.ai, f: "num" }];
const CRAWL_DEFS: MDef[] = [
  { id: "crawl", label: "Crawl requests", get: (t) => t.crawl, f: "num" },
  { id: "indexed", label: "Indexed pages (month end)", get: (t) => t.indexed, f: "num" },
  { id: "notIndexed", label: "Not indexed pages (month end)", get: (t) => t.notIndexed, f: "num" },
];

function MonthChart({ timeline, sel, defs, title }: { timeline: MonthRow[]; sel: Sel; defs: MDef[]; title: string }) {
  const [id, setId] = useState(defs[0].id);
  const d = defs.find((x) => x.id === id) || defs[0];
  const data = timeline
    .map((t) => ({ month: t.month, name: `${mName(t.month)}${t.partial ? "*" : ""}`, v: d.get(t), g: sel.a.includes(t.month) ? "A" : sel.b.includes(t.month) ? "B" : "" }))
    .filter((x) => x.v != null);
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>{title}</PanelTitle>
        {defs.length > 1 && (
          <select value={d.id} onChange={(e) => setId(e.target.value)} aria-label="Metric">
            {defs.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        )}
      </div>
      {!data.length ? (
        <p className="muted">Nothing saved for this yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e7ebef" vertical={false} />
            <XAxis dataKey="name" tick={axis} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tick={axis} width={56} reversed={d.f === "pos"} />
            <Tooltip formatter={(v) => fmt(Number(v), d.f)} />
            <Bar dataKey="v" name={d.label}>
              {data.map((x) => <Cell key={x.month} fill={x.g === "A" ? A_COLOR : x.g === "B" ? B_COLOR : OFF} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>
        Every saved month. <span style={{ color: A_COLOR, fontWeight: 600 }}>Blue = period A</span>,{" "}
        <span style={{ color: B_COLOR, fontWeight: 600 }}>orange = period B</span>, grey = not selected. * = part of the month.
      </p>
    </div>
  );
}

type DDef = { id: keyof DailyPoint; label: string; f: Fmt };

function Aligned({ a, b, defs, title }: { a: DailyPoint[]; b: DailyPoint[]; defs: DDef[]; title: string }) {
  const [id, setId] = useState<keyof DailyPoint>(defs[0].id);
  const d = defs.find((x) => x.id === id) || defs[0];
  const sa = a.filter((p) => p[d.id] != null);
  const sb = b.filter((p) => p[d.id] != null);
  const len = Math.max(sa.length, sb.length);
  const data = Array.from({ length: len }, (_, i) => ({
    day: i + 1,
    A: sa[i] ? Number(sa[i][d.id]) : null,
    B: sb[i] ? Number(sb[i][d.id]) : null,
  }));
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>{title}</PanelTitle>
        {defs.length > 1 && (
          <select value={String(d.id)} onChange={(e) => setId(e.target.value as keyof DailyPoint)} aria-label="Metric">
            {defs.map((x) => <option key={String(x.id)} value={String(x.id)}>{x.label}</option>)}
          </select>
        )}
      </div>
      {!len ? (
        <p className="muted">No daily data saved for these months.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e7ebef" vertical={false} />
            <XAxis dataKey="day" tick={axis} />
            <YAxis tick={axis} width={52} />
            <Tooltip formatter={(v) => fmt(Number(v), d.f)} labelFormatter={(l) => `Day ${l}`} />
            <Legend wrapperStyle={{ fontSize: 13 }} />
            <Line type="monotone" dataKey="A" name={`Period A · ${d.label}`} stroke={A_COLOR} strokeWidth={2} dot={false} connectNulls />
            <Line type="monotone" dataKey="B" name={`Period B · ${d.label}`} stroke={B_COLOR} strokeWidth={2} dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>Day 1 is the first saved day of each period, so the two periods line up day by day.</p>
    </div>
  );
}

type MRow = { name: string; a: number; b: number; aHas: boolean; bHas: boolean; change: number; pctChange: number; status: string };
type TMetric<T> = { key: keyof T; label: string; f: Fmt; lowerBetter?: boolean };

function ChangeCell({ r, f, lowerBetter }: { r: MRow; f: Fmt; lowerBetter?: boolean }) {
  if (!r.aHas || !r.bHas) return <span className="muted">{r.aHas ? "only in A" : "only in B"}</span>;
  const d = r.a - r.b;
  if (!d) return <span className="delta flat">0</span>;
  const good = lowerBetter ? d < 0 : d > 0;
  const sign = d > 0 ? "+" : "−";
  const txt = f === "pct" ? `${sign}${Math.abs(d * 100).toFixed(2)} pts` : f === "pos" ? `${sign}${Math.abs(d).toFixed(1)}` : f === "dur" ? `${sign}${duration(Math.abs(d))}` : `${sign}${num(Math.abs(d))}`;
  return <span className={`delta ${good ? "good" : "bad"}`}>{txt}</span>;
}

function CompareTable<T extends { name: string }>({ title, a, b, metrics, csv, note }: { title: string; a: T[]; b: T[]; metrics: TMetric<T>[]; csv: string; note?: string }) {
  const [mi, setMi] = useState(0);
  const [filter, setFilter] = useState("all");
  const m = metrics[Math.min(mi, metrics.length - 1)];
  const rows = useMemo<MRow[]>(() => {
    const A = new Map(a.map((x) => [x.name, Number(x[m.key]) || 0]));
    const B = new Map(b.map((x) => [x.name, Number(x[m.key]) || 0]));
    return [...new Set([...A.keys(), ...B.keys()])].map((name) => {
      const aHas = A.has(name), bHas = B.has(name);
      const av = A.get(name) ?? 0, bv = B.get(name) ?? 0;
      const better = aHas && bHas && (m.lowerBetter ? av < bv : av > bv);
      const worse = aHas && bHas && (m.lowerBetter ? av > bv : av < bv);
      return {
        name, a: av, b: bv, aHas, bHas,
        change: aHas && bHas ? av - bv : aHas ? av : -bv,
        pctChange: aHas && bHas && bv ? (av - bv) / bv : 0,
        status: !bHas ? "Only in A" : !aHas ? "Only in B" : better ? "Better in A" : worse ? "Worse in A" : "Same",
      };
    });
  }, [a, b, m]);
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);
  const cols: Col<MRow>[] = [
    { key: "name", label: "Name", render: (r) => nameCell(r.name) },
    { key: "a", label: `${m.label} · A`, num: true, render: (r) => (r.aHas ? fmt(r.a, m.f) : "–") },
    { key: "b", label: `${m.label} · B`, num: true, render: (r) => (r.bHas ? fmt(r.b, m.f) : "–") },
    { key: "change", label: "Change", num: true, render: (r) => <ChangeCell r={r} f={m.f} lowerBetter={m.lowerBetter} /> },
    { key: "pctChange", label: "% change", num: true, render: (r) => (r.aHas && r.bHas && r.b && m.f === "num" ? pct(r.pctChange, 1) : "–") },
    { key: "status", label: "" },
  ];
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>{title}</PanelTitle>
        <div className="row" style={{ gap: 8 }}>
          {metrics.length > 1 && (
            <select value={mi} onChange={(e) => setMi(Number(e.target.value))} aria-label="Compare by">
              {metrics.map((x, i) => <option key={String(x.key)} value={i}>{x.label}</option>)}
            </select>
          )}
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">
            <option value="all">All ({rows.length})</option>
            {["Better in A", "Worse in A", "Only in A", "Only in B"].map((x) => (
              <option key={x} value={x}>{x} ({rows.filter((r) => r.status === x).length})</option>
            ))}
          </select>
        </div>
      </div>
      <DataTable
        rows={shown}
        cols={cols}
        initialSort="a"
        pageSize={25}
        csvName={csv}
        csvRow={(r) => ({ name: r.name, [`${m.label} A`]: r.aHas ? r.a : "", [`${m.label} B`]: r.bHas ? r.b : "", change: r.aHas && r.bHas ? r.a - r.b : "", status: r.status })}
        empty="Nothing saved for these months."
      />
      {note && <p className="muted" style={{ marginBottom: 0 }}>{note}</p>}
    </div>
  );
}

const S_METRICS: TMetric<SearchItem>[] = [
  { key: "clicks", label: "Clicks", f: "num" },
  { key: "impressions", label: "Impressions", f: "num" },
  { key: "ctr", label: "CTR", f: "pct" },
  { key: "position", label: "Average position", f: "pos", lowerBetter: true },
];
const G_METRICS: TMetric<GaItem>[] = [
  { key: "sessions", label: "Sessions", f: "num" },
  { key: "users", label: "Active users", f: "num" },
  { key: "keyEvents", label: "Key events", f: "num" },
  { key: "newUsers", label: "New users", f: "num" },
  { key: "views", label: "Views", f: "num" },
  { key: "engagementRate", label: "Engagement rate", f: "pct" },
  { key: "avgSessionSec", label: "Avg session", f: "dur" },
];

/* ---------------- The mode ---------------- */

export default function CompareMode({ site, ga4, tab }: { site: string; ga4: string; tab: CompareTab }) {
  const [base, setBase] = useState<Resp | null>(null);
  const [res, setRes] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Sel>({ a: [], b: [] });
  const storeKey = `dash:compare:${site}`;

  // Which months are saved (for the picker), and the last selection for this property.
  useEffect(() => {
    let live = true;
    setBase(null);
    setRes(null);
    setErr(null);
    fetch(`/api/compare?site=${encodeURIComponent(site)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        return j as Resp;
      })
      .then((j) => {
        if (!live) return;
        setBase(j);
        const have = new Set(j.timeline.filter((t) => t.search || t.ga).map((t) => t.month));
        let saved: Sel | null = null;
        try {
          saved = JSON.parse(localStorage.getItem(`dash:compare:${site}`) || "null");
        } catch {
          saved = null;
        }
        if (saved && Array.isArray(saved.a) && Array.isArray(saved.b) && (saved.a.length || saved.b.length)) {
          setSel({ a: saved.a.filter((m) => have.has(m)), b: saved.b.filter((m) => have.has(m)) });
        } else {
          const complete = j.timeline.filter((t) => t.search && !t.partial).map((t) => t.month);
          const last = complete[complete.length - 1] || [...have].sort().pop() || "";
          setSel(last ? { a: [last], b: have.has(shift(last, -1)) ? [shift(last, -1)] : [] } : { a: [], b: [] });
        }
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : "Couldn't load the saved months"));
    return () => {
      live = false;
    };
  }, [site]);

  // The comparison itself, whenever the selection changes.
  useEffect(() => {
    if (!base) return;
    try {
      localStorage.setItem(storeKey, JSON.stringify(sel));
    } catch {
      /* storage unavailable */
    }
    if (!sel.a.length && !sel.b.length) {
      setRes(null);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/compare?site=${encodeURIComponent(site)}&a=${sel.a.join(",")}&b=${sel.b.join(",")}`, { cache: "no-store" })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
          return j as Resp;
        })
        .then((j) => {
          if (live) {
            setRes(j);
            setErr(null);
          }
        })
        .catch((e) => live && setErr(e instanceof Error ? e.message : "Couldn't load the comparison"))
        .finally(() => live && setLoading(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sel, base, site, storeKey]);

  const switchGa4 = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ site, ga4 }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setBase((b) => (b ? { ...b, ga4 } : b));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't change the GA4 property");
    }
    setBusy(false);
  };

  const timeline = res?.timeline || base?.timeline || [];
  const A = res?.a || null;
  const B = res?.b || null;
  const savedGa4 = res?.ga4 ?? base?.ga4 ?? "";
  const notes = [...new Set([...(A?.notes || []), ...(B?.notes || [])])];
  const usersNote = (g: GaTotals | null | undefined) => (g && !g.usersExact ? "sum of monthly users" : "");
  const monthsRows = timeline
    .filter((t) => sel.a.includes(t.month) || sel.b.includes(t.month))
    .map((t) => ({
      month: t.month, period: sel.a.includes(t.month) ? "A" : "B",
      clicks: t.search?.clicks ?? 0, impressions: t.search?.impressions ?? 0, ctr: t.search?.ctr ?? 0, position: t.search?.position ?? 0,
      users: t.ga?.users ?? 0, sessions: t.ga?.sessions ?? 0, organic: t.ga?.organicSessions ?? 0, ai: t.ai ?? 0, crawl: t.crawl ?? 0,
      flags: [t.partial ? `part month (${t.from} to ${t.through})` : "", t.onlyHere ? "only in saved history" : ""].filter(Boolean).join(" · "),
    }));
  type MonthLine = (typeof monthsRows)[number];
  const MONTH_COLS: Col<MonthLine>[] = [
    { key: "month", label: "Month", render: (r) => mName(r.month) },
    { key: "period", label: "Period", render: (r) => <b style={{ color: r.period === "A" ? A_COLOR : B_COLOR }}>{r.period}</b> },
    { key: "clicks", label: "Clicks", num: true, render: (r) => num(r.clicks) },
    { key: "impressions", label: "Impressions", num: true, render: (r) => num(r.impressions) },
    { key: "ctr", label: "CTR", num: true, render: (r) => pct(r.ctr, 2) },
    { key: "position", label: "Position", num: true, render: (r) => (r.position ? r.position.toFixed(1) : "–") },
    { key: "users", label: "Active users", num: true, render: (r) => num(r.users) },
    { key: "sessions", label: "Sessions", num: true, render: (r) => num(r.sessions) },
    { key: "organic", label: "Organic sessions", num: true, render: (r) => num(r.organic) },
    { key: "ai", label: "AI impressions", num: true, render: (r) => num(r.ai) },
    { key: "crawl", label: "Crawl requests", num: true, render: (r) => num(r.crawl) },
    { key: "flags", label: "" },
  ];

  const views: Record<CompareTab, JSX.Element | null> = {
    summary: (
      <>
        <Kpis
          items={[
            kpi("Clicks", A?.search?.clicks, B?.search?.clicks, "num"),
            kpi("Impressions", A?.search?.impressions, B?.search?.impressions, "num"),
            kpi("CTR", A?.search?.ctr, B?.search?.ctr, "pct"),
            kpi("Average position", A?.search?.position, B?.search?.position, "pos"),
            kpi("Active users", A?.ga?.users, B?.ga?.users, "num", usersNote(A?.ga)),
            kpi("Sessions", A?.ga?.sessions, B?.ga?.sessions, "num"),
            kpi("Organic sessions", A?.ga?.organicSessions, B?.ga?.organicSessions, "num"),
            kpi("Key events", A?.ga?.keyEvents, B?.ga?.keyEvents, "num"),
            kpi("AI impressions", A?.ai, B?.ai, "num"),
            kpi("Crawl requests", A?.crawl, B?.crawl, "num"),
            kpi("Indexed pages", A?.indexed, B?.indexed, "num", A?.indexedAsOf ? `A as of ${A.indexedAsOf}` : ""),
          ]}
        />
        <MonthChart timeline={timeline} sel={sel} defs={[...SEARCH_DEFS, ...GA_DEFS, ...AI_DEFS, ...CRAWL_DEFS]} title="Month by month" />
        <div className="panel" style={{ marginTop: 16 }}>
          <PanelTitle>Each selected month</PanelTitle>
          <DataTable rows={monthsRows} cols={MONTH_COLS} initialSort="month" pageSize={36} csvName={`months-${site.replace(/\W+/g, "-")}.csv`} empty="Choose some months above." />
        </div>
      </>
    ),
    search: (
      <>
        <Kpis
          items={[
            kpi("Clicks", A?.search?.clicks, B?.search?.clicks, "num"),
            kpi("Impressions", A?.search?.impressions, B?.search?.impressions, "num"),
            kpi("CTR", A?.search?.ctr, B?.search?.ctr, "pct"),
            kpi("Average position", A?.search?.position, B?.search?.position, "pos"),
            kpi("Days saved", A?.search?.days, B?.search?.days, "num"),
          ]}
        />
        <Aligned
          a={A?.daily || []}
          b={B?.daily || []}
          defs={[{ id: "clicks", label: "Clicks", f: "num" }, { id: "impressions", label: "Impressions", f: "num" }]}
          title="Day by day, both periods lined up"
        />
        <MonthChart timeline={timeline} sel={sel} defs={SEARCH_DEFS} title="Google Search, month by month" />
      </>
    ),
    pages: <CompareTable title="Pages" a={A?.pages || []} b={B?.pages || []} metrics={S_METRICS} csv="compare-pages.csv" note={notes.find((x) => x.startsWith("Pages and queries"))} />,
    queries: <CompareTable title="Queries" a={A?.queries || []} b={B?.queries || []} metrics={S_METRICS} csv="compare-queries.csv" note={notes.find((x) => x.startsWith("Pages and queries"))} />,
    where: (
      <>
        <CompareTable title="Countries (Google Search)" a={A?.countries || []} b={B?.countries || []} metrics={S_METRICS} csv="compare-search-countries.csv" />
        <CompareTable title="Devices (Google Search)" a={A?.devices || []} b={B?.devices || []} metrics={S_METRICS} csv="compare-search-devices.csv" />
      </>
    ),
    traffic: (
      <>
        <Kpis
          items={[
            kpi("Active users", A?.ga?.users, B?.ga?.users, "num", usersNote(A?.ga)),
            kpi("New users", A?.ga?.newUsers, B?.ga?.newUsers, "num"),
            kpi("Sessions", A?.ga?.sessions, B?.ga?.sessions, "num"),
            kpi("Organic sessions", A?.ga?.organicSessions, B?.ga?.organicSessions, "num"),
            kpi("Views", A?.ga?.views, B?.ga?.views, "num"),
            kpi("Engagement rate", A?.ga?.engagementRate, B?.ga?.engagementRate, "pct"),
            kpi("Avg session", A?.ga?.avgSessionSec, B?.ga?.avgSessionSec, "dur"),
            kpi("Key events", A?.ga?.keyEvents, B?.ga?.keyEvents, "num"),
          ]}
        />
        <Aligned
          a={A?.daily || []}
          b={B?.daily || []}
          defs={[{ id: "sessions", label: "Sessions", f: "num" }, { id: "users", label: "Daily active users", f: "num" }]}
          title="Day by day, both periods lined up"
        />
        <MonthChart timeline={timeline} sel={sel} defs={GA_DEFS} title="GA4 traffic, month by month" />
      </>
    ),
    sources: (
      <>
        <CompareTable title="Channels" a={A?.channels || []} b={B?.channels || []} metrics={G_METRICS} csv="compare-channels.csv" />
        <CompareTable title="Landing pages" a={A?.landing || []} b={B?.landing || []} metrics={G_METRICS} csv="compare-landing-pages.csv" note="Each month's top 1,000 landing pages by sessions, added up over the selected months." />
        <CompareTable title="Countries (GA4)" a={A?.gaCountries || []} b={B?.gaCountries || []} metrics={G_METRICS} csv="compare-ga4-countries.csv" />
        <CompareTable title="Devices (GA4)" a={A?.gaDevices || []} b={B?.gaDevices || []} metrics={G_METRICS} csv="compare-ga4-devices.csv" />
        <p className="muted">Active users per row is added up over the selected months, so one person can be counted in more than one month.</p>
      </>
    ),
    ai: (
      <>
        <Kpis items={[kpi("AI impressions", A?.ai, B?.ai, "num")]} />
        <MonthChart timeline={timeline} sel={sel} defs={AI_DEFS} title="AI impressions, month by month" />
        <CompareTable
          title="Pages linked by AI"
          a={A?.aiPages?.items || []}
          b={B?.aiPages?.items || []}
          metrics={[{ key: "impressions", label: "AI impressions", f: "num" }]}
          csv="compare-ai-pages.csv"
          note={`Page lists come from the latest weekly capture in each period and cover its own dates (A: ${A?.aiPages ? `${A.aiPages.from} to ${A.aiPages.to}` : "none"}; B: ${B?.aiPages ? `${B.aiPages.from} to ${B.aiPages.to}` : "none"}).`}
        />
      </>
    ),
    crawl: (
      <>
        <Kpis
          items={[
            kpi("Crawl requests", A?.crawl, B?.crawl, "num"),
            kpi("Indexed pages", A?.indexed, B?.indexed, "num", A?.indexedAsOf ? `A as of ${A.indexedAsOf}` : ""),
            kpi("Not indexed pages", A?.notIndexed, B?.notIndexed, "num"),
          ]}
        />
        <MonthChart timeline={timeline} sel={sel} defs={CRAWL_DEFS} title="Crawling and indexing, month by month" />
        <p className="muted">From the weekly captures. Indexed counts are Google&apos;s own numbers (All known pages) on the last saved day of each month.</p>
      </>
    ),
  };

  return (
    <Section
      title="Compare months"
      lede="Pick any months for period A and period B. Every tab compares them using the history saved in your Google Sheets, including months Search Console no longer shows."
    >
      {err && <div className="notice error">{err}</div>}
      {!base && !err && <p className="muted">Loading the saved months…</p>}
      {base && !timeline.length && (
        <div className="notice">
          Nothing is saved for this property yet. History is saved in the background when the property is opened; the first time takes a
          few minutes, so leave the dashboard open and come back.
        </div>
      )}
      {base && timeline.length > 0 && (
        <>
          <Picker timeline={timeline} sel={sel} setSel={(f) => setSel((s) => f(s))} />
          {savedGa4 && ga4 && savedGa4 !== ga4 && (
            <div className="notice" style={{ marginBottom: 12 }}>
              GA4 history is saved for property {savedGa4}, but the top bar shows {ga4}.{" "}
              <button className="btn small" onClick={switchGa4} disabled={busy}>{busy ? "Switching…" : `Save history for ${ga4} instead`}</button>
            </div>
          )}
          {!savedGa4 && <div className="notice" style={{ marginBottom: 12 }}>No GA4 property is linked yet. Pick one in the top bar; it links the next time this property is opened.</div>}
          {loading && <p className="muted">Comparing…</p>}
          {notes.length > 0 && (
            <ul className="muted" style={{ margin: "0 0 8px", paddingLeft: 18 }}>
              {notes.map((x) => <li key={x}>{x}</li>)}
            </ul>
          )}
          {res && (A || B) ? (
            <div style={{ opacity: loading ? 0.6 : 1 }}>{views[tab]}</div>
          ) : (
            !loading && <p className="muted">Choose months for period A and period B above.</p>
          )}
        </>
      )}
    </Section>
  );
}
