'use client';

type Col = { key: string; label: string; fmt?: (v: any) => string };

export function BarTable({ title, rows, valueKey, cols = [], max = 15, onRowClick, active }: {
  title: string; rows: any[]; valueKey: string; cols?: Col[]; max?: number;
  onRowClick?: (r: any) => void; active?: string | null;
}) {
  const top = rows.slice(0, max);
  const peak = Math.max(1, ...top.map(r => r[valueKey]));
  return (
    <div className="bt-card">
      <div className="bt-head">
        <h3>{title}</h3>
        {cols.map(c => <span key={c.key} className="bt-col">{c.label}</span>)}
      </div>
      {top.length === 0 && <p className="bt-empty">No data for this period</p>}
      {top.map(r => (
        <div key={r.label}
             className={`bt-row ${onRowClick ? 'bt-click' : ''} ${active === r.label ? 'bt-active' : ''}`}
             onClick={() => onRowClick?.(r)}>
          <span className="bt-label" title={r.label}>{r.label}</span>
          <span className="bt-track"><span className="bt-fill" style={{ width: `${(r[valueKey] / peak) * 100}%` }} /></span>
          <span className="bt-val">{Number(r[valueKey]).toLocaleString()}</span>
          {cols.map(c => <span key={c.key} className="bt-col">{c.fmt ? c.fmt(r[c.key]) : r[c.key]}</span>)}
        </div>
      ))}
    </div>
  );
}
