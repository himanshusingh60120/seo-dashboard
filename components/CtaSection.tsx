'use client';
import { useEffect, useMemo, useState } from 'react';
import { BarTable } from './BarTable';
import { CTAS } from '@/lib/cta';

function sumBy(rows: any[] = [], keys: string[], cta: string) {
  const m = new Map<string, any>();
  for (const r of rows) {
    if (cta !== 'all' && r.cta !== cta) continue;
    const label = keys.map(k => r[k] || '(not set)').join(' / ');
    const c = m.get(label) ?? { label, views: 0, users: 0 };
    c.views += r.screenPageViews; c.users += r.totalUsers;
    m.set(label, c);
  }
  return [...m.values()].sort((a, b) => b.views - a.views);
}

export default function CtaSection({ propertyId, days }: { propertyId: string; days: number }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [cta, setCta] = useState('all');

  useEffect(() => {
    setData(null); setErr('');
    fetch(`/api/ga4/cta?property=${propertyId}&days=${days}`)
      .then(r => r.json()).then(j => (j.error ? setErr(j.error) : setData(j)))
      .catch(e => setErr(String(e)));
  }, [propertyId, days]);

  const totals = useMemo(() => {
    const t: Record<string, number> = { all: 0 };
    for (const r of data?.pages ?? []) { t[r.cta] = (t[r.cta] ?? 0) + r.screenPageViews; t.all += r.screenPageViews; }
    return t;
  }, [data]);

  if (err) return <p className="bt-empty">Couldn't load CTA data: {err}</p>;
  if (!data) return <p className="bt-empty">Loading CTA data…</p>;

  const users = { key: 'users', label: 'Users', fmt: (v: number) => v.toLocaleString() };

  return (
    <section>
      <div className="cta-cards">
        {[{ key: 'all', label: 'All CTAs' }, ...CTAS].map(c => (
          <button key={c.key} className={`cta-card ${cta === c.key ? 'on' : ''}`} onClick={() => setCta(c.key)}>
            <span>{c.label}</span><strong>{(totals[c.key] ?? 0).toLocaleString()}</strong>
          </button>
        ))}
      </div>

      <div className="bt-grid">
        <BarTable title="By channel" rows={sumBy(data.channels, ['sessionDefaultChannelGroup'], cta)} valueKey="views" cols={[users]} />
        <BarTable title="By source / medium" rows={sumBy(data.sources, ['sessionSource', 'sessionMedium'], cta)} valueKey="views" cols={[users]} />
        <BarTable title="By country / region" rows={sumBy(data.regions, ['country', 'region'], cta)} valueKey="views" cols={[users]} />
        <BarTable title="By city" rows={sumBy(data.cities, ['city', 'country'], cta)} valueKey="views" cols={[users]} />
        <BarTable title="By report" rows={sumBy(data.pages, ['report'], cta)} valueKey="views" cols={[users]} />
        <BarTable title="Clicked from (previous page)" rows={sumBy(data.referrers, ['pageReferrer'], cta)} valueKey="views" cols={[users]} />
        <BarTable title="By device" rows={sumBy(data.devices, ['deviceCategory'], cta)} valueKey="views" cols={[users]} />
      </div>
      <p className="bt-note">Counts are views of the CTA pages. Users are summed across pages, so a person who opened two CTAs counts twice.</p>
    </section>
  );
}
