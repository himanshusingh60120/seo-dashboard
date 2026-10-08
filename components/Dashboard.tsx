// components/Dashboard.tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import type { GscData, Ga4Data, Properties, Sources } from "@/lib/types";
import { loadIndexCache, peekIndexCache, indexScanSource } from "@/lib/indexCache";
import { downloadJson, fileSafe } from "@/lib/evidence";
import { SourcesProvider } from "./ui";
import DeindexReport from "./DeindexReport";
import Overview from "./Overview";
import Rankings from "./Rankings";
import Indexing from "./Indexing";
import Queries from "./Queries";
import QueryGrowth from "./QueryGrowth";
import { yoyAllowed, type Compare } from "@/lib/dates";
import Audience from "./Audience";
import CtaSection from "./CtaSection";
import ChannelDrilldown from "./ChannelDrilldown";

type Tab = "overview" | "rankings" | "indexing" | "deindexed" | "queries" | "growth" | "audience" | "cta";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "rankings", label: "Rankings" },
  { id: "indexing", label: "Indexing" },
  { id: "deindexed", label: "Deindexed pages" },
  { id: "queries", label: "Queries" },
  { id: "growth", label: "Query growth" },
  { id: "audience", label: "Traffic & geography" },
  { id: "cta", label: "CTAs" },
];
const REFRESH_MS = 5 * 60 * 1000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem("dash:prefs") || "{}");
  } catch {
    return {};
  }
}

export default function Dashboard() {
  const { data: session } = useSession();
  const [props, setProps] = useState<Properties | null>(null);
  const [site, setSite] = useState("");
  const [ga4, setGa4] = useState("");
  const [days, setDays] = useState(28);
  const [compare, setCompare] = useState<Compare>("previous");
  const [tab, setTab] = useState<Tab>("overview");
  const [gsc, setGsc] = useState<GscData | null>(null);
  const [ga, setGa] = useState<Ga4Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gaError, setGaError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const reqId = useRef(0);
  const [indexVersion, setIndexVersion] = useState(0);
  const bumpIndex = useCallback(() => setIndexVersion((v) => v + 1), []);

  // Every source behind the numbers on screen, so any "Source" button can explain itself
  const sources = useMemo<Sources>(() => {
    const idx = site && typeof window !== "undefined" ? indexScanSource(peekIndexCache(site)) : null;
    return { ...(gsc?.sources || {}), ...(ga?.sources || {}), ...(idx ? { [idx.id]: idx } : {}) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gsc, ga, site, indexVersion, tab]);

  // Load the saved index results for this property into memory, then refresh the sources
  useEffect(() => {
    if (site) loadIndexCache(site).then(bumpIndex);
  }, [site, bumpIndex]);

  const downloadEvidence = () => {
    downloadJson(`evidence-${fileSafe(site)}-${new Date().toISOString().slice(0, 10)}.json`, {
      about: "Every figure in the dashboard with the Google API request that produced it. Rerun any request in Google's API Explorer (Search Console) or GA4 Query Explorer to reproduce the numbers.",
      exportedAt: new Date().toISOString(),
      exportedBy: session?.user?.email,
      searchConsoleProperty: site,
      ga4Property: ga4 || null,
      periodDays: days,
      comparedWith: compare === "yoy" ? "same period last year" : "previous period",
      sources,
      data: { searchConsole: gsc ? { ...gsc, sources: undefined } : null, ga4: ga ? { ...ga, sources: undefined } : null },
    });
  };

  // Load property lists once
  useEffect(() => {
    getJson<Properties>("/api/properties")
      .then((p) => {
        setProps(p);
        const prefs = readPrefs();
        const s = p.gsc.find((x) => x.siteUrl === prefs.site)?.siteUrl || p.gsc[0]?.siteUrl || "";
        setSite(s);
        const mapped = prefs.map?.[s] ?? p.gsc.find((x) => x.siteUrl === s)?.ga4Id ?? "";
        setGa4(mapped);
        if (prefs.days) setDays(prefs.days);
        if (prefs.compare === "yoy" && yoyAllowed(prefs.days || 28)) setCompare("yoy");
      })
      .catch((e) => setError(e.message));
  }, []);

  const changeSite = (s: string) => {
    setSite(s);
    const prefs = readPrefs();
    setGa4(prefs.map?.[s] ?? props?.gsc.find((x) => x.siteUrl === s)?.ga4Id ?? "");
  };

  // Persist choices (including a manual GSC → GA4 pairing)
  useEffect(() => {
    if (!site) return;
    const prefs = readPrefs();
    localStorage.setItem("dash:prefs", JSON.stringify({ ...prefs, site, days, compare, map: { ...(prefs.map || {}), [site]: ga4 } }));
  }, [site, ga4, days, compare]);

  // Year over year needs data from a year back; Search Console keeps 16 months, so it's off for 6 months
  useEffect(() => {
    if (compare === "yoy" && !yoyAllowed(days)) setCompare("previous");
  }, [days, compare]);

  const load = useCallback(async () => {
    if (!site) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setGaError(null);
    const [g, a] = await Promise.allSettled([
      getJson<GscData>(`/api/gsc/performance?site=${encodeURIComponent(site)}&days=${days}&compare=${compare}`),
      ga4 ? getJson<Ga4Data>(`/api/ga4/overview?property=${ga4}&days=${days}&compare=${compare}`) : Promise.resolve(null),
    ]);
    if (id !== reqId.current) return; // a newer request superseded this one
    if (g.status === "fulfilled") setGsc(g.value);
    else setError(g.reason.message);
    if (a.status === "fulfilled") setGa(a.value);
    else { setGa(null); setGaError(a.reason.message); }
    setUpdated(new Date());
    setLoading(false);
  }, [site, ga4, days, compare]);

  useEffect(() => {
    setGsc(null);
    setGa(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const noGa4Notice = (
    <div className="notice">Pick a GA4 property in the top bar to see this data.</div>
  );

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            Search & traffic dashboard
            <small>{session?.user?.email}</small>
          </div>
          <label className="control">
            Search Console property
            <select value={site} onChange={(e) => changeSite(e.target.value)} disabled={!props}>
              {!props && <option>Loading…</option>}
              {props?.gsc.map((s) => (
                <option key={s.siteUrl} value={s.siteUrl}>{s.siteUrl.replace(/\/$/, "")}</option>
              ))}
            </select>
          </label>
          <label className="control">
            GA4 property
            <select value={ga4} onChange={(e) => setGa4(e.target.value)} disabled={!props}>
              <option value="">None</option>
              {props?.ga4.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.account})</option>
              ))}
            </select>
          </label>
          <label className="control">
            Period
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ minWidth: 120 }}>
              <option value={7}>Last 7 days</option>
              <option value={28}>Last 28 days</option>
              <option value={90}>Last 3 months</option>
              <option value={180}>Last 6 months</option>
            </select>
          </label>
          <label className="control">
            Compare with
            <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} style={{ minWidth: 150 }}>
              <option value="previous">Previous period</option>
              <option value="yoy" disabled={!yoyAllowed(days)}>
                Same period last year{yoyAllowed(days) ? "" : " (up to 3 months)"}
              </option>
            </select>
          </label>
          <button className="btn" onClick={load} disabled={loading || !site}>{loading ? "Refreshing…" : "Refresh"}</button>
          <button className="btn" onClick={downloadEvidence} disabled={!gsc} title="Download every number with the exact Google API request behind it">Download evidence</button>
          <button className="live btn" onClick={() => setLive(!live)} aria-pressed={live} title="Refresh automatically every 5 minutes">
            <span className={`live-dot ${live ? "" : "off"}`} /> {live ? "Auto-refresh on" : "Auto-refresh off"}
          </button>
          <button className="btn" onClick={() => signOut({ callbackUrl: "/login" })}>Sign out</button>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <SourcesProvider value={sources}>
      <main>
        {error && <div className="notice error">{error}</div>}
        {props && props.gsc.length === 0 && (
          <div className="notice">This Google account has no verified Search Console properties. Sign in with an account that has access.</div>
        )}
        {updated && (
          <p className="muted" style={{ margin: 0 }}>
            Updated {updated.toLocaleTimeString()}
            {gsc && ` · Search data ${gsc.range.startDate} to ${gsc.range.endDate}, compared with ${gsc.previousRange.startDate} to ${gsc.previousRange.endDate} (Search Console reports with a ~3 day delay)`}
            {gsc && " · Every figure has a Source button showing the Google API call behind it."}
          </p>
        )}
        {!gsc && !error && tab !== "cta" && <div className="notice">Loading data for {site || "your properties"}…</div>}

        {gsc && tab === "overview" && <Overview gsc={gsc} ga={ga} gaError={gaError} hasGa4={!!ga4} site={site} />}
        {gsc && tab === "rankings" && <Rankings gsc={gsc} />}
        {site && tab === "indexing" && <Indexing site={site} onChange={bumpIndex} />}
        {site && tab === "deindexed" && <DeindexReport site={site} onChange={bumpIndex} />}
        {gsc && tab === "queries" && <Queries gsc={gsc} />}
        {site && tab === "growth" && <QueryGrowth site={site} days={days} compare={compare} />}

        {tab === "audience" && (
          <>
            <Audience ga={ga} gaError={gaError} hasGa4={!!ga4} loading={loading} />
            <section className="section">
              <h2>Channel drill-down</h2>
              <p className="lede">
                Click a channel to see exactly where its traffic came from: source and medium, landing pages,
                countries, devices and campaigns. Rows with many sessions but almost no engagement are usually
                bots or tracking problems.
              </p>
              {ga4 ? <ChannelDrilldown key={`ch-${ga4}-${days}`} propertyId={ga4} days={days} /> : noGa4Notice}
            </section>
          </>
        )}

        {tab === "cta" && (
          <section className="section">
            <h2>CTA clicks</h2>
            <p className="lede">
              Visits to the Buy / License, Request sample, Talk to expert, Customization and Connect pages.
              Click a CTA to filter every table below to it: which channel and source the visitor came from,
              their country, region and city, which report they were interested in, and the page they clicked from.
            </p>
            {ga4 ? <CtaSection key={`cta-${ga4}-${days}`} propertyId={ga4} days={days} /> : noGa4Notice}
          </section>
        )}
      </main>
      </SourcesProvider>
    </>
  );
}
