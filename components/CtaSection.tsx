'use client';
import { useEffect, useState } from 'react';
import { BarTable } from './BarTable';
import BotCheck from './BotCheck';
import { CTAS, CTA_REGEX } from '@/lib/cta';

function sumBy(rows: any[] = [], keys: string[], cta: string) {
  const m = new Map<string, any>();
  for (const r of rows) {
    if (cta !== 'all' && r.cta !== cta) continue;
    const label = keys.map(k => r[k] || '(not set)').join(' / ');
    const c = m.get(label) ?? { label, views: 0, users: 0 };
    c.views += r.screenPageViews;
    c.users += r.totalUsers;
    m.set(label, c);
  }
  return [...m.values()].sort((a, b) => b.views - a.views);
}

const CTA_SEARCH: Record<string, string> = {
  license: 'license-variant',
  sample: 'request-sample',
  expert: 'talk-to-expert',
  custom: 'customization',
  connect: '/connect',
};

function dateRangeLabel(days: number) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  const end = new Date();
  end.setDate(end.getDate() - 1);
  return { start: start.toLocaleDateString('en-CA'), end: end.toLocaleDateString('en-CA') };
}

function Proof({ propertyId, days }: { propertyId: string; days: number }) {
  const [copied, setCopied] = useState(false);
  const ga = `https://analytics.google.com/analytics/web/#/p${propertyId}`;
  const { start, end } = dateRangeLabel(days);

  const request = {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: CTA_REGEX } },
    },
  };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(request, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3>Verify in Google Analytics</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        This tab covers <strong>{start} → {end}</strong>, the same as GA4's "Last {days} days" (today is excluded).
        Sign in to GA4 with the same Google account and pick that range.
      </p>
      <ul className="narrative">
        <li>
          <a href={`${ga}/reports/explorer?r=all-pages-and-screens`} target="_blank" rel="noreferrer">
            Pages and screens report ↗
          </a>{' '}
          then type one of these in the search box above the table:{' '}
          {CTAS.map((c, i) => (
            <span key={c.key}>
              <code>{CTA_SEARCH[c.key]}</code>{i < CTAS.length - 1 ? ', ' : ''}
            </span>
          ))}
          . The Views total is the CTA click count. GA4's search matches the word anywhere in the URL, so if its
          number is higher, check the "not counted" list below.
        </li>
        <li>
          <a href={`${ga}/reports/explorer?r=lifecycle-traffic-acquisition-v2`} target="_blank" rel="noreferrer">
            Traffic acquisition report ↗
          </a>{' '}
          then add a filter on Page path containing the CTA, to see the channel and source breakdown.
        </li>
        <li>
          <a href={`${ga}/realtime/overview`} target="_blank" rel="noreferrer">Realtime report ↗</a>{' '}
          then click a CTA on kingsresearch.com yourself. It should appear under "Views by page title" within about a minute.
        </li>
        <li>
          <a href="https://ga-dev-tools.google/ga4/query-explorer/" target="_blank" rel="noreferrer">
            GA4 Query Explorer ↗
          </a>{' '}
          then pick property <code>{propertyId}</code> and paste the exact query this tab runs:{' '}
          <button className="btn small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy query'}</button>
        </li>
      </ul>
    </div>
  );
}

export default function CtaSection({ propertyId, days }: { propertyId: string; days: number }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [cta, setCta] = useState('all');

  useEffect(() => {
    setData(null);
    setErr('');
    fetch(`/api/ga4/cta?property=${propertyId}&days=${days}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => (j.error ? setErr(j.error) : setData(j)))
      .catch(e => setErr(String(e)));
  }, [propertyId, days]);

  const totals: Record<string, { views: number; users: number }> = data?.totals ?? {};
  const allViews = Object.values(totals).reduce((s, t) => s + t.views, 0);

  const users = { key: 'users', label: 'Users', fmt: (v: number) => v.toLocaleString() };

  return (
    <section>
      {err && <div className="notice error">Couldn't load CTA data: {err}</div>}
      {!data && !err && <p className="muted">Loading CTA data…</p>}

      {data && (
        <>
          <div className="cta-cards">
            <button className={`cta-card ${cta === 'all' ? 'on' : ''}`} onClick={() => setCta('all')}>
              <span>All CTAs</span>
              <strong>{allViews.toLocaleString()}</strong>
            </button>
            {CTAS.map(c => (
              <button key={c.key} className={`cta-card ${cta === c.key ? 'on' : ''}`} onClick={() => setCta(c.key)}>
                <span>{c.label}</span>
                <strong>{(totals[c.key]?.views ?? 0).toLocaleString()}</strong>
                <span className="muted">{(totals[c.key]?.users ?? 0).toLocaleString()} users</span>
              </button>
            ))}
          </div>

          {data.otherViews > 0 && (
            <div className="notice" style={{ marginBottom: 16 }}>
              GA4 grouped <strong>{data.otherViews.toLocaleString()}</strong> CTA views into "(other)" because the site has
              too many distinct URLs. The totals on the cards above are exact, but the breakdown tables below are missing
              those views.
            </div>
          )}

          <Proof propertyId={propertyId} days={days} />

          {data.nearMisses?.length > 0 && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h3>Pages that look like CTAs but aren't counted</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                These URLs contain a CTA word but don't match the CTA patterns. If any of them are real CTA pages,
                tell me the pattern and I'll include them.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Page path</th>
                      <th className="num">Views</th>
                      <th className="num">Users</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.nearMisses.map((r: any) => (
                      <tr key={r.path}>
                        <td className="url">{r.path}</td>
                        <td className="num">{r.views.toLocaleString()}</td>
                        <td className="num">{r.users.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="bt-grid">
            <BarTable title="By channel" rows={sumBy(data.channels, ['sessionDefaultChannelGroup'], cta)} valueKey="views" cols={[users]} />
            <BarTable title="By source / medium" rows={sumBy(data.sources, ['sessionSource', 'sessionMedium'], cta)} valueKey="views" cols={[users]} />
            <BarTable title="By country / region" rows={sumBy(data.regions, ['country', 'region'], cta)} valueKey="views" cols={[users]} />
            <BarTable title="By city" rows={sumBy(data.cities, ['city', 'country'], cta)} valueKey="views" cols={[users]} />
            <BarTable title="By report" rows={sumBy(data.pages, ['report'], cta)} valueKey="views" cols={[users]} />
            <BarTable title="Clicked from (previous page)" rows={sumBy(data.referrers, ['pageReferrer'], cta)} valueKey="views" cols={[users]} />
            <BarTable title="By device" rows={sumBy(data.devices, ['deviceCategory'], cta)} valueKey="views" cols={[users]} />
          </div>
          <p className="bt-note">
            Card totals are exact. Users in the tables are summed across pages, so a person who opened two CTAs counts twice.
          </p>
        </>
      )}

      <BotCheck propertyId={propertyId} days={days} scope="cta" />
    </section>
  );
}
