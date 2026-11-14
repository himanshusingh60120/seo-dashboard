// components/CompareMode.tsx
"use client";
// Compare months mode. Pick any months for period A (left) and period B (right); every tab then compares them,
// using the history saved in the Google Sheets (lib/compare.ts), including months Search Console no longer shows.
// Written for executives: period names instead of A/B, plain-language headlines, every chart on screen, "Not saved"
// instead of zeros, Google's ranking updates marked on the charts, and a print / PDF button.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataTable, PanelTitle, Section, compact, duration, num, pct, type Col } from "./ui";
import type { Coverage, DailyPoint, Group, MonthPoint, MonthRow } from "@/lib/compare";
import {
  UPDATE_COLOR, UpdatesList, fmtDay, shortUpdateName, todayStr, updatesInMonths, useGoogleUpdates, type GoogleUpdate,
} from "./googleUpdates";

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

type Resp = { timeline: MonthRow[]; googleKeepsFrom: string; ga4: string; a: Group | null; b: Group | null };
type Sel = { a: string[]; b: string[] };
type Side = "a" | "b";
type Fmt = "num" | "pct" | "pos" | "dur";
type Names = { a: string; b: string };
type Tone = "good" | "bad" | "flat";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const A_COLOR = "#1a73e8";
const B_COLOR = "#e8710a";
const A_TINT = "#e8f0fe";
const B_TINT = "#feefe3";
const OFF = "#d5dbe3";
const INK = "#202124";
const MUTED = "#5f6368";
const axis = { fontSize: 12, fill: MUTED };
const TONE: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: "#e6f4ea", fg: "#137333" },
  bad: { bg: "#fce8e6", fg: "#c5221f" },
  flat: { bg: "#f1f3f4", fg: MUTED },
};
/** Wait after the last click before asking the server, so picking several months sends one request. */
const DEBOUNCE_MS = 900;

/** Google's ranking updates, shared with every chart below. */
const UpdatesCtx = createContext<GoogleUpdate[]>([]);

/* ---------------- Month and number helpers ---------------- */

const mi = (m: string) => Number(m.slice(5, 7)) - 1;
const mName = (m: string) => `${MON[mi(m)]} ${m.slice(0, 4)}`;
const yy = (m: string) => `'${m.slice(2, 4)}`;
const monthId = (y: number, i: number) => `${y}-${String(i + 1).padStart(2, "0")}`;
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
const daysIn = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), mi(m) + 1, 0)).getUTCDate();
const isRun = (ms: string[]) => ms.every((m, i) => i === 0 || shift(ms[i - 1], 1) === m);
const flip = (list: string[], m: string) => (list.includes(m) ? list.filter((x) => x !== m) : [...list, m].sort());

/** Short name used everywhere: "Sep–Nov 2026", "Nov 2025 – Jan 2026", "6 months, Sep 2025 – Nov 2026". */
function periodName(ms: string[]) {
  if (!ms.length) return "";
  const s = [...ms].sort();
  const f = s[0], l = s[s.length - 1];
  if (s.length === 1) return mName(f);
  if (isRun(s)) return f.slice(0, 4) === l.slice(0, 4) ? `${MON[mi(f)]}–${MON[mi(l)]} ${l.slice(0, 4)}` : `${mName(f)} – ${mName(l)}`;
  if (s.length <= 3) return s.map(mName).join(", ");
  return `${s.length} months, ${mName(f)} – ${mName(l)}`;
}

const fmt = (v: number | null | undefined, f: Fmt) =>
  v == null ? "–" : f === "num" ? num(v) : f === "pct" ? pct(v, 2) : f === "pos" ? (v ? v.toFixed(1) : "–") : duration(v);
/** Big numbers shortened for cards and bar labels (14.1M); the full number is in the tooltip. */
const short = (v: number | null | undefined, f: Fmt) =>
  v == null ? "–" : f === "num" ? (Math.abs(v) >= 10_000 ? compact(v) : num(v)) : f === "pct" ? `${(v * 100).toFixed(2)}%` : f === "pos" ? (v ? v.toFixed(1) : "–") : duration(v);
const tickFmt = (v: number, f: Fmt) => (f === "pct" ? `${(v * 100).toFixed(1)}%` : f === "num" ? compact(v) : f === "dur" ? `${Math.round(v)}s` : String(Math.round(v)));
const nameCell = (v: string) => (/^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : v);

/** Google's quota error in plain words. */
const friendly = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message : "";
  return /quota exceeded|read requests/i.test(m)
    ? "Google Sheets is busy right now (too many reads in the last minute). Wait about a minute, then reload or change a month."
    : m || fallback;
};

/** The change from B to A, worded for a reader: "+12.4%", "+0.03 pts", "3.1 better". */
function change(a: number | null | undefined, b: number | null | undefined, f: Fmt, lowerBetter = false): { text: string; tone: Tone } | null {
  if (a == null || b == null) return null;
  if (f === "pos" && (!a || !b)) return null;
  const d = a - b;
  const flat = { text: "no change", tone: "flat" as Tone };
  if (f === "num") {
    if (!b) return a ? { text: "new", tone: "good" } : flat;
    const p = (d / b) * 100;
    if (Math.abs(p) < 0.05) return flat;
    return { text: `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`, tone: (lowerBetter ? p < 0 : p > 0) ? "good" : "bad" };
  }
  if (f === "pct") {
    const pts = d * 100;
    if (Math.abs(pts) < 0.005) return flat;
    return { text: `${pts > 0 ? "+" : "−"}${Math.abs(pts).toFixed(2)} pts`, tone: (lowerBetter ? pts < 0 : pts > 0) ? "good" : "bad" };
  }
  if (f === "pos") {
    if (Math.abs(d) < 0.05) return flat;
    return { text: `${Math.abs(d).toFixed(1)} ${d < 0 ? "better" : "worse"}`, tone: d < 0 ? "good" : "bad" };
  }
  if (Math.abs(d) < 0.5) return flat;
  return { text: `${d > 0 ? "+" : "−"}${duration(Math.abs(d))}`, tone: d > 0 ? "good" : "bad" };
}

function Badge({ c }: { c: { text: string; tone: Tone } }) {
  const t = TONE[c.tone];
  const arrow = c.tone === "flat" ? "" : c.text.startsWith("−") || c.text.endsWith("worse") ? "▼ " : "▲ ";
  return (
    <span style={{ display: "inline-block", background: t.bg, color: t.fg, fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 999 }}>
      {arrow}{c.text}
    </span>
  );
}

function Swatches({ names, hasB }: { names: Names; hasB: boolean }) {
  const sw = (c: string, t: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <i style={{ width: 14, height: 10, background: c, borderRadius: 2, display: "inline-block" }} />
      {t}
    </span>
  );
  return (
    <div style={{ display: "flex", gap: 16, fontSize: 12, color: MUTED, marginTop: 6, flexWrap: "wrap" }}>
      {sw(A_COLOR, names.a)}
      {hasB && sw(B_COLOR, names.b)}
    </div>
  );
}

/* ---------------- Executive cards and headlines ---------------- */

type Card = { label: string; a: number | null | undefined; b: number | null | undefined; f: Fmt; lowerBetter?: boolean; ok?: boolean; note?: string };

function ExecCards({ items, names, hasB }: { items: Card[]; names: Names; hasB: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12 }}>
      {items.map((k) => {
        const c = k.ok === false ? null : change(k.a, k.b, k.f, k.lowerBetter);
        return (
          <div key={k.label} className="panel" style={{ margin: 0, padding: "12px 14px", breakInside: "avoid" }}>
            <div style={{ fontSize: 13, color: MUTED }}>{k.label}</div>
            <div
              title={k.a == null ? "" : fmt(k.a, k.f)}
              style={{ fontSize: 26, fontWeight: 600, color: INK, lineHeight: 1.25, margin: "4px 0 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              {k.a == null ? <span style={{ fontSize: 16, fontWeight: 500, color: "#80868b" }}>Not saved</span> : short(k.a, k.f)}
            </div>
            {c && <Badge c={c} />}
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }} title={k.b == null ? "" : fmt(k.b, k.f)}>
              {hasB ? (k.b == null ? `${names.b}: not saved` : `${names.b}: ${short(k.b, k.f)}`) : "Choose period B to compare"}
            </div>
            {k.note && <div style={{ fontSize: 12, color: "#80868b", marginTop: 2 }}>{k.note}</div>}
          </div>
        );
      })}
    </div>
  );
}

const full = (g: Group | null, k: keyof Coverage) => !!g && g.has[k] >= g.months.length;
const covNote = (g: Group | null, k: keyof Coverage, name: string) =>
  g && g.has[k] < g.months.length ? `${name}: ${g.has[k]} of ${g.months.length} months saved` : "";
const cov = (A: Group | null, B: Group | null, k: keyof Coverage, names: Names, extra = "") =>
  [extra, covNote(A, k, names.a), covNote(B, k, names.b)].filter(Boolean).join(" · ") || undefined;

function headlines(A: Group | null, B: Group | null, names: Names): { text: string; tone: Tone }[] {
  if (!A || !B) return [];
  const out: { text: string; tone: Tone }[] = [];
  const add = (what: string, a: number | null | undefined, b: number | null | undefined, f: Fmt, ok = true) => {
    if (!ok || a == null || b == null) return;
    const c = change(a, b, f);
    if (!c) return;
    let text: string;
    if (c.tone === "flat") text = `${what} held steady: ${short(a, f)} vs ${short(b, f)}.`;
    else if (f === "pos") text = `${what} ${c.tone === "good" ? "improved" : "slipped"} by ${Math.abs(a - b).toFixed(1)} places: ${fmt(a, f)} vs ${fmt(b, f)} (lower is better).`;
    else text = `${what} ${a > b ? "rose" : "fell"} ${c.text.replace(/^[+−]/, "")}: ${short(a, f)} vs ${short(b, f)}.`;
    out.push({ text, tone: c.tone });
  };
  add("Google Search clicks", A.search?.clicks, B.search?.clicks, "num");
  add("Search impressions", A.search?.impressions, B.search?.impressions, "num");
  add("Average Google position", A.search?.position, B.search?.position, "pos");
  add("Website sessions (GA4)", A.ga?.sessions, B.ga?.sessions, "num", full(A, "ga") && full(B, "ga"));
  add("Organic search sessions", A.ga?.organicSessions, B.ga?.organicSessions, "num", full(A, "ga") && full(B, "ga"));
  add("AI Overview impressions", A.ai, B.ai, "num", full(A, "ai") && full(B, "ai"));
  add("Visits from AI assistants", A.aiVisits, B.aiVisits, "num");
  add("Indexed pages", A.indexed, B.indexed, "num");
  if (A.ai != null && !(full(A, "ai") && full(B, "ai"))) {
    out.push({ text: `AI Overview impressions: ${short(A.ai, "num")} in ${names.a}; not saved for every month, so not compared.`, tone: "flat" });
  }
  if (!A.ga && !B.ga) out.push({ text: "GA4 traffic isn't in the saved history yet, so it can't be compared.", tone: "flat" });
  return out.slice(0, 8);
}

/** Headlines about Google core updates that fell in only one of the two periods. */
function updateHeadlines(updates: GoogleUpdate[], sel: Sel, names: Names): { text: string; tone: Tone }[] {
  const inA = updatesInMonths(updates, sel.a).filter((u) => u.kind === "core");
  const inB = updatesInMonths(updates, sel.b).filter((u) => u.kind === "core");
  const out: { text: string; tone: Tone }[] = [];
  for (const u of inA) {
    if (!inB.some((x) => x.id === u.id)) out.push({ text: `Google's ${u.name} rolled out during ${names.a} (from ${fmtDay(u.start)}), so part of the change may come from it.`, tone: "flat" });
  }
  for (const u of inB) {
    if (sel.b.length && !inA.some((x) => x.id === u.id)) out.push({ text: `Google's ${u.name} rolled out during ${names.b} (from ${fmtDay(u.start)}), the period being compared with.`, tone: "flat" });
  }
  return out.slice(0, 2);
}

/* ---------------- Charts ---------------- */

const monthTitle = (p: MonthPoint) =>
  `${mName(p.month)}${p.trimmedTo ? ` (1–${Number(p.trimmedTo.slice(8))})` : p.partial && p.through ? ` (to ${Number(p.through.slice(8))} ${MON[mi(p.month)]})` : ""}`;

function pairLabel(a?: MonthPoint, b?: MonthPoint) {
  const star = (p?: MonthPoint) => (p?.partial ? "*" : "");
  if (a && b) {
    return MON[mi(a.month)] === MON[mi(b.month)]
      ? `${MON[mi(a.month)]}${star(a) || star(b)}`
      : `${MON[mi(a.month)]} ${yy(a.month)} / ${MON[mi(b.month)]} ${yy(b.month)}`;
  }
  const p = (a || b)!;
  return `${MON[mi(p.month)]} ${yy(p.month)}${star(p)}`;
}

/** The strongest Google update in either month of a pair: "core", "spam", "other" or "". */
function pairMark(updates: GoogleUpdate[], a?: MonthPoint, b?: MonthPoint): "" | GoogleUpdate["kind"] {
  const kinds = new Set<string>();
  for (const p of [a, b]) if (p) for (const u of updatesInMonths(updates, [p.month])) kinds.add(u.kind);
  return kinds.has("core") ? "core" : kinds.has("spam") ? "spam" : kinds.size ? "other" : "";
}

type PairDatum = { label: string; A: number | null; B: number | null; aT: string; bT: string; mark: "" | GoogleUpdate["kind"]; marks: string };

function PairTip({ active, payload, f }: { active?: boolean; payload?: { payload: PairDatum }[]; f: Fmt }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const line = (c: string, t: string, v: number | null) =>
    t ? (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <i style={{ width: 10, height: 10, background: c, borderRadius: 2, display: "inline-block" }} />
        <span>{t}</span>
        <b style={{ marginLeft: "auto" }}>{v == null ? "not saved" : fmt(v, f)}</b>
      </div>
    ) : null;
  return (
    <div style={{ background: "#fff", border: "1px solid #dadce0", borderRadius: 8, padding: "8px 10px", fontSize: 13, minWidth: 200 }}>
      {line(A_COLOR, d.aT, d.A)}
      {line(B_COLOR, d.bT, d.B)}
      {d.marks && <div style={{ marginTop: 4, color: d.mark ? UPDATE_COLOR[d.mark] : MUTED, fontSize: 12 }}>◆ {d.marks}</div>}
    </div>
  );
}

/** X-axis label with a "◆ core update" tag under months that had a Google update. */
function PairTick(props: { x?: number; y?: number; payload?: { value: string; index: number }; data: PairDatum[] }) {
  const { x = 0, y = 0, payload, data } = props;
  const d = payload ? data[payload.index] : undefined;
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={12} textAnchor="middle" fontSize={12} fill={MUTED}>{payload?.value}</text>
      {d?.mark && (
        <text dy={26} textAnchor="middle" fontSize={10} fill={UPDATE_COLOR[d.mark]}>
          ◆ {d.mark === "core" ? "core update" : d.mark === "spam" ? "spam update" : "update"}
        </text>
      )}
    </g>
  );
}

/** A vs B month by month: the 1st month of A next to the 1st month of B, and so on. */
function PairChart({
  title, A, B, get, f, names, note,
}: { title: string; A: Group | null; B: Group | null; get: (p: MonthPoint) => number | null; f: Fmt; names: Names; note?: string }) {
  const updates = useContext(UpdatesCtx);
  const am = A?.monthly || [];
  const bm = B?.monthly || [];
  const n = Math.max(am.length, bm.length);
  const data: PairDatum[] = Array.from({ length: n }, (_, i) => {
    const names2 = [...new Set([am[i], bm[i]].filter((p): p is MonthPoint => !!p).flatMap((p) => updatesInMonths(updates, [p.month]).map((u) => u.name)))];
    return {
      label: pairLabel(am[i], bm[i]),
      A: am[i] ? get(am[i]) : null,
      B: bm[i] ? get(bm[i]) : null,
      aT: am[i] ? monthTitle(am[i]) : "",
      bT: bm[i] ? monthTitle(bm[i]) : "",
      mark: pairMark(updates, am[i], bm[i]),
      marks: names2.join(", "),
    };
  });
  const any = data.some((d) => d.A != null || d.B != null);
  const anyMark = data.some((d) => d.mark);
  const labels = n <= 8;
  const lbl = (v: unknown) => (v == null ? "" : short(Number(v), f));
  return (
    <div className="panel" style={{ margin: 0, breakInside: "avoid" }}>
      <PanelTitle>{title}</PanelTitle>
      {!any ? (
        <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "#80868b", background: "#f8f9fa", borderRadius: 8 }}>
          Not saved for these months
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={anyMark ? 254 : 240}>
          <BarChart data={data} margin={{ top: 22, right: 8, left: 0, bottom: 0 }} barGap={3}>
            <CartesianGrid stroke="#eef1f4" vertical={false} />
            <XAxis dataKey="label" interval={0} height={anyMark ? 44 : 30} tick={(p: any) => <PairTick {...p} data={data} />} />
            <YAxis tick={axis} width={52} tickFormatter={(v) => tickFmt(Number(v), f)} />
            <Tooltip cursor={{ fill: "rgba(0,0,0,0.04)" }} content={<PairTip f={f} />} />
            <Bar dataKey="A" fill={A_COLOR} radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={false}>
              {labels && <LabelList dataKey="A" position="top" formatter={lbl} style={{ fontSize: 11, fill: INK }} />}
            </Bar>
            {B && (
              <Bar dataKey="B" fill={B_COLOR} radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={false}>
                {labels && <LabelList dataKey="B" position="top" formatter={lbl} style={{ fontSize: 11, fill: INK }} />}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      )}
      <Swatches names={names} hasB={!!B} />
      {note && <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>{note}</p>}
    </div>
  );
}

type DKey = Exclude<keyof DailyPoint, "date">;
type DRow = { x: number; tick: string; label: string; aDate: string; bDate: string; A: number | null; B: number | null };

/** Both periods day by day on real dates: day 1 of each month lines up, with a break between months that aren't next to each other. */
function alignDaily(A: Group | null, B: Group | null, k: DKey): DRow[] {
  const am = A?.months || [];
  const bm = B?.months || [];
  const n = Math.max(am.length, bm.length);
  const amap = new Map((A?.daily || []).map((p) => [p.date, p]));
  const bmap = new Map((B?.daily || []).map((p) => [p.date, p]));
  const rows: DRow[] = [];
  for (let i = 0; i < n; i++) {
    const ma = am[i], mb = bm[i];
    const len = Math.max(ma ? daysIn(ma) : 0, mb ? daysIn(mb) : 0);
    for (let d = 1; d <= len; d++) {
      const dd = String(d).padStart(2, "0");
      const okA = !!ma && d <= daysIn(ma);
      const okB = !!mb && d <= daysIn(mb);
      const aDate = okA ? `${ma}-${dd}` : "";
      const bDate = okB ? `${mb}-${dd}` : "";
      const pa = aDate ? amap.get(aDate) : undefined;
      const pb = bDate ? bmap.get(bDate) : undefined;
      const m0 = (ma || mb)!;
      rows.push({
        x: rows.length,
        tick: d === 1 ? `${MON[mi(m0)]} ${yy(m0)}` : "",
        label: [okA ? `${d} ${mName(ma!)}` : "", okB ? `${d} ${mName(mb!)}` : ""].filter(Boolean).join(" vs "),
        aDate,
        bDate,
        A: pa ? pa[k] ?? null : null,
        B: pb ? pb[k] ?? null : null,
      });
    }
    const jumpA = !!ma && !!am[i + 1] && shift(ma, 1) !== am[i + 1];
    const jumpB = !!mb && !!bm[i + 1] && shift(mb, 1) !== bm[i + 1];
    if (i < n - 1 && (jumpA || jumpB)) rows.push({ x: rows.length, tick: "", label: "", aDate: "", bDate: "", A: null, B: null });
  }
  return rows;
}

/** Index ranges of the rows whose date (for one period) falls inside an update. */
function segments(rows: DRow[], key: "aDate" | "bDate", u: GoogleUpdate, today: string): [number, number][] {
  const end = u.end || today;
  const out: [number, number][] = [];
  let s = -1;
  rows.forEach((r, i) => {
    const d = r[key];
    const inside = !!d && d >= u.start && d <= end;
    if (inside && s < 0) s = i;
    if (!inside && s >= 0) {
      out.push([s, i - 1]);
      s = -1;
    }
  });
  if (s >= 0) out.push([s, rows.length - 1]);
  return out;
}

function DailyChart({ title, A, B, k, f, names, note }: { title: string; A: Group | null; B: Group | null; k: DKey; f: Fmt; names: Names; note?: string }) {
  const updates = useContext(UpdatesCtx);
  const rows = useMemo(() => alignDaily(A, B, k), [A, B, k]);
  const ticks = rows.filter((r) => r.tick).map((r) => r.x);
  const any = rows.some((r) => r.A != null || r.B != null);
  const today = todayStr();
  const bands = (key: "aDate" | "bDate", opacity: number, suffix: string) =>
    updates.flatMap((u) =>
      segments(rows, key, u, today).map(([s, e], j) => (
        <ReferenceArea
          key={`${key}-${u.id}-${j}`}
          x1={s}
          x2={Math.max(e, s + 0.9)}
          fill={UPDATE_COLOR[u.kind]}
          fillOpacity={opacity}
          stroke="none"
          ifOverflow="visible"
          label={j === 0 ? { value: `${shortUpdateName(u)}${suffix}`, position: key === "aDate" ? "insideTopLeft" : "insideBottomLeft", fontSize: 10, fill: UPDATE_COLOR[u.kind] } : undefined}
        />
      ))
    );
  return (
    <div className="panel" style={{ margin: 0, breakInside: "avoid" }}>
      <PanelTitle>{title}</PanelTitle>
      {!any ? (
        <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "#80868b", background: "#f8f9fa", borderRadius: 8 }}>
          Not saved for these months
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#eef1f4" vertical={false} />
            <XAxis dataKey="x" type="number" domain={[0, Math.max(0, rows.length - 1)]} ticks={ticks} tickFormatter={(x) => rows[Number(x)]?.tick || ""} tick={axis} allowDecimals={false} />
            <YAxis tick={axis} width={52} tickFormatter={(v) => tickFmt(Number(v), f)} />
            <Tooltip labelFormatter={(x) => rows[Number(x)]?.label || ""} formatter={(v) => fmt(Number(v), f)} />
            {bands("aDate", 0.12, "")}
            {B && bands("bDate", 0.06, ` (${names.b})`)}
            <Line dataKey="A" name={names.a} stroke={A_COLOR} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            {B && <Line dataKey="B" name={names.b} stroke={B_COLOR} strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} isAnimationActive={false} />}
          </LineChart>
        </ResponsiveContainer>
      )}
      <Swatches names={names} hasB={!!B} />
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
        {note || "Day 1 of each month lines up with day 1 of the month it's compared with. Gaps mark months that aren't next to each other."}
        {" "}Shaded bands are Google updates (purple = core, red = spam).
      </p>
    </div>
  );
}

/* ---------------- Full history (every saved month) ---------------- */

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

function MonthChart({ timeline, sel, defs, title, names }: { timeline: MonthRow[]; sel: Sel; defs: MDef[]; title: string; names: Names }) {
  const [id, setId] = useState(defs[0].id);
  const d = defs.find((x) => x.id === id) || defs[0];
  const data = timeline
    .map((t) => ({ month: t.month, name: `${MON[mi(t.month)]} ${yy(t.month)}${t.partial ? "*" : ""}`, v: d.get(t), g: sel.a.includes(t.month) ? "A" : sel.b.includes(t.month) ? "B" : "" }))
    .filter((x) => x.v != null);
  return (
    <div className="panel" style={{ marginTop: 16, breakInside: "avoid" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>{title}</PanelTitle>
        {defs.length > 1 && (
          <select value={d.id} onChange={(e) => setId(e.target.value)} aria-label="Metric" className="cmp-noprint">
            {defs.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        )}
      </div>
      {!data.length ? (
        <p className="muted">Nothing saved for this yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#eef1f4" vertical={false} />
            <XAxis dataKey="name" tick={axis} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tick={axis} width={52} tickFormatter={(v) => tickFmt(Number(v), d.f)} />
            <Tooltip formatter={(v) => fmt(Number(v), d.f)} />
            <Bar dataKey="v" name={d.label} isAnimationActive={false}>
              {data.map((x) => <Cell key={x.month} fill={x.g === "A" ? A_COLOR : x.g === "B" ? B_COLOR : OFF} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
        Every saved month, shown as {d.label.toLowerCase()}. <span style={{ color: A_COLOR, fontWeight: 600 }}>Blue = {names.a}</span>
        {sel.b.length ? <>, <span style={{ color: B_COLOR, fontWeight: 600 }}>orange = {names.b}</span></> : null}, grey = not selected. * = part of the month.
      </p>
    </div>
  );
}

/* ---------------- Comparison tables ---------------- */

type MRow = { name: string; a: number; b: number; aHas: boolean; bHas: boolean; change: number; pctChange: number; status: string };
type TMetric<T> = { key: keyof T; label: string; f: Fmt; lowerBetter?: boolean };
type SearchItem = Group["pages"][number];
type GaItem = Group["channels"][number];

function ChangeCell({ r, f, lowerBetter }: { r: MRow; f: Fmt; lowerBetter?: boolean }) {
  if (!r.aHas || !r.bHas) return <span className="muted">{r.aHas ? "new" : "gone"}</span>;
  const c = change(r.a, r.b, f, lowerBetter);
  return c ? <Badge c={c} /> : <span className="muted">–</span>;
}

function CompareTable<T extends { name: string }>({
  title, a, b, metrics, csv, note, names,
}: { title: string; a: T[]; b: T[]; metrics: TMetric<T>[]; csv: string; note?: string; names: Names }) {
  const [mIdx, setMIdx] = useState(0);
  const [filter, setFilter] = useState("all");
  const m = metrics[Math.min(mIdx, metrics.length - 1)];
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
        status: !bHas ? "New" : !aHas ? "Gone" : better ? "Better" : worse ? "Worse" : "Same",
      };
    });
  }, [a, b, m]);
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);
  const cols: Col<MRow>[] = [
    { key: "name", label: "Name", render: (r) => nameCell(r.name) },
    { key: "a", label: `${m.label}, ${names.a}`, num: true, render: (r) => (r.aHas ? fmt(r.a, m.f) : "–") },
    { key: "b", label: `${m.label}, ${names.b}`, num: true, render: (r) => (r.bHas ? fmt(r.b, m.f) : "–") },
    { key: "change", label: "Change", num: true, render: (r) => <ChangeCell r={r} f={m.f} lowerBetter={m.lowerBetter} /> },
    { key: "status", label: "" },
  ];
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <PanelTitle>{title}</PanelTitle>
        <div className="row cmp-noprint" style={{ gap: 8 }}>
          {metrics.length > 1 && (
            <select value={mIdx} onChange={(e) => setMIdx(Number(e.target.value))} aria-label="Compare by">
              {metrics.map((x, i) => <option key={String(x.key)} value={i}>{x.label}</option>)}
            </select>
          )}
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">
            <option value="all">All ({rows.length})</option>
            {["Better", "Worse", "New", "Gone"].map((x) => (
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
        csvRow={(r) => ({ name: r.name, [`${m.label} ${names.a}`]: r.aHas ? r.a : "", [`${m.label} ${names.b}`]: r.bHas ? r.b : "", change: r.aHas && r.bHas ? r.a - r.b : "", status: r.status })}
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

function Assistants({ A, B, names }: { A: Group | null; B: Group | null; names: Names }) {
  const am = new Map((A?.assistants || []).map((x) => [x.name, x.sessions]));
  const bm = new Map((B?.assistants || []).map((x) => [x.name, x.sessions]));
  const list = [...new Set([...am.keys(), ...bm.keys()])].sort((x, y) => (am.get(y) || 0) - (am.get(x) || 0));
  return (
    <div className="panel" style={{ margin: 0, breakInside: "avoid" }}>
      <PanelTitle>Visits by AI assistant</PanelTitle>
      {!list.length ? (
        <p className="muted">{A?.aiVisits == null ? "GA4 couldn't be read for these months." : "No visits from AI assistants in these months."}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Assistant</th>
                <th className="num" style={{ color: A_COLOR }}>{names.a}</th>
                {B && <th className="num" style={{ color: B_COLOR }}>{names.b}</th>}
                {B && <th className="num">Change</th>}
              </tr>
            </thead>
            <tbody>
              {list.map((name) => {
                const a = am.get(name) ?? 0, b = bm.get(name) ?? 0;
                const c = change(a, b, "num");
                return (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="num">{num(a)}</td>
                    {B && <td className="num">{num(b)}</td>}
                    {B && <td className="num">{c ? <Badge c={c} /> : "–"}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>GA4 sessions whose source is an AI assistant (ChatGPT, Perplexity, Gemini, Copilot, Claude and others), read live from GA4.</p>
    </div>
  );
}

/* ---------------- Month picker: Period A on the left, Period B on the right ---------------- */

/** One side of the picker. Clicking a month here adds it to (or removes it from) this side only. */
function MonthPanel({
  side, byMonth, years, sel, setSel, extra,
}: {
  side: Side; byMonth: Map<string, MonthRow>; years: number[]; sel: Sel; setSel: (f: (s: Sel) => Sel) => void; extra?: ReactNode;
}) {
  const color = side === "a" ? A_COLOR : B_COLOR;
  const tint = side === "a" ? A_TINT : B_TINT;
  const other: Side = side === "a" ? "b" : "a";
  const otherColor = other === "a" ? A_COLOR : B_COLOR;
  const mine = sel[side];
  const theirs = sel[other];
  const saved = (m: string) => {
    const t = byMonth.get(m);
    return !!t && !!(t.search || t.ga);
  };
  const pickable = (y: number) => MON.map((_, i) => monthId(y, i)).filter((m) => saved(m) && !theirs.includes(m));
  const setMine = (list: string[]) => setSel((s) => (side === "a" ? { a: list, b: s.b } : { a: s.a, b: list }));
  const toggle = (m: string) => setMine(flip(mine, m));
  const toggleYear = (y: number) => {
    const ms = pickable(y);
    const all = ms.length > 0 && ms.every((m) => mine.includes(m));
    setMine(all ? mine.filter((m) => !ms.includes(m)) : [...new Set([...mine, ...ms])].sort());
  };

  return (
    <div style={{ flex: "1 1 340px", minWidth: 0, border: `2px solid ${color}`, borderRadius: 12, overflow: "hidden", background: "#fff" }}>
      <div style={{ background: tint, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color, letterSpacing: 0.4 }}>
            {side === "a" ? "PERIOD A · WHAT YOU WANT TO SEE" : "PERIOD B · COMPARE WITH"}
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: INK, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {mine.length ? periodName(mine) : <span style={{ color: "#80868b", fontWeight: 500, fontSize: 15 }}>Click months below</span>}
          </div>
        </div>
        {mine.length > 0 && (
          <button type="button" className="btn small" onClick={() => setMine([])}>
            Clear
          </button>
        )}
      </div>

      <div style={{ padding: "4px 14px 14px" }}>
        {extra}
        {years.map((y) => {
          const ms = pickable(y);
          const all = ms.length > 0 && ms.every((m) => mine.includes(m));
          return (
            <div key={y} style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <b style={{ fontSize: 14, color: INK }}>{y}</b>
                <button type="button" className="btn small" onClick={() => toggleYear(y)} disabled={!ms.length}>
                  {all ? "Remove whole year" : "Whole year"}
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 6 }}>
                {MON.map((mn, i) => {
                  const m = monthId(y, i);
                  const t = byMonth.get(m);
                  const ok = saved(m);
                  const inMine = mine.includes(m);
                  const inOther = theirs.includes(m);
                  const disabled = !ok || inOther;
                  const tip = !ok
                    ? `${mName(m)}: nothing saved`
                    : inOther
                      ? `${mName(m)} is already in Period ${other.toUpperCase()}`
                      : `${mName(m)}${t!.partial ? ` (saved ${t!.from} to ${t!.through})` : ""}${t!.onlyHere ? " · only in your saved history" : ""}`;
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggle(m)}
                      title={tip}
                      aria-pressed={inMine}
                      aria-label={`${mName(m)}${inMine ? ", selected" : ""}`}
                      style={{
                        padding: "8px 0",
                        borderRadius: 8,
                        fontSize: 14,
                        border: `1px solid ${inMine ? color : inOther ? otherColor : ok ? "#cfd6de" : "#e3e6ea"}`,
                        background: inMine ? color : ok ? "#fff" : "#f2f4f7",
                        color: inMine ? "#fff" : inOther ? otherColor : ok ? INK : "#b0b6bd",
                        fontWeight: inMine ? 600 : 400,
                        cursor: disabled ? "default" : "pointer",
                        opacity: inOther ? 0.55 : 1,
                        textDecoration: inOther ? "line-through" : undefined,
                        boxShadow: ok && t?.onlyHere && !inMine ? "inset 0 -3px 0 #7b1fa2" : undefined,
                      }}
                    >
                      {mn}
                      {t?.partial ? "*" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Picker({ timeline, sel, setSel }: { timeline: MonthRow[]; sel: Sel; setSel: (f: (s: Sel) => Sel) => void }) {
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
    { name: "Last month vs month before", a: [lc], b: [shift(lc, -1)] },
    { name: "Last month vs a year ago", a: [lc], b: [shift(lc, -12)] },
    { name: "Last 3 months vs a year ago", a: range(shift(lc, -2), lc), b: range(shift(lc, -14), shift(lc, -12)) },
    { name: "Last 3 months vs 3 before", a: range(shift(lc, -2), lc), b: range(shift(lc, -5), shift(lc, -3)) },
    { name: "Last 6 months vs 6 before", a: range(shift(lc, -5), lc), b: range(shift(lc, -11), shift(lc, -6)) },
    { name: `${year} so far vs ${Number(year) - 1}`, a: range(`${year}-01`, latest), b: range(`${Number(year) - 1}-01`, shift(latest, -12)) },
  ].map((p) => ({ ...p, a: p.a.filter(has), b: p.b.filter(has) }));

  const aSorted = [...sel.a].sort();
  const yearEarlier = aSorted.map((m) => shift(m, -12)).filter((m) => has(m) && !sel.a.includes(m));
  const justBefore = aSorted.length && isRun(aSorted) ? range(shift(aSorted[0], -aSorted.length), shift(aSorted[0], -1)).filter(has) : [];
  const fillB = (list: string[]) => setSel((s) => ({ a: s.a, b: list }));

  const bShortcuts = sel.a.length ? (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
      <span style={{ fontSize: 12, color: MUTED }}>Quick fill:</span>
      <button type="button" className="btn small" style={{ borderColor: B_COLOR, color: B_COLOR }} onClick={() => fillB(yearEarlier)} disabled={!yearEarlier.length}>
        Same months a year earlier{yearEarlier.length ? ` (${periodName(yearEarlier)})` : ""}
      </button>
      {isRun(aSorted) && (
        <button type="button" className="btn small" style={{ borderColor: B_COLOR, color: B_COLOR }} onClick={() => fillB(justBefore)} disabled={!justBefore.length}>
          Months just before{justBefore.length ? ` (${periodName(justBefore)})` : ""}
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="panel cmp-noprint" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: 14, color: INK, marginRight: 4 }}>Quick picks:</b>
        {presets.map((p) => {
          const ok = p.a.length > 0 && p.b.length > 0;
          return (
            <button
              key={p.name}
              type="button"
              className="btn small"
              disabled={!ok}
              title={ok ? `${periodName(p.a)} vs ${periodName(p.b)}` : "Not enough saved months yet"}
              onClick={() => setSel(() => ({ a: p.a, b: p.b }))}
            >
              {p.name}
            </button>
          );
        })}
      </div>
      <p style={{ margin: "8px 0 12px", fontSize: 13, color: MUTED }}>
        Or click months yourself: <b style={{ color: A_COLOR }}>left side</b> is what you want to see, <b style={{ color: B_COLOR }}>right side</b> is what to compare it with.
      </p>

      <div style={{ display: "flex", alignItems: "stretch", gap: 12, flexWrap: "wrap" }}>
        <MonthPanel side="a" byMonth={byMonth} years={years} sel={sel} setSel={setSel} />

        <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: "0 2px" }}>
          <div style={{ width: 2, flex: 1, minHeight: 16, background: "#dadce0" }} />
          <div style={{ width: 46, height: 46, borderRadius: "50%", background: "#f1f3f4", border: "1px solid #dadce0", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: INK }}>
            vs
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() => setSel((s) => ({ a: s.b, b: s.a }))}
            disabled={!sel.a.length && !sel.b.length}
            title="Swap the left and right sides"
          >
            ⇄ Swap
          </button>
          <button type="button" className="btn small" onClick={() => setSel(() => ({ a: [], b: [] }))} disabled={!sel.a.length && !sel.b.length}>
            Clear both
          </button>
          <div style={{ width: 2, flex: 1, minHeight: 16, background: "#dadce0" }} />
        </div>

        <MonthPanel side="b" byMonth={byMonth} years={years} sel={sel} setSel={setSel} extra={bShortcuts} />
      </div>

      <p className="muted" style={{ margin: "12px 0 0", fontSize: 12 }}>
        * = month still in progress (part of the month). Grey = nothing saved for that month. Crossed out = already on the other side.
        Purple underline = no longer in Search Console, only in your saved history.
      </p>
    </div>
  );
}

/* ---------------- Layout pieces ---------------- */

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 17, fontWeight: 600, margin: "0 0 10px", color: INK }}>{title}</h3>
      {children}
    </div>
  );
}
const Grid = ({ children }: { children: ReactNode }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16 }}>{children}</div>
);

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .cmp-print, .cmp-print * { visibility: visible !important; }
  .cmp-print { position: absolute; left: 0; top: 0; width: 100%; }
  .cmp-noprint { display: none !important; }
  .cmp-print .panel { break-inside: avoid; }
}`;

/* ---------------- The mode ---------------- */

export default function CompareMode({ site, ga4, tab, readOnly = false }: { site: string; ga4: string; tab: CompareTab; readOnly?: boolean }) {
  const [base, setBase] = useState<Resp | null>(null);
  const [res, setRes] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Sel>({ a: [], b: [] });
  const [archMsg, setArchMsg] = useState("");
  const updates = useGoogleUpdates();
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
      .catch((e) => live && setErr(friendly(e, "Couldn't load the saved months")));
    // Status of the saved history (shown when GA4 is missing).
    if (!readOnly) {
      fetch(`/api/archive?site=${encodeURIComponent(site)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => live && setArchMsg(String(j?.link?.message ?? j?.status?.link?.message ?? "")))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [site, readOnly]);

  // The comparison itself, once the selection has stopped changing.
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
        .catch((e) => live && setErr(friendly(e, "Couldn't load the comparison")))
        .finally(() => live && setLoading(false));
    }, DEBOUNCE_MS);
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
      setErr(friendly(e, "Couldn't change the GA4 property"));
    }
    setBusy(false);
  };

  const timeline = res?.timeline || base?.timeline || [];
  const A = res?.a || null;
  const B = res?.b || null;
  const hasB = !!B;
  const names: Names = { a: periodName(sel.a) || "Period A", b: periodName(sel.b) || "Period B" };
  const savedGa4 = res?.ga4 ?? base?.ga4 ?? "";
  const notes = [...new Set([...(A?.notes || []), ...(B?.notes || [])])];
  const gaMissing = !!A && !A.ga && !B?.ga;
  const usersNote = A?.ga && !A.ga.usersExact ? "sum of monthly users" : "";
  const heads = [...headlines(A, B, names), ...updateHeadlines(updates, sel, names)];

  // Google updates that fell in either period, for the box in the Summary.
  const aUpd = updatesInMonths(updates, sel.a);
  const bUpd = updatesInMonths(updates, sel.b);
  const updRows = [...new Map([...aUpd, ...bUpd].map((u) => [u.id, u])).values()]
    .sort((x, y) => x.start.localeCompare(y.start))
    .map((u) => ({
      u,
      note: `during ${[aUpd.some((x) => x.id === u.id) ? names.a : "", bUpd.some((x) => x.id === u.id) ? names.b : ""].filter(Boolean).join(" and ")}`,
    }));

  const gaNotice = gaMissing ? (
    <div className="notice" style={{ marginTop: 12 }}>
      GA4 traffic for these months isn&apos;t in the saved history yet{savedGa4 ? ` (GA4 property ${savedGa4})` : ""}, so traffic, channels and landing pages
      can&apos;t be compared. It&apos;s saved in the background while the dashboard is open; keep it open for a few minutes and reload.
      {archMsg && <> Latest status: <i>{archMsg}</i></>}
    </div>
  ) : null;

  /* Each selected month (full saved months) */
  type MonthLine = {
    month: string; period: string; clicks: number | null; impressions: number | null; ctr: number | null; position: number | null;
    users: number | null; sessions: number | null; organic: number | null; ai: number | null; crawl: number | null; flags: string;
  };
  const monthsRows: MonthLine[] = timeline
    .filter((t) => sel.a.includes(t.month) || sel.b.includes(t.month))
    .map((t) => ({
      month: t.month, period: sel.a.includes(t.month) ? "A" : "B",
      clicks: t.search?.clicks ?? null, impressions: t.search?.impressions ?? null, ctr: t.search?.ctr ?? null, position: t.search?.position || null,
      users: t.ga?.users ?? null, sessions: t.ga?.sessions ?? null, organic: t.ga?.organicSessions ?? null, ai: t.ai, crawl: t.crawl,
      flags: [
        t.partial ? `part month (${t.from} to ${t.through})` : "",
        t.onlyHere ? "only in saved history" : "",
        ...updatesInMonths(updates, [t.month]).map((u) => `◆ ${shortUpdateName(u)}`),
      ].filter(Boolean).join(" · "),
    }));
  const cell = (v: number | null, f: Fmt) => (v == null ? <span style={{ color: "#9aa0a6" }}>Not saved</span> : fmt(v, f));
  const MONTH_COLS: Col<MonthLine>[] = [
    { key: "month", label: "Month", render: (r) => mName(r.month) },
    { key: "period", label: "Period", render: (r) => <b style={{ color: r.period === "A" ? A_COLOR : B_COLOR }}>{r.period === "A" ? names.a : names.b}</b> },
    { key: "clicks", label: "Clicks", num: true, render: (r) => cell(r.clicks, "num") },
    { key: "impressions", label: "Impressions", num: true, render: (r) => cell(r.impressions, "num") },
    { key: "ctr", label: "CTR", num: true, render: (r) => cell(r.ctr, "pct") },
    { key: "position", label: "Position", num: true, render: (r) => cell(r.position, "pos") },
    { key: "users", label: "Active users", num: true, render: (r) => cell(r.users, "num") },
    { key: "sessions", label: "Sessions", num: true, render: (r) => cell(r.sessions, "num") },
    { key: "organic", label: "Organic sessions", num: true, render: (r) => cell(r.organic, "num") },
    { key: "ai", label: "AI impressions", num: true, render: (r) => cell(r.ai, "num") },
    { key: "crawl", label: "Crawl requests", num: true, render: (r) => cell(r.crawl, "num") },
    { key: "flags", label: "" },
  ];

  /* Card sets */
  const ok = (k: keyof Coverage) => full(A, k) && full(B, k);
  const searchCards: Card[] = [
    { label: "Google clicks", a: A?.search?.clicks, b: B?.search?.clicks, f: "num", ok: ok("search"), note: cov(A, B, "search", names) },
    { label: "Impressions", a: A?.search?.impressions, b: B?.search?.impressions, f: "num", ok: ok("search"), note: cov(A, B, "search", names) },
    { label: "Click-through rate", a: A?.search?.ctr, b: B?.search?.ctr, f: "pct", ok: ok("search") },
    { label: "Average position", a: A?.search?.position, b: B?.search?.position, f: "pos", lowerBetter: true, ok: ok("search"), note: "lower is better" },
  ];
  const gaCards: Card[] = [
    { label: "Active users", a: A?.ga?.users, b: B?.ga?.users, f: "num", ok: ok("ga"), note: cov(A, B, "ga", names, usersNote) },
    { label: "Sessions", a: A?.ga?.sessions, b: B?.ga?.sessions, f: "num", ok: ok("ga"), note: cov(A, B, "ga", names) },
    { label: "Organic search sessions", a: A?.ga?.organicSessions, b: B?.ga?.organicSessions, f: "num", ok: ok("ga") },
    { label: "Key events", a: A?.ga?.keyEvents, b: B?.ga?.keyEvents, f: "num", ok: ok("ga") },
  ];
  const aiCards: Card[] = [
    { label: "AI Overview impressions", a: A?.ai, b: B?.ai, f: "num", ok: ok("ai"), note: cov(A, B, "ai", names) },
    { label: "Visits from AI assistants", a: A?.aiVisits, b: B?.aiVisits, f: "num", ok: A?.aiVisits != null && B?.aiVisits != null, note: "GA4, read live" },
  ];
  const crawlCards: Card[] = [
    { label: "Crawl requests", a: A?.crawl, b: B?.crawl, f: "num", ok: ok("crawl"), note: cov(A, B, "crawl", names) },
    { label: "Indexed pages", a: A?.indexed, b: B?.indexed, f: "num", note: A?.indexedAsOf ? `${names.a}: as of ${A.indexedAsOf}` : undefined },
    { label: "Not indexed pages", a: A?.notIndexed, b: B?.notIndexed, f: "num", lowerBetter: true },
  ];

  const pTraffic = (
    <Grid>
      <PairChart title="Active users per month" A={A} B={B} get={(p) => p.ga?.users ?? null} f="num" names={names} note="GA4's own monthly user count (not added up from days)." />
      <PairChart title="Sessions per month" A={A} B={B} get={(p) => p.ga?.sessions ?? null} f="num" names={names} />
      <PairChart title="Organic search sessions per month" A={A} B={B} get={(p) => p.ga?.organicSessions ?? null} f="num" names={names} />
      <DailyChart title="Sessions per day" A={A} B={B} k="sessions" f="num" names={names} />
    </Grid>
  );
  const pSearch = (
    <Grid>
      <PairChart title="Google clicks per month" A={A} B={B} get={(p) => p.search?.clicks ?? null} f="num" names={names} />
      <PairChart title="Impressions per month" A={A} B={B} get={(p) => p.search?.impressions ?? null} f="num" names={names} />
      <DailyChart title="Google clicks per day" A={A} B={B} k="clicks" f="num" names={names} />
      <DailyChart title="Impressions per day" A={A} B={B} k="impressions" f="num" names={names} />
      <PairChart title="Click-through rate per month" A={A} B={B} get={(p) => p.search?.ctr ?? null} f="pct" names={names} />
      <PairChart title="Average position per month (lower is better)" A={A} B={B} get={(p) => p.search?.position || null} f="pos" names={names} />
    </Grid>
  );
  const pAi = (
    <Grid>
      <PairChart title="AI Overview impressions per month" A={A} B={B} get={(p) => p.ai} f="num" names={names} note="Google's AI Overviews and AI Mode, from the weekly Search Console captures." />
      <PairChart title="Visits from AI assistants per month" A={A} B={B} get={(p) => p.aiVisits} f="num" names={names} note="GA4 sessions from ChatGPT, Perplexity, Gemini, Copilot, Claude and others." />
      <Assistants A={A} B={B} names={names} />
      <DailyChart title="AI Overview impressions per day" A={A} B={B} k="ai" f="num" names={names} />
    </Grid>
  );
  const pCrawl = (
    <Grid>
      <PairChart title="Crawl requests per month" A={A} B={B} get={(p) => p.crawl} f="num" names={names} note="Googlebot requests, from the weekly Crawl stats captures (Google keeps 90 days)." />
      <PairChart title="Indexed pages at month end" A={A} B={B} get={(p) => p.indexed} f="num" names={names} note="Google's own count (All known pages) on the last saved day of each month." />
    </Grid>
  );

  const views: Record<CompareTab, ReactNode> = {
    summary: (
      <>
        {heads.length > 0 && (
          <div className="panel" style={{ breakInside: "avoid" }}>
            <PanelTitle>Headlines</PanelTitle>
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
              {heads.map((h) => (
                <li key={h.text} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 15, lineHeight: 1.7 }}>
                  <span style={{ color: TONE[h.tone].fg, fontWeight: 700, width: 14 }}>{h.tone === "good" ? "▲" : h.tone === "bad" ? "▼" : "•"}</span>
                  <span>{h.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!hasB && <div className="notice" style={{ marginTop: 12 }}>Choose months on the right side (Period B) to see the comparison. Until then, the charts show {names.a} on its own.</div>}
        <div style={{ marginTop: 16 }}>
          <ExecCards items={[...searchCards, ...gaCards, ...aiCards, ...crawlCards]} names={names} hasB={hasB} />
        </div>
        {updRows.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <UpdatesList rows={updRows} title="Google updates during these periods" />
          </div>
        )}
        <Block title="Site traffic (Google Analytics 4)">{gaNotice || pTraffic}</Block>
        <Block title="Google Search">{pSearch}</Block>
        <Block title="AI visibility">{pAi}</Block>
        <Block title="Indexing and crawling">{pCrawl}</Block>
        <MonthChart timeline={timeline} sel={sel} defs={[...SEARCH_DEFS, ...GA_DEFS, ...AI_DEFS, ...CRAWL_DEFS]} title="Where these months sit in the full history" names={names} />
        <div className="panel" style={{ marginTop: 16 }}>
          <PanelTitle>Each selected month (whole saved months)</PanelTitle>
          <DataTable rows={monthsRows} cols={MONTH_COLS} initialSort="month" pageSize={36} csvName={`months-${site.replace(/\W+/g, "-")}.csv`} empty="Choose some months above." />
        </div>
      </>
    ),
    search: (
      <>
        <ExecCards items={searchCards} names={names} hasB={hasB} />
        <div style={{ marginTop: 16 }}>{pSearch}</div>
        {updRows.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <UpdatesList rows={updRows} title="Google updates during these periods" />
          </div>
        )}
        <MonthChart timeline={timeline} sel={sel} defs={SEARCH_DEFS} title="Google Search, every saved month" names={names} />
      </>
    ),
    pages: <CompareTable title="Pages" a={A?.pages || []} b={B?.pages || []} metrics={S_METRICS} csv="compare-pages.csv" names={names} note={notes.find((x) => x.startsWith("Pages and queries"))} />,
    queries: <CompareTable title="Queries" a={A?.queries || []} b={B?.queries || []} metrics={S_METRICS} csv="compare-queries.csv" names={names} note={notes.find((x) => x.startsWith("Pages and queries"))} />,
    where: (
      <>
        <CompareTable title="Countries (Google Search)" a={A?.countries || []} b={B?.countries || []} metrics={S_METRICS} csv="compare-search-countries.csv" names={names} />
        <CompareTable title="Devices (Google Search)" a={A?.devices || []} b={B?.devices || []} metrics={S_METRICS} csv="compare-search-devices.csv" names={names} />
      </>
    ),
    traffic: (
      <>
        <ExecCards
          items={[
            ...gaCards,
            { label: "New users", a: A?.ga?.newUsers, b: B?.ga?.newUsers, f: "num", ok: ok("ga") },
            { label: "Views", a: A?.ga?.views, b: B?.ga?.views, f: "num", ok: ok("ga") },
            { label: "Engagement rate", a: A?.ga?.engagementRate, b: B?.ga?.engagementRate, f: "pct", ok: ok("ga") },
            { label: "Average session", a: A?.ga?.avgSessionSec, b: B?.ga?.avgSessionSec, f: "dur", ok: ok("ga") },
          ]}
          names={names}
          hasB={hasB}
        />
        {gaNotice || (
          <>
            <div style={{ marginTop: 16 }}>{pTraffic}</div>
            <div style={{ marginTop: 16 }}>
              <DailyChart title="Active users per day" A={A} B={B} k="users" f="num" names={names} />
            </div>
          </>
        )}
        <MonthChart timeline={timeline} sel={sel} defs={GA_DEFS} title="GA4 traffic, every saved month" names={names} />
      </>
    ),
    sources: (
      <>
        {gaNotice}
        <CompareTable title="Channels" a={A?.channels || []} b={B?.channels || []} metrics={G_METRICS} csv="compare-channels.csv" names={names} />
        <CompareTable title="Landing pages" a={A?.landing || []} b={B?.landing || []} metrics={G_METRICS} csv="compare-landing-pages.csv" names={names} note="Each month's top 1,000 landing pages by sessions, added up over the selected months." />
        <CompareTable title="Countries (GA4)" a={A?.gaCountries || []} b={B?.gaCountries || []} metrics={G_METRICS} csv="compare-ga4-countries.csv" names={names} />
        <CompareTable title="Devices (GA4)" a={A?.gaDevices || []} b={B?.gaDevices || []} metrics={G_METRICS} csv="compare-ga4-devices.csv" names={names} />
        <p className="muted">Active users per row is added up over the selected months, so one person can be counted in more than one month.</p>
      </>
    ),
    ai: (
      <>
        <ExecCards items={aiCards} names={names} hasB={hasB} />
        <div style={{ marginTop: 16 }}>{pAi}</div>
        <CompareTable
          title="Pages linked by AI"
          a={A?.aiPages?.items || []}
          b={B?.aiPages?.items || []}
          metrics={[{ key: "impressions", label: "AI impressions", f: "num" }]}
          csv="compare-ai-pages.csv"
          names={names}
          note={`Page lists come from the latest weekly capture in each period and cover its own dates (${names.a}: ${A?.aiPages ? `${A.aiPages.from} to ${A.aiPages.to}` : "none"}; ${names.b}: ${B?.aiPages ? `${B.aiPages.from} to ${B.aiPages.to}` : "none"}).`}
        />
      </>
    ),
    crawl: (
      <>
        <ExecCards items={crawlCards} names={names} hasB={hasB} />
        <div style={{ marginTop: 16 }}>{pCrawl}</div>
        <MonthChart timeline={timeline} sel={sel} defs={CRAWL_DEFS} title="Crawling and indexing, every saved month" names={names} />
      </>
    ),
  };

  const tabLabel = COMPARE_TABS.find((t) => t.id === tab)?.label || "";

  return (
    <Section
      title="Compare months"
      lede="Pick months on the left (what you want to see) and on the right (what to compare it with). Every tab then compares the two, using the history saved in your Google Sheets, including months Search Console no longer shows."
    >
      <style>{PRINT_CSS}</style>
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
          {!readOnly && savedGa4 && ga4 && savedGa4 !== ga4 && (
            <div className="notice cmp-noprint" style={{ marginBottom: 12 }}>
              GA4 history is saved for property {savedGa4}, but the top bar shows {ga4}.{" "}
              <button className="btn small" onClick={switchGa4} disabled={busy}>{busy ? "Switching…" : `Save history for ${ga4} instead`}</button>
            </div>
          )}
          {!readOnly && !savedGa4 && <div className="notice cmp-noprint" style={{ marginBottom: 12 }}>No GA4 property is linked yet. Pick one in the top bar; it links the next time this property is opened.</div>}

          <UpdatesCtx.Provider value={updates}>
            <div className="cmp-print">
              {(A || B) && (
                <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap", margin: "0 0 12px" }}>
                  <span style={{ background: A_TINT, color: "#174ea6", fontWeight: 600, padding: "6px 12px", borderRadius: 8 }}>{names.a}</span>
                  <span className="muted">compared with</span>
                  <span style={{ background: hasB ? B_TINT : "#f1f3f4", color: hasB ? "#b06000" : MUTED, fontWeight: 600, padding: "6px 12px", borderRadius: 8 }}>
                    {hasB ? names.b : "nothing yet"}
                  </span>
                  <span className="muted" style={{ marginLeft: 8 }}>{site.replace(/^sc-domain:/, "")} · {tabLabel}</span>
                  <button type="button" className="btn cmp-noprint" style={{ marginLeft: "auto" }} onClick={() => window.print()}>
                    Download PDF
                  </button>
                </div>
              )}
              {loading && <p className="muted cmp-noprint">Comparing…</p>}
              {notes.length > 0 && (
                <ul className="muted" style={{ margin: "0 0 12px", paddingLeft: 18, fontSize: 13 }}>
                  {notes.map((x) => <li key={x}>{x}</li>)}
                </ul>
              )}
              {res && (A || B) ? (
                <div style={{ opacity: loading ? 0.6 : 1 }}>{views[tab]}</div>
              ) : (
                !loading && <p className="muted">Choose months on the left and on the right above.</p>
              )}
            </div>
          </UpdatesCtx.Provider>
        </>
      )}
    </Section>
  );
}
