// components/SiteSummary.tsx
"use client";
// Overview summary ("Vibe check"): what's going well, what needs attention and next moves, for the period picked in the
// top bar. Rules only, no AI (lib/insights.ts). Two wordings with the same numbers: Kings vibe and Classic, remembered in
// this browser. Each next move says where to study it, downloads the rows behind it as a CSV, and can open that tab.
// Besides what the Overview already loaded, it reads /api/ga4/social (social media) and /api/ga4/signals (key events,
// AI assistants, spam referrers).
import { useEffect, useMemo, useState } from "react";
import type { GscData, Ga4Data } from "@/lib/types";
import type { Compare } from "@/lib/dates";
import { buildSummary, type IdxDays, type Move, type Pointer, type SignalsInput, type SocialInput, type Tone } from "@/lib/insights";
import { downloadCsv } from "./ui";

const SHOW = 5;
const TONE_KEY = "dash:summaryTone";
const LABELS: Record<Tone, { title: string; good: string; bad: string; moves: string; noGood: string; noBad: string }> = {
  kings: {
    title: "Vibe check", good: "The W's", bad: "Lowkey concerning", moves: "Next moves",
    noGood: "Nothing popped off this period.", noBad: "All clear, no cap.",
  },
  classic: {
    title: "Summary", good: "Going well", bad: "Needs attention", moves: "Suggestions",
    noGood: "Nothing improved notably this period.", noBad: "Nothing needs attention this period.",
  },
};

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const span = (r: { startDate: string; endDate: string }) => `${fmt(r.startDate)}–${fmt(r.endDate)}`;

function openStudy(m: Move) {
  if (!m.study) return;
  window.dispatchEvent(new CustomEvent("dash:open", { detail: { tab: m.study.tab, find: m.study.find } }));
}

async function getOptional(url: string): Promise<any> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
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
  const [tone, setTone] = useState<Tone>("kings");
  const [all, setAll] = useState(false);

  useEffect(() => {
    try {
      const t = localStorage.getItem(TONE_KEY);
      if (t === "kings" || t === "classic") setTone(t);
    } catch {
      /* private mode: keep the default */
    }
  }, []);
  const pick = (t: Tone) => {
    setTone(t);
    try {
      localStorage.setItem(TONE_KEY, t);
    } catch {
      /* ignore */
    }
  };

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
    getOptional(`/api/ga4/social?${q}`).then((d) => live && setSocial(d && d.totals ? (d as SocialInput) : null));
    getOptional(`/api/ga4/signals?${q}`).then((d) => live && setSignals(d && d.site ? (d as SignalsInput) : null));
    return () => {
      live = false;
    };
  }, [ga4, days, compare]);

  const s = useMemo(
    () => buildSummary({ site, days, gsc, ga, social: social ?? null, signals: signals ?? null, idxDays }),
    [site, days, gsc, ga, social, signals, idxDays]
  );
  const L = LABELS[tone];
  const cut = <T,>(list: T[]) => (all ? list : list.slice(0, SHOW));
  const hasMore = s.good.length > SHOW || s.bad.length > SHOW || s.moves.length > SHOW;
  const loadingGa = !!ga4 && (social === undefined || signals === undefined);

  const list = (items: Pointer[], cls: string, empty: string) =>
    items.length ? (
      <ul className={`sum-list ${cls}`}>
        {cut(items).map((p) => (
          <li key={p.id}>{p.text[tone]}</li>
        ))}
      </ul>
    ) : (
      <p className="sum-empty">{empty}</p>
    );

  return (
    <section className="section">
      <div className="sum-head">
        <h2>{L.title}</h2>
        <div className="sum-tone" role="group" aria-label="Wording">
          <button type="button" aria-pressed={tone === "kings"} onClick={() => pick("kings")}>Kings vibe</button>
          <button type="button" aria-pressed={tone === "classic"} onClick={() => pick("classic")}>Classic</button>
        </div>
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
          <h3>{L.good}</h3>
          {list(s.good, "sum-good", L.noGood)}
        </div>
        <div className="panel">
          <h3>{L.bad}</h3>
          {list(s.bad, "sum-bad", L.noBad)}
        </div>
      </div>

      {s.moves.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3>
            {L.moves}
            {tone === "kings" && <span className="muted" style={{ fontWeight: 400 }}> · suggestions only</span>}
          </h3>
          <ul className="sum-list sum-moves">
            {cut(s.moves).map((m) => (
              <li key={m.id}>
                {m.text[tone]}
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
