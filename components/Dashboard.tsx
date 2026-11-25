// components/Dashboard.tsx
"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { signOut, useSession } from "next-auth/react";
import type { GscData, Ga4Data, Properties, Sources } from "@/lib/types";
import { indexScanSource, loadIndexCache, peekIndexCache } from "@/lib/indexCache";
import { downloadJson, fileSafe } from "@/lib/evidence";
import { DEFAULT_DAYS, MAX_DAYS, yoyAllowed, type Compare } from "@/lib/dates";
import { urlInProperty } from "@/lib/url";
import { SourcesProvider } from "./ui";
import Overview from "./Overview";
import Rankings from "./Rankings";
import IndexReport from "./IndexReport";
import UrlCheck from "./UrlCheck";
import UrlReport from "./UrlReport";
import CrawlActivity from "./CrawlActivity";
import Queries from "./Queries";
import QueryGrowth from "./QueryGrowth";
import Audience from "./Audience";
import CtaSection from "./CtaSection";
import ChannelDrilldown from "./ChannelDrilldown";
import SocialTraffic from "./SocialTraffic"; // social media
import WeeklyReport from "./WeeklyReport"; // weekly report
import Audit from "./Audit"; // Site investigation (replaces the GSC audit)
import IndexChecks from "./IndexChecks";
import WeeklyCaptures from "./WeeklyCaptures";
import CompareMode, { COMPARE_TABS, type CompareTab } from "./CompareMode";
import AccessManager from "./AccessManager"; // manage access (the two access admins only)

type Tab =
  | "overview" | "rankings" | "indexing" | "checks" | "captures" | "crawl" | "queries" | "growth" | "audience" | "cta" | "audit"
  | "weekly" | "access"; // weekly report, manage access

type TabDef = { id: Tab; label: string };

/** Data tabs, in groups of related tabs. A thin line separates the groups. */
const TAB_GROUPS: TabDef[][] = [
  [
    { id: "overview", label: "Overview" },
    { id: "rankings", label: "Rankings" },
    { id: "queries", label: "Queries" },
    { id: "growth", label: "Query growth" },
  ],
  [
    { id: "indexing", label: "Indexing" },
    { id: "checks", label: "Index checks" },
    { id: "crawl", label: "Crawl activity" },
    { id: "captures", label: "Weekly captures" }, // "Weekly captures" ticked in Manage access
  ],
  [
    { id: "audience", label: "Traffic & geography" },
    { id: "cta", label: "CTAs" },
  ],
];

/** Tools only some accounts have. They sit as buttons in the top row instead of the tab strip. */
const TOOL_TABS: TabDef[] = [
  { id: "weekly", label: "Weekly report" }, // "Weekly report" ticked in Manage access
  { id: "audit", label: "Site investigation" }, // "Site investigation" ticked in Manage access
  { id: "access", label: "Manage access" }, // the two access admins (lib/accessList.ts)
];

const SEARCH_TYPES: [string, string][] = [["web", "Web"], ["image", "Image"], ["video", "Video"], ["news", "News"]];

/** Period presets (days). "Custom" picks any number of months up to Search Console's 16. */
const PERIODS: [number, string][] = [
  [7, "Last 7 days"],
  [15, "Last 15 days"],
  [30, "Last 30 days"],
  [90, "Last 3 months (90 days)"],
  [180, "Last 6 months (180 days)"],
  [365, "Last 12 months (365 days)"],
  [480, "Last 16 months (480 days)"],
];
const MAX_CUSTOM_MONTHS = 16;

/** Days in the last N calendar months, ending yesterday (capped at what Search Console keeps). */
function daysForMonths(months: number) {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - months);
  return Math.min(MAX_DAYS, Math.max(1, Math.round((end.getTime() - start.getTime()) / 864e5)));
}

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

/** Property a bookmark copy came from (every bookmark sends JSON with a "site" field). */
function siteOf(raw: string | null): string {
  try {
    return raw ? String(JSON.parse(raw)?.site || "") : "";
  } catch {
    return "";
  }
}

/* ---------------- Phones ---------------- */

const NARROW_PX = 760;

/** True on phone-sized screens. */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_PX}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/* ---------------- Folding the top bar on scroll ---------------- */

/** The top bar folds into one line after this much scrolling, and opens again near the top. */
const FOLD_AT = 160;
const UNFOLD_AT = 24;

/** True once the page is scrolled down. Two thresholds, so the bar doesn't flicker at the edge. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => {
      const y = window.scrollY;
      // Only fold when the page is long enough that folding can't bounce it straight back to the top.
      const room = document.documentElement.scrollHeight - window.innerHeight;
      setScrolled((was) => (was ? y > UNFOLD_AT : y > FOLD_AT && room > FOLD_AT + 320));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, []);
  return scrolled;
}

/** Layout fixes for phone-sized screens (the whole dashboard, including Compare months). */
const MOBILE_CSS = `
@media (max-width: ${NARROW_PX}px) {
  .topbar { position: static !important; box-shadow: none !important; }
  .topbar-inner { padding: 10px 12px !important; }
  .topbar .control, .topbar .control select, .topbar .control input { width: 100%; min-width: 0 !important; max-width: none !important; }
  .topbar form { max-width: none !important; }
  .tabs { overflow-x: auto; flex-wrap: nowrap !important; white-space: nowrap; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tabs .tab { flex: 0 0 auto; }
  main { padding: 12px !important; }
  .section h2 { font-size: 18px; }
  .panel { padding: 12px !important; }
  .grid-2 { grid-template-columns: 1fr !important; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 8px !important; }
  .kpi .value { font-size: 20px !important; }
  table { font-size: 13px; }
  .src-dialog { width: 100vw !important; max-width: 100vw !important; max-height: 100vh !important; border-radius: 0 !important; }
  .cmp-mid { flex-direction: row !important; width: 100%; justify-content: center !important; flex-wrap: wrap; }
  .cmp-line { display: none !important; }
}`;

/**
 * The top bar's own styles. Every class starts with "tb-" and every rule is limited to the top bar,
 * so nothing here can change the charts or tables (e.g. the bar charts' own .bar-row).
 */
const TOPBAR_CSS = `
.topbar .tb-row1 { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.topbar .tb-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.topbar .tb-row { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; border-top: 1px solid #e8eaed; margin-top: 12px; padding-top: 12px; }
.topbar .tb-fold { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .2s ease; }
.topbar .tb-fold.tb-folded { grid-template-rows: 0fr; }
.topbar .tb-fold-inner { min-height: 0; overflow: hidden; }
.topbar .tb-fold.tb-folded .tb-fold-inner { visibility: hidden; transition: visibility 0s .2s; }
.topbar .tb-summary { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; max-width: 620px; padding: 8px 12px; border: 1px solid #dadce0; border-radius: 8px; background: #f8f9fa; color: #202124; font-size: 14px; text-align: left; cursor: pointer; }
.topbar .tb-summary:hover { background: #f1f3f4; }
.topbar .tb-summary-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar .tb-summary-chg { flex: 0 0 auto; color: #1a73e8; font-weight: 600; }
.topbar .tb-tool[aria-pressed="true"] { background: #e8f0fe; border-color: #1a73e8; color: #174ea6; }
.topbar .tb-tabs { display: flex; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
.topbar .tb-tabs::-webkit-scrollbar { display: none; }
.tb-tabs .tab { flex: 0 0 auto; }
.tb-tabs .tb-sep { flex: 0 0 auto; width: 1px; height: 18px; align-self: center; margin: 0 6px; background: #dadce0; }
`;

/* ---------------- Top bar pieces ---------------- */

const BLUE = "#1a73e8";
const LABEL_STYLE = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#5f6368", textTransform: "uppercase" as const };

/** Visually hidden, still read out by screen readers (the dropdowns label themselves on screen). */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** A captioned group of controls in the top bar ("Website", "Dates"). */
function Group({ title, children, grow = false }: { title: string; children: ReactNode; grow?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: grow ? "1 1 auto" : "0 1 auto" }}>
      <div style={LABEL_STYLE}>{title}</div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>{children}</div>
    </div>
  );
}

/** The thin vertical line between groups (hidden on phones, where the groups stack). */
const Divider = ({ hidden = false }: { hidden?: boolean }) =>
  hidden ? null : <div aria-hidden="true" style={{ width: 1, alignSelf: "stretch", background: "#dadce0", margin: "0 4px" }} />;

/** One clear switch between the normal dashboard and Compare months. */
function ViewSwitch({ compare, onChange, full = false }: { compare: boolean; onChange: (v: boolean) => void; full?: boolean }) {
  const option = (active: boolean, label: string, value: boolean, title: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={active}
      title={title}
      style={{
        flex: full ? "1 1 0" : undefined,
        padding: "8px 16px",
        border: "none",
        background: active ? BLUE : "#fff",
        color: active ? "#fff" : "#3c4043",
        fontWeight: 600,
        fontSize: 14,
        cursor: active ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Choose the view"
      style={{ display: "inline-flex", width: full ? "100%" : undefined, border: `1px solid ${BLUE}`, borderRadius: 8, overflow: "hidden" }}
    >
      {option(!compare, "Normal view", false, "Live Search Console and GA4 numbers for the period you choose")}
      <span aria-hidden="true" style={{ width: 1, background: BLUE }} />
      {option(compare, "Compare months", true, "Compare any months side by side, including months Search Console no longer shows")}
    </div>
  );
}

export default function Dashboard() {
  const { data: session } = useSession();
  const narrow = useNarrow();
  const scrolled = useScrolled();
  /** null: the bar follows the scroll (on phones it stays folded). true / false: the person opened or folded it. */
  const [open, setOpen] = useState<boolean | null>(null);
  const [props, setProps] = useState<Properties | null>(null);
  const [site, setSite] = useState("");
  const [ga4, setGa4] = useState("");
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [customMonths, setCustomMonths] = useState<number | null>(null);
  const [compare, setCompare] = useState<Compare>("previous");
  const [searchType, setSearchType] = useState("web");
  const [tab, setTab] = useState<Tab>("overview");
  const [compareMode, setCompareMode] = useState(false);
  const [ctab, setCtab] = useState<CompareTab>("summary");
  const [canAudit, setCanAudit] = useState(false);
  const [canCapture, setCanCapture] = useState(false);
  /** "Weekly report" ticked in Manage access. */
  const [canWeekly, setCanWeekly] = useState(false); // weekly report
  /** Read-only account (Manage access): sees everything, but can't run URL Inspection or change settings. */
  const [viewer, setViewer] = useState(false);
  /** One of the two access admins (lib/accessList.ts): sees the Manage access button. */
  const [admin, setAdmin] = useState(false);
  /** "Index checks" ticked in Manage access: can start and pause daily index checks. */
  const [canChecks, setCanChecks] = useState(false);
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
  // Data sent by the old bookmarks (arrives in the URL after #). Bookmarks are retired; the tabs only acknowledge it.
  const [inbox, setInbox] = useState<string | null>(null); // Copy crawl stats
  const [inboxWaiting, setInboxWaiting] = useState(false);
  const [aiInbox, setAiInbox] = useState<string | null>(null); // Copy AI impressions
  const [aiWaiting, setAiWaiting] = useState(false);
  const [idxInbox, setIdxInbox] = useState<string | null>(null); // Copy page indexing
  const [idxWaiting, setIdxWaiting] = useState(false);
  // "Look up a URL" in the top bar
  const [lookupText, setLookupText] = useState("");
  const [lookup, setLookup] = useState<string | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const closeLookup = useCallback(() => setLookup(null), []);

  /** Folded: the bar shows one line (site, dates) plus the tabs. */
  const compact = open === null ? narrow || scrolled : !open;

  // Scrolling past the fold point (either way) hands the bar back to the scroll.
  useEffect(() => {
    setOpen(null);
  }, [scrolled]);

  // Opened while scrolled down? Fold again once they've scrolled on a fair way.
  useEffect(() => {
    if (open !== true) return;
    const from = window.scrollY;
    const on = () => {
      if (Math.abs(window.scrollY - from) > 300) setOpen(null);
    };
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [open]);

  // Every source behind the numbers on screen, so any "Source" button can explain itself
  const sources = useMemo<Sources>(() => {
    const idx = site && typeof window !== "undefined" ? indexScanSource(peekIndexCache(site)) : null;
    return { ...(gsc?.sources || {}), ...(ga?.sources || {}), ...(idx ? { [idx.id]: idx } : {}) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gsc, ga, site, indexVersion, tab]);

  useEffect(() => {
    if (site) loadIndexCache(site).then(bumpIndex);
    setLookup(null);
    setLookupErr(null);
  }, [site, bumpIndex]);

  // What this person can do (set in Manage access, lib/accessList.ts). Every route checks again on the server.
  useEffect(() => {
    fetch("/api/role", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setViewer(!!d?.viewer);
        setAdmin(!!d?.admin);
        setCanChecks(!!d?.indexChecks);
      })
      .catch(() => {});
  }, []);

  // The Site investigation button is shown only to accounts with "Site investigation" ticked; every audit route checks again.
  useEffect(() => {
    fetch("/api/audit/access", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCanAudit(!!d?.allowed))
      .catch(() => {});
  }, []);

  // The Weekly captures tab is shown only to the people who run the captures ("Weekly captures" ticked);
  // its API routes check the account again. Everyone sees who updated each report on the charts themselves.
  useEffect(() => {
    fetch("/api/capture/access", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCanCapture(!!d?.allowed))
      .catch(() => {});
  }, []);

  // Weekly report: the button is shown only to accounts with "Weekly report" ticked; its API routes check the account again.
  useEffect(() => {
    fetch("/api/weekly/access", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCanWeekly(!!d?.allowed))
      .catch(() => {});
  }, []);

  // Receive data from the old bookmarks. Each opens this page with a "wait" hash first, then the data:
  //   Copy crawl stats:     #crawl-wait, then #crawlstats=<data>
  //   Copy AI impressions:  #ai-wait,    then #aistats=<data>
  //   Copy page indexing:   #idx-wait,   then #idxstats=<data>
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
      const handle = (
        waitHash: string,
        dataHash: string,
        toTab: Tab,
        setWait: (v: boolean) => void,
        setData: (v: string) => void
      ) => {
        if (!h.startsWith(waitHash) && !h.startsWith(dataHash)) return false;
        setTab(toTab);
        if (h.startsWith(waitHash)) {
          setWait(true);
          clean();
          return true;
        }
        const raw = read(dataHash);
        clean();
        if (raw) setData(raw);
        setWait(false);
        return true;
      };
      if (handle("#idx-wait", "#idxstats=", "indexing", setIdxWaiting, setIdxInbox)) return;
      if (handle("#ai-wait", "#aistats=", "overview", setAiWaiting, setAiInbox)) return;
      handle("#crawl-wait", "#crawlstats=", "crawl", setInboxWaiting, setInbox);
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, []);

  const inboxSite = useMemo(() => siteOf(inbox), [inbox]);
  const aiInboxSite = useMemo(() => siteOf(aiInbox), [aiInbox]);
  const idxInboxSite = useMemo(() => siteOf(idxInbox), [idxInbox]);

  // Switch to the property the bookmark data was copied from, if this account has it.
  useEffect(() => {
    const from = idxInboxSite || aiInboxSite || inboxSite;
    if (!from || !props || from === site) return;
    if (props.gsc.some((x) => x.siteUrl === from)) changeSite(from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxSite, aiInboxSite, idxInboxSite, props]);

  // Hand the data over once the right property is showing (or if this account can't open that property, so it can say so).
  const readyFor = (raw: string | null, from: string) =>
    !!raw && (!from || from === site || (!!props && !props.gsc.some((x) => x.siteUrl === from)));
  const inboxReady = readyFor(inbox, inboxSite);
  const aiInboxReady = readyFor(aiInbox, aiInboxSite);
  const idxInboxReady = readyFor(idxInbox, idxInboxSite);
  const aiInboxHandled = useCallback(() => {
    setAiInbox(null);
    setAiWaiting(false);
  }, []);
  const idxInboxHandled = useCallback(() => {
    setIdxInbox(null);
    setIdxWaiting(false);
  }, []);

  /** "Look up a URL": accepts a full URL, a path like /blog/x, or a URL without https://. */
  const openLookup = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = lookupText.trim();
    if (!raw || !site) return;
    const base = site.startsWith("sc-domain:") ? `https://${site.slice(10)}` : site.replace(/\/$/, "");
    const u = /^https?:\/\//i.test(raw) ? raw : raw.startsWith("/") ? base + raw : `https://${raw}`;
    if (!urlInProperty(site, u)) {
      setLookupErr(`${u} isn't part of ${site.replace(/\/$/, "")}. Paste a page from this property, or switch property first.`);
      return;
    }
    setLookupErr(null);
    setLookup(u);
    if (narrow) setOpen(null);
  };

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
        const cm = Number(prefs.customMonths);
        if (Number.isInteger(cm) && cm >= 1 && cm <= MAX_CUSTOM_MONTHS) {
          setCustomMonths(cm);
          setDays(daysForMonths(cm));
        } else if (Number.isInteger(prefs.days) && prefs.days >= 1 && prefs.days <= MAX_DAYS) {
          setDays(prefs.days);
        }
        if (prefs.compare === "yoy") setCompare("yoy");
        if (SEARCH_TYPES.some(([id]) => id === prefs.searchType)) setSearchType(prefs.searchType);
        if (prefs.compareMode === true) setCompareMode(true);
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
      JSON.stringify({ ...prefs, site, days, customMonths, compare, searchType, compareMode, map: { ...(prefs.map || {}), [site]: ga4 } })
    );
  }, [site, ga4, days, customMonths, compare, searchType, compareMode]);

  // Save this property's Search Console and GA4 history in the Google Sheets when it's opened (see lib/archive.ts).
  // The first open of the day does the work in the background; later opens return at once.
  useEffect(() => {
    if (!site) return;
    let active = true;
    (async () => {
      for (let round = 0; round < 8 && active; round++) {
        const r = await fetch("/api/archive/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site, ga4 }),
        }).catch(() => null);
        const j = r && r.ok ? await r.json().catch(() => null) : null;
        window.dispatchEvent(new Event("archive:updated"));
        if (!j || j.done) break;
      }
    })();
    return () => {
      active = false;
    };
  }, [site, ga4]);

  useEffect(() => {
    if (compare === "yoy" && !yoyAllowed(days)) setCompare("previous");
  }, [days, compare]);

  const load = useCallback(async () => {
    if (!site || compareMode) return; // Compare months mode reads the saved history instead
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
  }, [site, ga4, days, compare, searchType, compareMode]);

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

  const changePeriod = (v: string) => {
    if (v === "custom") {
      const m = customMonths || 4;
      setCustomMonths(m);
      setDays(daysForMonths(m));
      return;
    }
    setCustomMonths(null);
    setDays(Number(v));
  };
  const changeCustom = (v: string) => {
    const m = Math.min(MAX_CUSTOM_MONTHS, Math.max(1, Math.floor(Number(v)) || 1));
    setCustomMonths(m);
    setDays(daysForMonths(m));
  };

  // What this person can open: Weekly captures only for capture accounts (a tab), and the tools only for their accounts
  // (buttons in the top row): Weekly report, Site investigation, Manage access.
  const dataGroups = TAB_GROUPS.map((g) => g.filter((t) => t.id !== "captures" || canCapture)).filter((g) => g.length > 0);
  const tools = TOOL_TABS.filter((t) => (t.id === "weekly" ? canWeekly : t.id === "audit" ? canAudit : admin));
  const visibleIds = [...dataGroups.flat(), ...tools].map((t) => t.id);

  // Nobody stays on a tab they can't see.
  useEffect(() => {
    if (!visibleIds.includes(tab)) setTab("overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCapture, canAudit, canWeekly, admin, tab]);

  /** Open a tool from the top row (always in the normal view). */
  const openTool = (id: Tab) => {
    setCompareMode(false);
    setTab(id);
    if (narrow) setOpen(null);
  };

  const noGa4Notice = <div className="notice">Pick a GA4 property in the top bar to see this data.</div>;
  const needsGsc = ["overview", "rankings", "queries"].includes(tab);
  const previousIncomplete = !compareMode && compare === "previous" && days * 2 > MAX_DAYS;

  // The one-line summary shown when the bar is folded (and on phones).
  const siteShort = site.replace(/^sc-domain:/, "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const periodLabel = customMonths ? `Last ${customMonths} months` : PERIODS.find(([d]) => d === days)?.[1] || `Last ${days} days`;
  const typeLabel = SEARCH_TYPES.find(([id]) => id === searchType)?.[1] || "Web";
  const summaryText = compareMode
    ? "Compare months"
    : `${periodLabel} vs ${compare === "yoy" ? "same days last year" : "previous period"} · ${typeLabel} search`;

  const summaryButton = (
    <button
      type="button"
      className="tb-summary"
      onClick={() => setOpen(true)}
      aria-expanded={false}
      title="Change the website, dates or comparison"
      style={narrow ? { marginTop: 10, width: "100%", maxWidth: "none" } : undefined}
    >
      <span className="tb-summary-txt">
        <b>{siteShort || "Choose a website"}</b> · {summaryText}
      </span>
      <span className="tb-summary-chg">Change ▾</span>
    </button>
  );

  const brand = (
    <div className="brand">
      Search &amp; traffic dashboard
      <small>
        {session?.user?.email}
        {viewer && (
          <span style={{ marginLeft: 8, padding: "1px 8px", borderRadius: 999, background: "#f1f3f4", color: "#5f6368", fontSize: 11, fontWeight: 600 }}>
            Read-only
          </span>
        )}
      </small>
    </div>
  );

  const toolButtons = tools.map((t) => (
    <button key={t.id} type="button" className="btn tb-tool" aria-pressed={!compareMode && tab === t.id} onClick={() => openTool(t.id)}>
      {t.label}
    </button>
  ));

  const signOutButton = (
    <button className="btn" onClick={() => signOut({ callbackUrl: "/login" })}>
      Sign out
    </button>
  );

  const nav = (
    <nav
      className="tabs tb-tabs"
      role="tablist"
      style={narrow ? { position: "sticky", top: 0, zIndex: 20, background: "#fff", borderBottom: "1px solid #d5dbe1" } : undefined}
    >
      {compareMode
        ? COMPARE_TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={ctab === t.id} onClick={() => setCtab(t.id)}>
              {t.label}
            </button>
          ))
        : dataGroups.map((group, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="tb-sep" aria-hidden="true" />}
              {group.map((t) => (
                <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </Fragment>
          ))}
    </nav>
  );

  return (
    <>
      <style>{TOPBAR_CSS + MOBILE_CSS}</style>
      <header
        className="topbar"
        style={{ position: "sticky", top: 0, zIndex: 30, boxShadow: compact && !narrow ? "0 1px 6px rgba(60,64,67,.18)" : undefined }}
      >
        <div className="topbar-inner" style={{ display: "block" }}>
          {/* Row 1: who you are (folded: what you're looking at), tools, view switch, sign out */}
          <div className="tb-row1">
            {compact && !narrow ? summaryButton : brand}
            <div className="tb-right" style={narrow ? { width: "100%" } : undefined}>
              {!narrow && toolButtons}
              {!narrow && tools.length > 0 && <Divider />}
              <ViewSwitch compare={compareMode} onChange={setCompareMode} full={narrow} />
              {!narrow && signOutButton}
            </div>
          </div>

          {/* Phones: one line instead of every control; tap to change */}
          {narrow && compact && summaryButton}

          {/* Website, dates, look-up and actions: fold away once you scroll */}
          <div className={`tb-fold${compact ? " tb-folded" : ""}`} aria-hidden={compact}>
            <div className="tb-fold-inner">
              {/* Row 2: which website, which dates */}
              <div className="tb-row" style={{ alignItems: "stretch" }}>
                <Group title="Website">
                  <label className="control">
                    <span style={SR_ONLY}>Search Console property</span>
                    <select value={site} onChange={(e) => changeSite(e.target.value)} disabled={!props} style={{ minWidth: 220 }}>
                      {!props && <option>Loading…</option>}
                      {props?.gsc.map((s) => (
                        <option key={s.siteUrl} value={s.siteUrl}>{s.siteUrl.replace(/\/$/, "")}</option>
                      ))}
                    </select>
                  </label>
                  <label className="control">
                    <span style={SR_ONLY}>GA4 property</span>
                    <select value={ga4} onChange={(e) => setGa4(e.target.value)} disabled={!props} style={{ minWidth: 220, maxWidth: 340 }}>
                      <option value="">No GA4 property</option>
                      {props?.ga4.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} ({p.account})</option>
                      ))}
                    </select>
                  </label>
                </Group>

                <Divider hidden={narrow} />

                {compareMode ? (
                  <Group title="Dates" grow>
                    <div
                      style={{
                        padding: "9px 12px",
                        background: "#e8f0fe",
                        color: "#174ea6",
                        borderRadius: 8,
                        fontSize: 14,
                        alignSelf: "center",
                      }}
                    >
                      Pick the months in the boxes below: <b>left side</b> vs <b>right side</b>.
                    </div>
                  </Group>
                ) : (
                  <Group title="Dates" grow>
                    <label className="control">
                      <span style={SR_ONLY}>Period</span>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select value={customMonths ? "custom" : String(days)} onChange={(e) => changePeriod(e.target.value)} style={{ minWidth: 170 }}>
                          {!customMonths && !PERIODS.some(([d]) => d === days) && <option value={String(days)}>Last {days} days</option>}
                          {PERIODS.map(([d, l]) => (
                            <option key={d} value={String(d)}>{l}</option>
                          ))}
                          <option value="custom">Custom: last N months…</option>
                        </select>
                        {customMonths && (
                          <>
                            <input
                              type="number"
                              min={1}
                              max={MAX_CUSTOM_MONTHS}
                              value={customMonths}
                              onChange={(e) => changeCustom(e.target.value)}
                              aria-label="Number of months"
                              style={{ width: 64, minWidth: 64 }}
                            />
                            <span className="muted" style={{ whiteSpace: "nowrap" }}>months ({days} days)</span>
                          </>
                        )}
                      </div>
                    </label>

                    <label className="control">
                      <span style={SR_ONLY}>Compare with</span>
                      <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} style={{ minWidth: 180 }}>
                        <option value="previous">vs previous period</option>
                        <option value="yoy" disabled={!yoyAllowed(days)}>vs same days last year</option>
                      </select>
                    </label>

                    <label className="control">
                      <span style={SR_ONLY}>Search type</span>
                      <select value={searchType} onChange={(e) => setSearchType(e.target.value)}>
                        {SEARCH_TYPES.map(([id, label]) => (
                          <option key={id} value={id}>{label} search</option>
                        ))}
                      </select>
                    </label>
                  </Group>
                )}
              </div>

              {/* Row 3 (normal view only): look up a page, actions */}
              {!compareMode && (
                <div className="tb-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <form
                    onSubmit={openLookup}
                    style={{ display: "flex", gap: 6, flex: "1 1 auto", maxWidth: 560, width: narrow ? "100%" : undefined }}
                  >
                    <input
                      type="search"
                      value={lookupText}
                      onChange={(e) => setLookupText(e.target.value)}
                      placeholder="Look up a page: paste a URL from this site"
                      aria-label="Page URL to look up"
                      style={{ flex: "1 1 auto", minWidth: narrow ? 0 : 240 }}
                    />
                    <button className="btn" type="submit" disabled={!site || !lookupText.trim()}>
                      Look up
                    </button>
                  </form>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button className="btn" onClick={load} disabled={loading || !site}>{loading ? "Refreshing…" : "Refresh"}</button>
                    <button className="btn" onClick={downloadEvidence} disabled={!gsc} title="Download every number with the exact Google API request behind it">
                      Download evidence
                    </button>
                    <button className="live btn" onClick={() => setLive(!live)} aria-pressed={live} title="Refresh automatically every 10 minutes while this tab is visible">
                      <span className={`live-dot ${live ? "" : "off"}`} /> {live ? "Auto-refresh on" : "Auto-refresh off"}
                    </button>
                  </div>
                </div>
              )}

              {/* Phones: tools, sign out and close, at the bottom of the open panel */}
              {narrow && (
                <div className="tb-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {toolButtons}
                    {signOutButton}
                  </div>
                  <button className="btn primary" onClick={() => setOpen(false)}>Done</button>
                </div>
              )}
            </div>
          </div>
        </div>

        {!narrow && nav}
      </header>
      {narrow && nav}

      <SourcesProvider value={sources}>
        <main>
          {props && props.gsc.length === 0 && (
            <div className="notice">This Google account has no verified Search Console properties. Sign in with an account that has access.</div>
          )}

          {compareMode ? (
            site && <CompareMode site={site} ga4={ga4} tab={ctab} readOnly={viewer} />
          ) : (
            <>
              {error && <div className="notice error">{error}</div>}
              {lookupErr && <div className="notice error">{lookupErr}</div>}
              {lookup && !gsc && <div className="notice">Loading Search Console data before opening {lookup}…</div>}

              {updated && (
                <p className="muted" style={{ margin: 0, fontSize: narrow ? 12 : undefined }}>
                  Updated {updated.toLocaleTimeString()}
                  {gsc && ` · Search data ${gsc.range.startDate} to ${gsc.range.endDate} vs ${gsc.previousRange.startDate} to ${gsc.previousRange.endDate}`}
                  {gsc?.dataThrough && ` · Search Console is complete through ${gsc.dataThrough}`}
                  {ga?.timeZone && ` · GA4 dates in ${ga.timeZone}`}
                  {gsc && !narrow && " · Every figure has a Source button showing the Google API call behind it."}
                </p>
              )}
              {previousIncomplete && (
                <div className="notice" style={{ marginTop: 8 }}>
                  Search Console keeps about 16 months, so the previous {days} days are only partly available and its change figures
                  aren&apos;t reliable. To compare older periods, switch to <b>Compare months</b> at the top: it uses your saved history.
                </div>
              )}

              {!gsc && !error && needsGsc && (
                <div className="notice">Loading data for {site || "your properties"}…</div>
              )}

              {gsc && tab === "overview" && (
                <Overview
                  gsc={gsc}
                  ga={ga}
                  gaError={gaError}
                  hasGa4={!!ga4}
                  site={site}
                  ga4={ga4} // for "Visits from AI assistants"
                  days={days}
                  compare={compare}
                  aiInbox={aiInboxReady ? aiInbox : null}
                  aiWaiting={aiWaiting || (!!aiInbox && !aiInboxReady)}
                  onAiInboxHandled={aiInboxHandled}
                />
              )}
              {gsc && tab === "rankings" && <Rankings gsc={gsc} site={site} />}

              {site && tab === "indexing" && (
                <>
                  <IndexReport
                    site={site}
                    inbox={idxInboxReady ? idxInbox : null}
                    waiting={idxWaiting || (!!idxInbox && !idxInboxReady)}
                    onInboxHandled={idxInboxHandled}
                  />
                  {/* "Check specific pages" runs URL Inspection, which read-only accounts can't use. */}
                  {!viewer && <UrlCheck site={site} />}
                </>
              )}

              {/* Start / Pause only with "Index checks" ticked in Manage access, never for read-only accounts */}
              {site && tab === "checks" && <IndexChecks site={site} readOnly={viewer || !canChecks} />}
              {site && tab === "captures" && canCapture && <WeeklyCaptures site={site} />}

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
                  {/* social media: every network, the pages it sent visitors to, tagged links */}
                  <SocialTraffic key={`social-${ga4}-${days}-${compare}`} site={site} ga4={ga4} days={days} compare={compare} />
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

              {/* weekly report: its own properties and dates, independent of the top bar */}
              {tab === "weekly" && canWeekly && <WeeklyReport />}

              {/* Site investigation: the top bar's GA4 choice is a hint; the investigation checks it has data and finds the right one if not */}
              {site && tab === "audit" && canAudit && <Audit site={site} ga4={ga4} />}

              {/* Manage access: the two access admins manage who can sign in and what they can do (the API checks again) */}
              {tab === "access" && admin && <AccessManager />}
            </>
          )}
        </main>
      </SourcesProvider>

      {/* Read-only accounts: the URL report shows saved results only, no new inspections */}
      {!compareMode && lookup && gsc && (
        <UrlReport site={site} url={lookup} gsc={gsc} ga4={ga4} days={days} compare={compare} onClose={closeLookup} readOnly={viewer} />
      )}
    </>
  );
}
