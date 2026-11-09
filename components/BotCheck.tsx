'use client';
import { useEffect, useState } from 'react';
import { DataTable, num, pct } from './ui';

type Flag = {
  label: string;
  sessions: number;
  engRate: number;
  avgEng: number;
  level: 'Suspect bot' | 'High' | 'Medium';
  reasons: string[];
};
type PageRow = { page: string; sessions: number; engRate: number; avgEng: number; from: string };
type Box = 'all' | 'suspect' | 'likely' | 'spikes';

const PILL: Record<Flag['level'], string> = { 'Suspect bot': 'no', High: 'no', Medium: 'warn' };

function FlagTable({ title, rows, empty }: { title: string; rows: Flag[]; empty: string }) {
  return (
    <div className="panel">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Segment</th>
                <th className="num">Sessions</th>
                <th className="num">Engaged</th>
                <th className="num">Avg time / session</th>
                <th>Label</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label}>
                  <td className="url">{r.label}</td>
                  <td className="num">{r.sessions.toLocaleString()}</td>
                  <td className="num">{Math.round(r.engRate * 100)}%</td>
                  <td className="num">{r.avgEng.toFixed(2)}s</td>
                  <td><span className={`pill ${PILL[r.level]}`}>{r.level}</span></td>
                  <td className="muted">{r.reasons.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function BotCheck({ propertyId, days, scope }: { propertyId: string; days: number; scope: 'site' | 'cta' }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Box | null>(null);

  useEffect(() => {
    setData(null);
    setErr('');
    setOpen(null);
    fetch(`/api/ga4/bots?property=${propertyId}&days=${days}&scope=${scope}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => (j.error ? setErr(j.error) : setData(j)))
      .catch(e => setErr(String(e)));
  }, [propertyId, days, scope]);

  const what = scope === 'cta' ? 'CTA page' : 'site';
  const threshold = data?.threshold ?? 0.1;

  const boxes: { id: Box; label: string; value: string; sub: string; title: string; explain: string; empty: string }[] = data
    ? [
        {
          id: 'all',
          label: 'Sessions checked',
          value: data.totals.sessions.toLocaleString(),
          sub: data.window ? `${data.window.startDate} to ${data.window.endDate}` : '',
          title: 'Landing pages: all sessions checked',
          explain: 'Where every checked session started.',
          empty: 'No sessions in this period.',
        },
        {
          id: 'suspect',
          label: 'Suspect bot sessions',
          value: data.totals.suspectBotSessions.toLocaleString(),
          sub: `${(data.totals.suspectBotShare * 100).toFixed(1)}% of sessions · locations averaging under ${threshold}s`,
          title: 'Landing pages: Suspect bot sessions',
          explain: `Sessions from locations whose sessions average under ${threshold}s of engagement, the “Suspect bot sessions” count above.`,
          empty: 'No Suspect bot sessions in this period.',
        },
        {
          id: 'likely',
          label: 'Likely bot sessions',
          value: data.totals.suspiciousSessions.toLocaleString(),
          sub: `${(data.totals.suspiciousShare * 100).toFixed(1)}% of sessions · Suspect bot + High-risk locations`,
          title: 'Landing pages: Likely bot sessions',
          explain: 'Sessions from locations labelled Suspect bot or High risk, the “Likely bot sessions” count above.',
          empty: 'No Likely bot sessions in this period.',
        },
        {
          id: 'spikes',
          label: 'Spike hours',
          value: String(data.totals.spikeHours),
          sub: `typical hour: ${data.totals.typicalHour} sessions`,
          title: 'Landing pages: sessions during spike hours',
          explain: 'Sessions that started in the spike hours listed in “Traffic spikes (by hour)” below.',
          empty: 'No spike hours, so no pages to list.',
        },
      ]
    : [];
  const active = boxes.find(b => b.id === open);
  const toggle = (id: Box) => setOpen(o => (o === id ? null : id));

  return (
    <div className="section" style={{ marginTop: 28 }}>
      <h2>Bot check{scope === 'cta' ? ' (CTA pages)' : ''}</h2>
      <p className="lede">
        GA4 already removes known bots. This flags {what} traffic that still behaves like automation. Any segment whose sessions average
        under {threshold} seconds of engagement is labelled <b>Suspect bot</b>: a person can't read a page that fast. Other signs (almost no
        engagement, data-centre locations, headless-browser screen sizes, missing browser language, sudden hourly spikes) are labelled High or
        Medium risk. It's an estimate: GA4 doesn't expose IP addresses, so confirm anything serious in your server or Cloudflare logs.
        Click a box to see the pages those sessions landed on.
      </p>

      {err && <div className="notice error">Couldn't run the bot check: {err}</div>}
      {!data && !err && <p className="muted">Checking traffic patterns…</p>}

      {data && (
        <>
          <div className="kpis" style={{ marginBottom: 16 }}>
            {boxes.map(b => (
              <div
                key={b.id}
                className="kpi"
                role="button"
                tabIndex={0}
                aria-pressed={open === b.id}
                onClick={() => toggle(b.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(b.id);
                  }
                }}
                style={{
                  cursor: 'pointer',
                  outline: open === b.id ? '2px solid #4f6bd8' : undefined,
                  outlineOffset: -2,
                }}
                title="Click to list the pages behind this number"
              >
                <div className="label">{b.label}</div>
                <div className="value">{b.value}</div>
                {b.sub && <div className="sub">{b.sub}</div>}
                <div className="sub" style={{ color: '#4f6bd8' }}>{open === b.id ? 'Hide pages ▴' : 'Show pages ▾'}</div>
              </div>
            ))}
          </div>

          {active && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{active.title}</h3>
                <button className="btn" onClick={() => setOpen(null)}>Close</button>
              </div>
              <p className="muted">
                {active.explain} GA4 records the first page of each session (the landing page), so each row is a page on your site where those
                sessions started, with the locations{active.id === 'spikes' ? ' (here: hours)' : ''} that sent the most of them.
                {data.pagesCapped && ' This site has more rows than one GA4 report returns, so the smallest pages may be missing.'}
              </p>
              <DataTable<PageRow>
                key={active.id}
                rows={data.pages?.[active.id] || []}
                cols={[
                  { key: 'page', label: 'Landing page' },
                  { key: 'sessions', label: 'Sessions', num: true, render: r => num(r.sessions) },
                  { key: 'engRate', label: 'Engaged', num: true, render: r => pct(r.engRate, 0) },
                  { key: 'avgEng', label: 'Avg time / session', num: true, render: r => `${r.avgEng.toFixed(2)}s` },
                  { key: 'from', label: active.id === 'spikes' ? 'Top hours' : 'Top locations' },
                ]}
                csvRow={r => ({
                  landing_page: r.page,
                  sessions: r.sessions,
                  engaged_rate: Number((r.engRate * 100).toFixed(1)),
                  avg_engagement_seconds: Number(r.avgEng.toFixed(2)),
                  top_sources: r.from,
                })}
                initialSort="sessions"
                csvName={`bot-check-${scope}-${active.id}-pages.csv`}
                empty={active.empty}
              />
            </div>
          )}

          <div className="grid-2">
            <FlagTable title="Suspicious locations" rows={data.locations} empty="No suspicious locations found." />
            <FlagTable title="Suspicious sources" rows={data.sources} empty="No suspicious sources found." />
            <FlagTable title="Suspicious browsers / screens" rows={data.tech} empty="No headless-browser patterns found." />
            <FlagTable title="Suspicious languages" rows={data.languages} empty="No suspicious languages found." />
          </div>
          <div style={{ marginTop: 16 }}>
            <FlagTable title="Traffic spikes (by hour)" rows={data.spikes} empty="No unusual hourly spikes." />
          </div>
        </>
      )}
    </div>
  );
}
