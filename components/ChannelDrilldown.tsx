'use client';
import { useEffect, useMemo, useState } from 'react';
import { BarTable } from './BarTable';

function agg(rows: any[] = [], keys: string[], channel?: string | null) {
  const m = new Map<string, any>();
  for (const r of rows) {
    if (channel && r.sessionDefaultChannelGroup !== channel) continue;
    const label = keys.map(k => r[k] || '(not set)').join(' / ');
    const c = m.get(label) ?? { label, sessions: 0, engaged: 0, dur: 0, keyEvents: 0 };
    c.sessions += r.sessions; c.engaged += r.engagedSessions;
    c.dur += r.userEngagementDuration; c.keyEvents += r.keyEvents ?? 0;
    m.set(label, c);
  }
  return [...m.values()].map(c => ({
    ...c,
    engRate: c.sessions ? c.engaged / c.sessions : 0,
    avgEng: c.sessions ? c.dur / c.sessions : 0,
  })).sort((a, b) => b.sessions - a.sessions);
}

const VIEWS = [
  { key: 'sources', label: 'Source / medium', dims: ['sessionSource', 'sessionMedium'] },
  { key: 'landing', label: 'Landing page', dims: ['landingPage'] },
  { key: 'countries', label: 'Country', dims: ['country'] },
  { key: 'devices', label: 'Device', dims: ['deviceCategory'] },
  { key: 'campaigns', label: 'Campaign', dims: ['sessionCampaignName'] },
] as const;

const cols = [
  { key: 'engRate', label: 'Engaged', fmt: (v: number) => `${Math.round(v * 100)}%` },
  { key: 'avgEng', label: 'Avg time', fmt: (v: number) => `${Math.round(v)}s` },
  { key: 'keyEvents', label: 'Key events', fmt: (v: number) => v.toLocaleString() },
];

export default function ChannelDrilldown({ propertyId, days }: { propertyId: string; days: number }) {
  const [data, setData] = useState<any>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [view, setView] = useState<(typeof VIEWS)[number]['key']>('sources');

  useEffect(() => {
    setData(null);
    fetch(`/api/ga4/channels?property=${propertyId}&days=${days}`).then(r => r.json()).then(setData);
  }, [propertyId, days]);

  const channels = useMemo(() => agg(data?.sources, ['sessionDefaultChannelGroup']), [data]);
  const v = VIEWS.find(x => x.key === view)!;
  const detail = useMemo(() => agg(data?.[view], [...v.dims], channel), [data, view, channel]);

  if (!data) return <p className="bt-empty">Loading channels…</p>;
  if (data.error) return <p className="bt-empty">{data.error}</p>;

  return (
    <section>
      <BarTable title="Sessions by channel (click to drill down)" rows={channels} valueKey="sessions"
                cols={cols} active={channel} max={20}
                onRowClick={r => setChannel(channel === r.label ? null : r.label)} />
      <div className="dd-tabs">
        {VIEWS.map(x => (
          <button key={x.key} className={view === x.key ? 'on' : ''} onClick={() => setView(x.key)}>{x.label}</button>
        ))}
      </div>
      <BarTable title={`${channel ?? 'All channels'} → ${v.label}`} rows={detail} valueKey="sessions" cols={cols} max={25} />
      <p className="bt-note">Rows with many sessions, very low engagement and ~0s average time are usually bots or broken tracking.</p>
    </section>
  );
}
