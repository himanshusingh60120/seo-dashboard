"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import type { GscData, Ga4Data, Properties } from "@/lib/types";
import Overview from "./Overview";
import Rankings from "./Rankings";
import Indexing from "./Indexing";
import Queries from "./Queries";
import Audience from "./Audience";

type Tab = "overview" | "rankings" | "indexing" | "queries" | "audience";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "rankings", label: "Rankings" },
  { id: "indexing", label: "Indexing" },
  { id: "queries", label: "Queries" },
  { id: "audience", label: "Traffic & geography" },
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
  const [tab, setTab] = useState<Tab>("overview");
  const [gsc, setGsc] = useState<GscData | null>(null);
  const [ga, setGa] = useState<Ga4Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gaError, setGaError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const reqId = useRef(0);

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
    localStorage.setItem("dash:prefs", JSON.stringify({ ...prefs, site, days, map: { ...(prefs.map || {}), [site]: ga4 } }));
  }, [site, ga4, days]);

  const load = useCallback(async () => {
    if (!site) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setGaError(null);
    const [g, a] = await Promise.allSettled([
      getJson<GscData>(`/api/gsc/performance?site=${encodeURIComponent(site)}&days=${days}`),
      ga4 ? getJson<Ga4Data>(`/api/ga4/overview?property=${ga4}&days=${days}`) : Promise.resolve(null),
    ]);
    if (id !== reqId.current) return; // a newer request superseded this one
    if (g.status === "fulfilled") setGsc(g.value);
    else setError(g.reason.message);
    if (a.status === "fulfilled") setGa(a.value);
    else { setGa(null); setGaError(a.reason.message); }
    setUpdated(new Date());
    setLoading(false);
  }, [site, ga4, days]);

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
          <button className="btn" onClick={load} disabled={loading || !site}>{loading ? "Refreshing…" : "Refresh"}</button>
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

      <main>
        {error && <div className="notice error">{error}</div>}
        {props && props.gsc.length === 0 && (
          <div className="notice">This Google account has no verified Search Console properties. Sign in with an account that has access.</div>
        )}
        {updated && (
          <p className="muted" style={{ margin: 0 }}>
            Updated {updated.toLocaleTimeString()}
            {gsc && ` · Search data ${gsc.range.startDate} to ${gsc.range.endDate} (Search Console reports with a ~3 day delay)`}
          </p>
        )}
        {!gsc && !error && <div className="notice">Loading data for {site || "your properties"}…</div>}

        {gsc && tab === "overview" && <Overview gsc={gsc} ga={ga} gaError={gaError} hasGa4={!!ga4} site={site} />}
        {gsc && tab === "rankings" && <Rankings gsc={gsc} />}
        {site && tab === "indexing" && <Indexing site={site} />}
        {gsc && tab === "queries" && <Queries gsc={gsc} />}
        {tab === "audience" && <Audience ga={ga} gaError={gaError} hasGa4={!!ga4} loading={loading} />}
      </main>
    </>
  );
}
