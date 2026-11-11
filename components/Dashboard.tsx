// components/Dashboard.tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import type { GscData, Ga4Data, Properties, Sources } from "@/lib/types";
import { indexScanSource, loadIndexCache, peekIndexCache } from "@/lib/indexCache";
import { downloadJson, fileSafe } from "@/lib/evidence";
import { DEFAULT_DAYS, WINDOWS, yoyAllowed, type Compare } from "@/lib/dates";
import { getMonitor, monitorPrefs } from "@/lib/monitor";
import { SourcesProvider } from "./ui";
import Overview from "./Overview";
import Rankings from "./Rankings";
import Indexing from "./Indexing";
import IndexMonitor from "./IndexMonitor";
import CrawlActivity from "./CrawlActivity";
import Queries from "./Queries";
import QueryGrowth from "./QueryGrowth";
import Audience from "./Audience";
import CtaSection from "./CtaSection";
import ChannelDrilldown from "./ChannelDrilldown";
import Audit from "./Audit";

type Tab = "overview" | "rankings" | "indexing" | "monitor" | "crawl" | "queries" | "growth" | "audience" | "cta" | "audit";

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "rankings", label: "Rankings" },
  { id: "indexing", label: "Indexing" },
  { id: "monitor", label: "Live index monitor" },
  { id: "crawl", label: "Crawl activity" },
  { id: "queries", label: "Queries" },
  { id: "growth", label: "Query growth" },
  { id: "audience", label: "Traffic & geography" },
  { id: "cta", label: "CTAs" },
];

const SEARCH_TYPES: [string, string][] = [["web", "Web"], ["image", "Image"], ["video", "Video"], ["news", "News"]];

/** Search Console data changes about once a day, so 10 minutes is plenty (only GA4 realtime moves faster). */
const REFRESH_MS = 10 * 60 * 1000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

function readPrefs(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem("dash:prefs") || "{}");
  } catch {
    return {};
  }
}

/** Property a bookmark copy came from (both bookmarks send JSON with a "site" field). */
function siteOf(raw: string | null): string {
  try {
    return raw ? String(JSON.parse(raw)?.site || "") : "";
  } catch {
    return "";
  }
}

export default function Dashboard() {
  const { data: session } = useSession();
  const [props, setProps] = useState<Properties | null>(null);
  const [site, setSite] = useState("");
  const [ga4, setGa4] = useState("");
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [compare, setCompare] = useState<Compare>("previous");
  const [searchType, setSearchType] = useState("web");
  const [tab, setTab] = useState<Tab>("overview");
  const [canAudit, setCanAudit] = useState(false);
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
  // Crawl stats sent by the "Copy crawl stats" bookmark (arrives in the URL after #)
  const [inbox, setInbox] = useState<string | null>(null);
  const [inboxWaiting, setInboxWaiting] = useState(false);
  // NEW: AI impressions sent by the "Copy AI impressions" bookmark (arrives in the URL after #)
  const [aiInbox, setAiInbox] = useState<string | null>(null);
  const [aiWaiting, setAiWaiting] = useState(false);

  // Every source behind the numbers on screen, so any "Source" button can explain itself
  const sources = useMemo<Sources>(() => {
    const idx = site && typeof window !== "undefined" ? indexScanSource(peekIndexCache(site)) : null;
    return { ...(gsc?.sources || {}), ...(ga?.sources || {}), ...(idx ? { [idx.id]: idx } : {}) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gsc, ga, site, indexVersion, tab]);

  useEffect(() => {
    if (site) loadIndexCache(site).then(bumpIndex);
  }, [site, bumpIndex]);

  // Live index monitor: resume it for this property if it was left on; stop it when switching away.
  useEffect(() => {
    if (!site) return;
    const m = getMonitor();
    const p = monitorPrefs();
    if (p.on[site]) m.start(site, p.budget);
    else if (m.get().running && m.get().site !== site) m.stop();
  }, [site]);

  // The audit tab is shown only to the audit account; every audit API route checks the account again.
  useEffect(() => {
    fetch("/api/audit/access", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCanAudit(!!d?.allowed))
      .catch(() => {});
  }, []);

  // Receive data from the bookmarks. Each opens this page with a "wait" hash first, then the data:
  //   Copy crawl stats:    #crawl-wait, then #crawlstats=<data>
  //   Copy AI impressions: #ai-wait,    then #aistats=<data>   (NEW)
  useEffect(() => {
    const take = () => {
      const h = window.location.hash;
      const clean = () => window.history.replaceState(null, "", window.location.pathname + window.location.search);
      const read = (prefix: string) => {
        try {
          return decodeURIComponent(h.slice(prefix.length));
        } catch {
          return "";
        }
      };

      // NEW: AI impressions
      if (h.startsWith("#ai-wait") || h.startsWith("#aistats=")) {
        setTab("overview");
        if (h.startsWith("#ai-wait")) {
          setAiWaiting(true);
          clean();
          return;
        }
        const raw = read("#aistats=");
        clean();
        if (raw) setAiInbox(raw);
        setAiWaiting(false);
        return;
      }

      // Crawl stats (unchanged behaviour)
      if (!h.startsWith("#crawl-wait") && !h.startsWith("#crawlstats=")) return;
      setTab("crawl");
      if (h.startsWith("#crawl-wait")) {
        setInboxWaiting(true);
        clean();
        return;
      }
      const raw = read("#crawlstats=");
      clean();
      if (raw) setInbox(raw);
      setInboxWaiting(false);
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);

  const inboxSite = useMemo(() => siteOf(inbox), [inbox]);
  const aiInboxSite = useMemo(() => siteOf(aiInbox), [aiInbox]); // NEW

  // Switch to the property the crawl stats were copied from, if this account has it.
  useEffect(() => {
    if (!inboxSite || !props || inboxSite === site) return;
    if (props.gsc.some((x) => x.siteUrl === inboxSite)) changeSite(inboxSite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxSite, props]);

  // NEW: same for AI impressions
  useEffect(() => {
    if (!aiInboxSite || !props || aiInboxSite === site) return;
    if (props.gsc.some((x) => x.siteUrl === aiInboxSite)) changeSite(aiInboxSite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiInboxSite, props]);

  // Hand the data over once the right property is showing (or if this account can't open that property, so it can say so).
  const readyFor = (raw: string | null, from: string) =>
    !!raw && (!from || from === site || (!!props && !props.gsc.some((x) => x.siteUrl === from)));
  const inboxReady = readyFor(inbox, inboxSite);
  const aiInboxReady = readyFor(aiInbox, aiInboxSite); // NEW
  const aiInboxHandled = useCallback(() => {
    setAiInbox(null);
    setAiWaiting(false);
  }, []); // NEW

  const downloadEvidence = () => {
    downloadJson(`evidence-${fileSafe(site)}-${new Date().toISOString().slice(0, 10)}.json`, {
      about: "Every figure in the dashboard with the Google API request that produced it. Rerun any request in Google's API Explorer (Search Console) or GA4 Query Explorer to reproduce the numbers.",
      exportedAt: new Date().toISOString(),
      exportedBy: session?.user?.email,
      searchConsoleProperty: site,
      ga4Property: ga4 || null,
      periodDays: days,
      searchType,
      comparedWith: compare === "yoy" ? "the same days a year earlier (52 weeks back)" : "the previous period",
      sources,
      data: {
        searchConsole: gsc ? { ...gsc, sources: undefined } : null,
        ga4: ga ? { ...ga, sources: undefined } : null,
      },
    });
  };

  useEffect(() => {
    getJson<Properties>("/api/properties")
      .then((p) => {
        setProps(p);
        const prefs = readPrefs();
        const s = p.gsc.find((x) => x.siteUrl === prefs.site)?.siteUrl || p.gsc[0]?.siteUrl || "";
        setSite(s);
        setGa4(prefs.map?.[s] ?? p.gsc.find((x) => x.siteUrl === s)?.ga4Id ?? "");
        if ((WINDOWS as readonly number[]).includes(prefs.days)) setDays(prefs.days);
        if (prefs.compare === "yoy") setCompare("yoy");
        if (SEARCH_TYPES.some(([id]) => id === prefs.searchType)) setSearchType(prefs.searchType);
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
    localStorage.setItem(
      "dash:prefs",
      JSON.stringify({ ...prefs, site, days, compare, searchType, map: { ...(prefs.map || {}), [site]: ga4 } })
    );
  }, [site, ga4, days, compare, searchType]);

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
      getJson<GscData>(`/api/gsc/performance?site=${encodeURIComponent(site)}&days=${days}&compare=${compare}&type=${searchType}`),
      ga4 ? getJson<Ga4Data>(`/api/ga4/overview?property=${ga4}&days=${days}&compare=${compare}`) : Promise.resolve(null),
    ]);
    if (id !== reqId.current) return; // a newer request superseded this one
    if (g.status === "fulfilled") setGsc(g.value);
    else setError(g.reason?.message || "Search Console request failed");
    if (a.status === "fulfilled") setGa(a.value);
    else {
      setGa(null);
      setGaError(a.reason?.message || "GA4 request failed");
    }
    setUpdated(new Date());
    setLoading(false);
  }, [site, ga4, days, compare, searchType]);

  useEffect(() => {
    setGsc(null);
    setGa(null);
    load();
  }, [load]);

  // Auto-refresh only while the browser tab is visible
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const tabs: { id: Tab; label: string }[] = canAudit ? [...BASE_TABS, { id: "audit", label: "GSC audit (AI)" }] : BASE_TABS;
  const noGa4Notice = <div className="notice">Pick a GA4 property in the top bar to see this data.</div>;
  const needsGsc = ["overview", "rankings", "queries"].includes(tab);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            Search &amp; traffic dashboard
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
              {WINDOWS.map((d) => (
                <option key={d} value={d}>Last {d} days</option>
              ))}
            </select>
          </label>

          <label className="control">
            Compare with
            <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} style={{ minWidth: 150 }}>
              <option value="previous">Previous period</option>
              <option value="yoy" disabled={!yoyAllowed(days)}>Same days last year</option>
            </select>
          </label>

          <label className="control">
            Search type
            <select value={searchType} onChange={(e) => setSearchType(e.target.value)}>
              {SEARCH_TYPES.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>

          <button className="btn" onClick={load} disabled={loading || !site}>{loading ? "Refreshing…" : "Refresh"}</button>
          <button className="btn" onClick={downloadEvidence} disabled={!gsc} title="Download every number with the exact Google API request behind it">
            Download evidence
          </button>
          <button className="live btn" onClick={() => setLive(!live)} aria-pressed={live} title="Refresh automatically every 10 minutes while this tab is visible">
            <span className={`live-dot ${live ? "" : "off"}`} /> {live ? "Auto-refresh on" : "Auto-refresh off"}
          </button>
          <button className="btn" onClick={() => signOut({ callbackUrl: "/login" })}>Sign out</button>
        </div>

        <nav className="tabs" role="tablist">
          {tabs.map((t) => (
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
              {gsc && ` · Search data ${gsc.range.startDate} to ${gsc.range.endDate} vs ${gsc.previousRange.startDate} to ${gsc.previousRange.endDate}`}
              {gsc?.dataThrough && ` · Search Console is complete through ${gsc.dataThrough}`}
              {ga?.timeZone && ` · GA4 dates in ${ga.timeZone}`}
              {gsc && " · Every figure has a Source button showing the Google API call behind it."}
            </p>
          )}

          {!gsc && !error && needsGsc && (
            <div className="notice">
              {aiWaiting || aiInbox ? "Receiving AI impressions from the bookmark… " : ""}Loading data for {site || "your properties"}…
            </div>
          )}

          {/* CHANGED: Overview also receives data from the "Copy AI impressions" bookmark */}
          {gsc && tab === "overview" && (
            <Overview
              gsc={gsc}
              ga={ga}
              gaError={gaError}
              hasGa4={!!ga4}
              site={site}
              aiInbox={aiInboxReady ? aiInbox : null}
              aiWaiting={aiWaiting || (!!aiInbox && !aiInboxReady)}
              onAiInboxHandled={aiInboxHandled}
            />
          )}
          {gsc && tab === "rankings" && <Rankings gsc={gsc} site={site} />}
          {site && tab === "indexing" && <Indexing site={site} onChange={bumpIndex} />}
          {site && tab === "monitor" && <IndexMonitor site={site} />}
          {site && tab === "crawl" && (
            <CrawlActivity
              site={site}
              inbox={inboxReady ? inbox : null}
              waiting={inboxWaiting || (!!inbox && !inboxReady)}
              onInboxHandled={() => {
                setInbox(null);
                setInboxWaiting(false);
              }}
            />
          )}
          {gsc && tab === "queries" && <Queries gsc={gsc} />}
          {site && tab === "growth" && <QueryGrowth site={site} days={days} compare={compare} />}

          {tab === "audience" && (
            <>
              <Audience ga={ga} gaError={gaError} hasGa4={!!ga4} loading={loading} />
              <section className="section">
                <h2>Channel drill-down</h2>
                <p className="lede">
                  Click a channel to see exactly where its traffic came from: source and medium, landing pages, countries, devices and
                  campaigns. Rows with many sessions but almost no engagement are usually bots or tracking problems.
                </p>
                {ga4 ? <ChannelDrilldown key={`ch-${ga4}-${days}`} propertyId={ga4} days={days} /> : noGa4Notice}
              </section>
            </>
          )}

          {tab === "cta" && (
            <section className="section">
              <h2>CTA clicks</h2>
              <p className="lede">
                Visits to the Buy / License, Request sample, Talk to expert, Customization and Connect pages. Click a CTA to filter every
                table below to it: which channel and source the visitor came from, their country, region and city, which report they
                were interested in, and the page they clicked from.
              </p>
              {ga4 ? <CtaSection key={`cta-${ga4}-${days}`} propertyId={ga4} days={days} /> : noGa4Notice}
            </section>
          )}

          {site && tab === "audit" && canAudit && <Audit site={site} />}
        </main>
      </SourcesProvider>
    </>
  );
}
