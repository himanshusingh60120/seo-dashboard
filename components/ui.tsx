// components/ui.tsx
"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import type { Source, Sources } from "@/lib/types";

/* ---------- Formatters ---------- */
export const num = (n: number | null | undefined) => (n == null ? "–" : Math.round(n).toLocaleString());
export const pct = (n: number | null | undefined, d = 1) => (n == null ? "–" : `${(n * 100).toFixed(d)}%`);
export const pos = (n: number | null | undefined) => (n == null ? "–" : n.toFixed(1));
export const compact = (n: number) =>
  Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const duration = (s: number) => `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
export const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "");

/* ---------- Delta ---------- */
export function Delta({ cur, prev, invert = false, asPoints = false }: { cur: number; prev: number; invert?: boolean; asPoints?: boolean }) {
  if (!prev && !cur) return <span className="delta flat">no change</span>;
  const diff = asPoints ? cur - prev : prev ? ((cur - prev) / prev) * 100 : 100;
  const better = invert ? diff < 0 : diff > 0;
  const cls = Math.abs(diff) < 0.05 ? "flat" : better ? "good" : "bad";
  const sign = diff > 0 ? "+" : "";
  return (
    <span className={`delta ${cls}`}>
      {sign}
      {diff.toFixed(1)}
      {asPoints ? "" : "%"} vs previous
    </span>
  );
}

export type KpiItem = { label: string; value: ReactNode; delta?: ReactNode; sub?: ReactNode; source?: string[] };
export function Kpis({ items }: { items: KpiItem[] }) {
  return (
    <div className="kpis">
      {items.map((k) => (
        <div className="kpi" key={k.label}>
          <div className="label">
            {k.label}
            {k.source && <SourceButton ids={k.source} title={k.label} compact />}
          </div>
          <div className="value">{k.value}</div>
          {k.delta && <div>{k.delta}</div>}
          {k.sub && <div className="sub">{k.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export function Section({ title, lede, children, source }: { title: string; lede?: ReactNode; children: ReactNode; source?: string[] }) {
  return (
    <section className="section">
      <h2>
        {title}
        {source && <SourceButton ids={source} title={title} />}
      </h2>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </section>
  );
}

export function SubTabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div className="subtabs" role="group">
      {options.map((o) => (
        <button key={o.id} className="subtab" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Panel heading with a Source button. */
export function PanelTitle({ children, source }: { children: ReactNode; source?: string[] }) {
  return (
    <h3 className="panel-title">
      <span>{children}</span>
      {source && <SourceButton ids={source} title={String(children)} />}
    </h3>
  );
}

/* ---------- Provenance: where a number came from ---------- */

const SourcesCtx = createContext<Sources>({});
export const SourcesProvider = ({ value, children }: { value: Sources; children: ReactNode }) => (
  <SourcesCtx.Provider value={value}>{children}</SourcesCtx.Provider>
);
export const useSources = () => useContext(SourcesCtx);

/** Resolves ids to sources, following computed figures back to the API calls they came from. */
export function resolveSources(all: Sources, ids: string[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || !all[id]) return;
    seen.add(id);
    out.push(all[id]);
    all[id].derivedFrom?.forEach(walk);
  };
  ids.forEach(walk);
  return out;
}

const when = (iso: string) => new Date(iso).toLocaleString();

function SourceDetail({ s, all }: { s: Source; all: Sources }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(s.request, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="src">
      <h4>{s.label}</h4>
      <dl>
        <dt>From</dt><dd>{s.system}</dd>
        {s.endpoint && (<><dt>API call</dt><dd><code>{s.endpoint}</code></dd></>)}
        {s.range && (<><dt>Dates covered</dt><dd>{s.range.startDate} to {s.range.endDate}</dd></>)}
        <dt>Retrieved</dt><dd>{when(s.fetchedAt)}</dd>
        {s.rowCount != null && (<><dt>Rows returned</dt><dd>{s.rowCount.toLocaleString()}</dd></>)}
        {s.formula && (<><dt>How it's calculated</dt><dd>{s.formula}</dd></>)}
        {s.derivedFrom && (<><dt>Calculated from</dt><dd>{s.derivedFrom.map((d) => all[d]?.label || d).join("; ")}</dd></>)}
      </dl>
      {(s.verifyHow || s.verifyUrl || s.explorerUrl) && (
        <div className="src-verify">
          <strong>Check it yourself</strong>
          {s.verifyHow && <p>{s.verifyHow}</p>}
          <div className="row">
            {s.verifyUrl && <a className="btn" href={s.verifyUrl} target="_blank" rel="noreferrer">{s.verifyLabel || "Open in Google"}</a>}
            {s.explorerUrl && <a className="btn" href={s.explorerUrl} target="_blank" rel="noreferrer">{s.explorerLabel || "Rerun the request"}</a>}
          </div>
        </div>
      )}
      {s.request != null && (
        <details>
          <summary>Exact request sent to Google</summary>
          <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy request"}</button>
          <pre>{JSON.stringify(s.request, null, 2)}</pre>
        </details>
      )}
      {s.response != null && (
        <details>
          <summary>{s.responseIsSample ? "First 5 rows of Google's response" : "Google's response"}</summary>
          <pre>{JSON.stringify(s.response, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function SourceButton({ ids, title, compact = false }: { ids: string[]; title: string; compact?: boolean }) {
  const all = useSources();
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const list = useMemo(() => resolveSources(all, ids), [all, ids]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!list.length) return null;
  const download = () => {
    const blob = new Blob([JSON.stringify({ figure: title, exportedAt: new Date().toISOString(), sources: list }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `source-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <button className={`src-btn${compact ? " compact" : ""}`} onClick={() => setOpen(true)} aria-label={`Where “${title}” comes from`} title="Where this number comes from">
        Source
      </button>
      {open && (
        <div className="src-overlay" onClick={() => setOpen(false)}>
          <div className="src-dialog" role="dialog" aria-modal="true" aria-label={`Source for ${title}`} onClick={(e) => e.stopPropagation()}>
            <div className="src-head">
              <div>
                <div className="muted">Source for</div>
                <h3>{title}</h3>
              </div>
              <button ref={closeRef} className="btn" onClick={() => setOpen(false)}>Close</button>
            </div>
            {list.map((s) => <SourceDetail key={s.id} s={s} all={all} />)}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={download}>Download this evidence (JSON)</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Columns added to CSV exports so every exported row carries its source. */
function sourceColumns(list: Source[]) {
  const api = list.filter((s) => s.endpoint);
  const primary = api[0] || list[0];
  if (!primary) return {};
  return {
    data_source: Array.from(new Set(api.map((s) => s.system))).join(" + ") || primary.system,
    date_range: primary.range ? `${primary.range.startDate} to ${primary.range.endDate}` : "",
    retrieved_at: primary.fetchedAt,
    api_call: api.map((s) => s.endpoint).join(" | "),
  };
}

/* ---------- CSV ---------- */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Drops nested objects so CSV cells stay readable. */
const plain = (r: Record<string, any>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v == null || typeof v !== "object"));

/* ---------- Data table: search, sort, paging, CSV ---------- */
export type Col<T> = {
  key: keyof T & string;
  label: string;
  num?: boolean;
  url?: boolean;
  render?: (row: T) => ReactNode;
};

export function DataTable<T extends Record<string, any>>({
  rows,
  cols,
  initialSort,
  initialDesc = true,
  pageSize = 25,
  csvName,
  empty = "Nothing to show for this period.",
  source,
  csvRow,
}: {
  rows: T[];
  cols: Col<T>[];
  initialSort?: keyof T & string;
  initialDesc?: boolean;
  pageSize?: number;
  csvName?: string;
  empty?: string;
  /** Provenance ids for this table: adds a Source button and source columns in the CSV. */
  source?: string[];
  /** Custom CSV row shape, for rows holding nested objects. */
  csvRow?: (row: T) => Record<string, unknown>;
}) {
  const all = useSources();
  const extra = useMemo(() => (source ? sourceColumns(resolveSources(all, source)) : {}), [all, source]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<string | undefined>(initialSort);
  const [desc, setDesc] = useState(initialDesc);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = needle
      ? rows.filter((row) => cols.some((c) => String(row[c.key] ?? "").toLowerCase().includes(needle)))
      : rows;
    if (sort) {
      r = [...r].sort((a, b) => {
        const x = a[sort], y = b[sort];
        if (x == null) return 1;
        if (y == null) return -1;
        const cmp = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
        return desc ? -cmp : cmp;
      });
    }
    return r;
  }, [rows, q, sort, desc, cols]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const p = Math.min(page, pages - 1);
  const view = filtered.slice(p * pageSize, (p + 1) * pageSize);

  const clickHeader = (k: string) => {
    if (sort === k) setDesc(!desc);
    else {
      setSort(k);
      setDesc(true);
    }
  };

  return (
    <div>
      <div className="table-tools">
        <span className="count">{filtered.length.toLocaleString()} rows</span>
        <input placeholder="Filter" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Filter rows" />
        {source && <SourceButton ids={source} title={csvName?.replace(/\.csv$/, "").replace(/-/g, " ") || "table"} />}
        {csvName && (
          <button
            className="btn"
            onClick={() => downloadCsv(csvName, filtered.map((r) => ({ ...(csvRow ? csvRow(r) : plain(r)), ...extra })))}
            disabled={!filtered.length}
          >
            Export CSV
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.num ? "num" : ""} onClick={() => clickHeader(c.key)} aria-sort={sort === c.key ? (desc ? "descending" : "ascending") : "none"}>
                  {c.label}
                  {sort === c.key ? (desc ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && (
              <tr><td colSpan={cols.length} className="muted">{empty}</td></tr>
            )}
            {view.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key} className={c.num ? "num" : c.url ? "url" : ""}>
                    {c.render ? c.render(row) : c.url ? (
                      <a href={row[c.key]} target="_blank" rel="noreferrer">{shortUrl(String(row[c.key]))}</a>
                    ) : (
                      row[c.key]
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={p === 0} onClick={() => setPage(p - 1)}>Previous</button>
          <span>Page {p + 1} of {pages}</span>
          <button className="btn" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

export function Bars({ items, color = "var(--r20)" }: { items: { label: string; value: number; note?: string }[]; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={i.label}>{i.label}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(i.value / max) * 100}%`, background: color }} /></div>
          <span className="num" style={{ textAlign: "right" }}>{i.note ?? num(i.value)}</span>
        </div>
      ))}
    </div>
  );
}
