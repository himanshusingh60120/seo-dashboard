"use client";
import { useMemo, useState, ReactNode } from "react";

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

export type KpiItem = { label: string; value: ReactNode; delta?: ReactNode; sub?: ReactNode };
export function Kpis({ items }: { items: KpiItem[] }) {
  return (
    <div className="kpis">
      {items.map((k) => (
        <div className="kpi" key={k.label}>
          <div className="label">{k.label}</div>
          <div className="value">{k.value}</div>
          {k.delta && <div>{k.delta}</div>}
          {k.sub && <div className="sub">{k.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export function Section({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
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
}: {
  rows: T[];
  cols: Col<T>[];
  initialSort?: keyof T & string;
  initialDesc?: boolean;
  pageSize?: number;
  csvName?: string;
  empty?: string;
}) {
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
        {csvName && (
          <button className="btn" onClick={() => downloadCsv(csvName, filtered as Record<string, unknown>[])} disabled={!filtered.length}>
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
