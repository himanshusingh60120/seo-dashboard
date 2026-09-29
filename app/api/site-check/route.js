'use client';
// app/site-check/page.jsx  ->  opens at https://your-site.vercel.app/site-check

import { useRef, useState } from 'react';

const COLUMNS = ['url', 'page_status', 'redirect_to', 'noindex', 'canonical', 'google_http', 'google_result', 'error'];

const tone = (v) => {
  const s = String(v ?? '');
  if (s === '200' || s === 'found') return { color: '#15803d' };
  if (/^3/.test(s) || ['other_urls_only', 'skipped', 'unknown', 'redirected'].includes(s)) return { color: '#b45309' };
  if (/^[45]/.test(s) || ['ERR', 'invalid', 'not_found', 'blocked', 'js_required', 'error', 'yes'].includes(s)) return { color: '#b91c1c' };
  return {};
};

const googleLink = (url) =>
  `https://www.google.com/search?q=${encodeURIComponent('site:' + url.replace(/^https?:\/\//i, ''))}`;

export default function SiteCheckPage() {
  const [input, setInput] = useState('');
  const [useGoogle, setUseGoogle] = useState(true);
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notice, setNotice] = useState('');
  const stopRef = useRef(false);

  async function run() {
    const urls = [...new Set(input.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))];
    if (!urls.length) { setNotice('Paste at least one URL starting with http:// or https://'); return; }
    stopRef.current = false;
    setRunning(true);
    setRows([]);
    setNotice('');
    setProgress({ done: 0, total: urls.length });

    let google = useGoogle;
    for (let i = 0; i < urls.length && !stopRef.current; ) {
      const size = google ? 10 : 20;
      const batch = urls.slice(i, i + size);
      try {
        const res = await fetch('/api/site-check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ urls: batch, google }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setRows((prev) => [...prev, ...data.results]);
        if (data.google_blocked && google) {
          google = false;
          setNotice('Google blocked the server request, so the Google check is off for the rest of this run. Page checks continue. Use the "Google" link on any row to check it in your own browser.');
        }
      } catch (e) {
        setRows((prev) => [...prev, ...batch.map((url) => ({ url, error: `request failed: ${e.message}` }))]);
      }
      i += batch.length;
      setProgress({ done: Math.min(i, urls.length), total: urls.length });
    }
    setRunning(false);
  }

  function downloadCsv() {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const text = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `site-check-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const counts = rows.reduce((acc, r) => {
    const k = `page ${r.page_status ?? '-'}`;
    acc[k] = (acc[k] || 0) + 1;
    if (r.google_result) acc[`google ${r.google_result}`] = (acc[`google ${r.google_result}`] || 0) + 1;
    return acc;
  }, {});

  const btn = { padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 14 };

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Page status &amp; site: check</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginTop: 0 }}>
        Checks each page&apos;s own HTTP status, redirect, noindex and canonical. The optional Google site: check runs
        without an API key, but Google often blocks requests from Vercel servers; when it does, use the Google link on each row.
      </p>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste URLs, one per line"
        rows={8}
        style={{ width: '100%', padding: 10, fontFamily: 'monospace', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 6, boxSizing: 'border-box' }}
      />

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <button onClick={run} disabled={running} style={{ ...btn, background: '#111827', color: '#fff', opacity: running ? 0.6 : 1 }}>
          {running ? 'Checking…' : 'Run check'}
        </button>
        {running && <button onClick={() => { stopRef.current = true; }} style={btn}>Stop</button>}
        <button onClick={downloadCsv} disabled={!rows.length} style={{ ...btn, opacity: rows.length ? 1 : 0.5 }}>Download CSV</button>
        <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={useGoogle} onChange={(e) => setUseGoogle(e.target.checked)} disabled={running} />
          Also try Google site: check
        </label>
        {progress.total > 0 && <span style={{ fontSize: 14, color: '#6b7280' }}>{progress.done} / {progress.total}</span>}
      </div>

      {notice && (
        <p style={{ background: '#fef3c7', padding: '8px 12px', borderRadius: 6, fontSize: 14 }}>{notice}</p>
      )}

      {rows.length > 0 && (
        <>
          <p style={{ fontSize: 13, color: '#374151' }}>
            {Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ·  ')}
          </p>
          <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 6 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                  {COLUMNS.map((c) => <th key={c} style={{ padding: 8, whiteSpace: 'nowrap' }}>{c}</th>)}
                  <th style={{ padding: 8 }}>open</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                    {COLUMNS.map((c) => (
                      <td key={c} style={{ padding: 8, maxWidth: 360, wordBreak: 'break-all', ...tone(r[c]) }}>{String(r[c] ?? '')}</td>
                    ))}
                    <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                      <a href={googleLink(r.url)} target="_blank" rel="noreferrer">Google</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
