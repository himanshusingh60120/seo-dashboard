'use client';
import { useEffect, useState } from 'react';

type Flag = {
  label: string;
  sessions: number;
  engRate: number;
  avgEng: number;
  level: 'High' | 'Medium';
  reasons: string[];
};

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
                <th className="num">Avg time</th>
                <th>Risk</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label}>
                  <td className="url">{r.label}</td>
                  <td className="num">{r.sessions.toLocaleString()}</td>
                  <td className="num">{Math.round(r.engRate * 100)}%</td>
                  <td className="num">{r.avgEng.toFixed(1)}s</td>
                  <td><span className={`pill ${r.level === 'High' ? 'no' : 'warn'}`}>{r.level}</span></td>
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

  useEffect(() => {
    setData(null);
    setErr('');
    fetch(`/api/ga4/bots?property=${propertyId}&days=${days}&scope=${scope}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => (j.error ? setErr(j.error) : setData(j)))
      .catch(e => setErr(String(e)));
  }, [propertyId, days, scope]);

  const what = scope === 'cta' ? 'CTA page' : 'site';

  return (
    <div className="section" style={{ marginTop: 28 }}>
      <h2>Bot check{scope === 'cta' ? ' (CTA pages)' : ''}</h2>
      <p className="lede">
        GA4 already removes known bots. This flags {what} traffic that still behaves like automation: almost no
        engagement, data-centre locations, headless-browser screen sizes, missing browser language and sudden
        hourly spikes. It's an estimate. GA4 doesn't expose IP addresses, so confirm anything serious in your
        server or Cloudflare logs.
      </p>

      {err && <div className="notice error">Couldn't run the bot check: {err}</div>}
      {!data && !err && <p className="muted">Checking traffic patterns…</p>}

      {data && (
        <>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="kpi">
              <div className="label">Sessions checked</div>
              <div className="value">{data.totals.sessions.toLocaleString()}</div>
            </div>
            <div className="kpi">
              <div className="label">Likely bot sessions</div>
              <div className="value">{data.totals.suspiciousSessions.toLocaleString()}</div>
              <div className="sub">high-risk locations only</div>
            </div>
            <div className="kpi">
              <div className="label">Share of traffic</div>
              <div className="value">{(data.totals.suspiciousShare * 100).toFixed(1)}%</div>
            </div>
            <div className="kpi">
              <div className="label">Spike hours</div>
              <div className="value">{data.totals.spikeHours}</div>
              <div className="sub">typical hour: {data.totals.typicalHour} sessions</div>
            </div>
          </div>

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
