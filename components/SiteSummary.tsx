// components/SiteSummary.tsx
"use client";
// Overview summary: what's going well, what needs attention and suggestions, for the period picked in the top bar.
// Rules only, no AI (lib/insights.ts). Each suggestion says where to study it, downloads the rows behind it as a CSV,
// and can open that tab. Besides what the Overview already loaded, it reads /api/ga4/social (social media) and
// /api/ga4/signals (key events, AI assistants, spam referrers).
import { useEffect, useMemo, useState } from "react";
import type { GscData, Ga4Data } from "@/lib/types";
import type { Compare } from "@/lib/dates";
import { buildSummary, type IdxDays, type Move, type Pointer, type SignalsInput, type SocialInput } from "@/lib/insights";
import { downloadCsv } from "./ui";
import { FRESH, cachedFetch } from "@/lib/clientCache";

const SHOW = 5;

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const span = (r: { startDate: string; endDate: string }) => `${fmt(r.startDate)}–${fmt(r.endDate)}`;

function openStudy(m: Move) {
  if (!m.study) return;
  window.dispatchEvent(new CustomEvent("dash:open", { detail: { tab: m.study.tab, find: m.study.find } }));
}

export default function SiteSummary({
  gsc, ga, site, ga4, days, compare, idxDays,
}: {
  gsc: GscData;
  ga: Ga4Data | null;
  site: string;
  ga4: string;
  days: number;
  compare: Compare;
  idxDays: IdxDays | null;
}) {
  /** undefined while loading; null when there's no GA4 property or it couldn't be read. */
  const [social, setSocial] = useState<SocialInput | null | undefined>(undefined);
  const [signals, setSignals] = useState<SignalsInput | null | undefined>(undefined);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!ga4) {
      setSocial(null);
      setSignals(null);
      return;
    }
    let live = true;
    setSocial(undefined);
    setSignals(undefined);
    const q = `property=${ga4}&days=${days}&compare=${compare}`;
    /** Optional extras: a saved copy shows at once (lib/clientCache.ts); a failure just leaves them out. */
    const optional = <T,>(url: string, ok: (d: any) => boolean, set: (v: T | null) => void) => {
      let shown = false;
      cachedFetch<any>(url, FRESH.ga, (d) => {
        if (!live) return;
        shown = true;
        set(d && ok(d) ? (d as T) : null);
      }).catch(() => {
        if (live && !shown) set(null);
      });
    };
    optional<SocialInput>(`/api/ga4/social?${q}`, (d) => !!d.totals, setSocial);
    optional<SignalsInput>(`/api/ga4/signals?${q}`, (d) => !!d.site, setSignals);
    return () => {
      live = false;
    };
  }, [ga4, days, compare]);

  const s = useMemo(
    () => buildSummary({ site, days, gsc, ga, social: social ?? null, signals: signals ?? null, idxDays }),
    [site, days, gsc, ga, social, signals, idxDays]
  );
  const cut = <T,>(list: T[]) => (all ? list : list.slice(0, SHOW));
  const hasMore = s.good.length > SHOW || s.bad.length > SHOW || s.moves.length > SHOW;
  const loadingGa = !!ga4 && (social === undefined || signals === undefined);

  const list = (items: Pointer[], cls: string, empty: string) =>
    items.length ? (
      <ul className={`sum-list ${cls}`}>
        {cut(items).map((p) => (
          <li key={p.id}>{p.text}</li>
        ))}
      </ul>
    ) : (
      <p className="sum-empty">{empty}</p>
    );

  return (
    <section className="section">
      <div className="sum-head">
        <h2>Summary</h2>
      </div>
      <p className="status-line">
        {span(gsc.range)} vs {span(gsc.previousRange)}
        {loadingGa ? " · loading social media, AI visits and key events…" : ""}
      </p>
      {s.notes.map((n) => (
        <div key={n} className="notice" style={{ marginTop: 8 }}>{n}</div>
      ))}

      <div className="sum-grid">
        <div className="panel">
          <h3>Going well</h3>
          {list(s.good, "sum-good", "Nothing improved notably this period.")}
        </div>
        <div className="panel">
          <h3>Needs attention</h3>
          {list(s.bad, "sum-bad", "Nothing needs attention this period.")}
        </div>
      </div>

      {s.moves.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3>Suggestions</h3>
          <ul className="sum-list sum-moves">
            {cut(s.moves).map((m) => (
              <li key={m.id}>
                {m.text}
                {(m.study || m.csv) && (
                  <div className="sum-study">
                    {m.study && <span>Study: {m.study.where}</span>}
                    {m.csv && m.csv.rows.length > 0 && (
                      <button type="button" className="linkbtn" onClick={() => m.csv && downloadCsv(m.csv.name, m.csv.rows)}>
                        Download CSV ({m.csv.rows.length.toLocaleString()})
                      </button>
                    )}
                    {m.study && (
                      <button type="button" className="linkbtn" onClick={() => openStudy(m)}>Open</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasMore && (
        <button type="button" className="linkbtn" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>
          {all ? "Show fewer" : "Show all"}
        </button>
      )}
    </section>
  );
}
