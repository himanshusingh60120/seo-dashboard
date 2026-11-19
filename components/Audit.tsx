// components/Audit.tsx
"use client";
// Site investigation (replaces the GSC audit). Only the audit account (AUDIT_EMAILS, default hsingh@kingsresearch.com)
// sees this tab, and every API route behind it checks the account again.
//  0. Quick investigation (/api/audit/investigate): GA4 pairing and traffic quality, Search Console trend, Google search vs
//     GA4, Page indexing and Crawl stats captures, sitemap setup, address variants, and a timeline of when things changed.
//  1. Search Console performance issues and the Sitemaps report.
//  2. Google's index status for every tracked URL, read from the daily index checks' Sheet. This tab never runs URL
//     Inspection itself, so it never spends Google's daily inspection quota.
//  3–4, 6. Full mode only: URL list (only when the daily checks have none), live page checks, deep crawl.
//  5. Googlebot crawl activity (last-crawl dates saved by the daily index checks).
//  7. Fixes: GPT writes, code + Jev double-check. Issues and counts never come from the AI.
import { useEffect, useRef, useState } from "react";
import { Kpis, PanelTitle, Section, num } from "./ui";
import AuditCrawl from "./AuditCrawl";
import { WINDOWS, type Range } from "@/lib/dates";
import { kvGet, kvSet } from "@/lib/idb";
import { loadIndexCache } from "@/lib/indexCache";
import { loadUrlList } from "@/lib/checks";
import { CATALOG, STATUS_LABEL, type IssueGroup, type IssueType, type Severity, type Solution } from "@/lib/audit/catalog";
import { httpIssues, inspectionIssues, sortGroups, type HttpRow } from "@/lib/audit/rules";
import {
  crawlActivity, crawlResults, mergeHistory, planCrawl, SOURCES_KEPT,
  type Activity, type CrawlHistory, type CrawlPage, type CrawlReport, type CrawlRow, type Inlink,
} from "@/lib/audit/crawl";
import { stripVerify, withVerifyLinks } from "@/lib/audit/verify";
import { normalizeUrl } from "@/lib/url";
import { auditReportHtml, downloadFile, downloadJson, fileSafe } from "@/lib/evidence";
import type { Inspection } from "@/lib/types";
import type { Investigation, InvestigationCheck, TimelineEvent } from "@/lib/investigate";
import type { IndexResults } from "@/lib/indexSheet";

type Access = { allowed: boolean; gpt?: boolean; jev?: boolean; gptModel?: string; jevModel?: string; maxGroups?: number };
type StepState = "todo" | "run" | "done" | "skip" | "error";
type Step = { label: string; state: StepState; note: string };
type AuditWindow = { days: number; current: Range; previous: Range; dataThrough: string };
type Collected = { window: AuditWindow; issues: IssueGroup[]; topPages: string[]; droppedPages: string[]; clicksByUrl: Record<string, number> };
type Spent = { gptIn: number; gptOut: number; jevIn: number; aiCalls: number; cached: number };
type Mode = "quick" | "full";

const SEV_TONE: Record<Severity, string> = { critical: "no", high: "no", medium: "warn", low: "info" };
const STATUS_TONE: Record<Solution["status"], string> = { verified: "ok", revised: "ok", standard: "info", needs_review: "warn", error: "no" };
const STEP_TONE: Record<StepState, string> = { todo: "info", run: "warn", done: "ok", skip: "info", error: "no" };
const LEVEL_TONE: Record<TimelineEvent["level"], string> = { problem: "no", watch: "warn", info: "info" };
/** What a group's count means; "" = no count shown. Anything not listed counts URLs. */
const UNIT: Partial<Record<IssueType, string>> = {
  cannibalization: "queries", sitemap_errors: "sitemaps", sitemap_warnings: "sitemaps", sitemap_stale: "sitemaps", no_sitemaps: "",
  ga4_pairing: "", bot_traffic: "signs", foreign_hostnames: "hostnames", low_quality_sources: "sources", search_vs_traffic: "",
  clicks_decline: "", index_drop: "", index_reasons_growth: "reasons", captures_stale: "", crawl_drop: "", crawl_slow: "",
  sitemaps_unread: "sitemaps", sitemap_index_missing: "sitemaps", sitemap_thin_sections: "sitemaps", sitemap_no_lastmod: "", host_variants: "addresses",
};
const STEPS = [
  "Quick investigation (GA4 traffic quality, Search Console trend, indexing and crawl captures, sitemaps, address variants)",
  "Search Console performance & Sitemaps report",
  "Google's index status (saved by the daily index checks)",
  "URL list (only when the daily index checks have none)",
  "Live page checks (status, redirects, noindex, canonical, robots.txt)",
  "Googlebot crawl activity (last-crawl dates saved by the daily index checks)",
  "Deep crawl (internal links, links to redirects)",
  "Fixes: GPT writes, code + Jev double-check",
];
const AI_CACHE_DAYS = 7;
const DAY = 864e5;
const MAX_INDEX_PAGES = 60;
const CRAWL_BATCH = 8;
const CRAWL_PARALLEL = 2;
const MAX_QUEUED = 200_000;
const TH: React.CSSProperties = { textAlign: "left", padding: 6, borderBottom: "1px solid var(--rule, #d5dbe1)", whiteSpace: "nowrap" };
const TD: React.CSSProperties = { textAlign: "left", padding: 6, borderBottom: "1px solid var(--rule, #e1e6eb)", verticalAlign: "top", overflowWrap: "anywhere" };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

/** Google's own URL Inspection page for a URL (opens the latest result in Search Console). */
const inspectLink = (site: string, url: string) =>
  `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(site)}&id=${encodeURIComponent(url)}`;

const forAi = (g: IssueGroup): IssueGroup => stripVerify({ ...g, urls: g.urls.slice(0, 300), evidence: g.evidence.slice(0, 15) });

const failed = (e: unknown): Solution => ({
  status: "error", summary: e instanceof Error ? e.message : "AI request failed", causes: [], steps: [], verify: [], examples: [], checks: [],
  usage: { gptIn: 0, gptOut: 0, jevIn: 0, gptCalls: 0, jevCalls: 0 }, models: [], generatedAt: new Date().toISOString(),
});

export default function Audit({ site, ga4 = "" }: { site: string; ga4?: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [mode, setMode] = useState<Mode>("quick");
  const [days, setDays] = useState<number>(30);
  const [httpN, setHttpN] = useState(1000);
  const [crawlN, setCrawlN] = useState(5000);
  const [useAi, setUseAi] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);
  const [groups, setGroups] = useState<IssueGroup[]>([]);
  const [sols, setSols] = useState<Record<string, Solution>>({});
  const [win, setWin] = useState<AuditWindow | null>(null);
  const [crawl, setCrawl] = useState<CrawlReport | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [invChecks, setInvChecks] = useState<InvestigationCheck[]>([]);
  const [invGa4, setInvGa4] = useState<Investigation["ga4"]>(null);
  const [spent, setSpent] = useState<Spent>({ gptIn: 0, gptOut: 0, jevIn: 0, aiCalls: 0, cached: 0 });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const stop = useRef(false);

  useEffect(() => {
    fetch("/api/audit/access", { cache: "no-store" })
      .then((r) => r.json())
      .then(setAccess)
      .catch(() => setAccess({ allowed: false }));
  }, []);

  useEffect(() => {
    setGroups([]);
    setSols({});
    setSteps([]);
    setWin(null);
    setCrawl(null);
    setActivity(null);
    setTimeline([]);
    setInvChecks([]);
    setInvGa4(null);
    setError("");
  }, [site]);

  if (!access) return <div className="notice">Checking access…</div>;
  if (!access.allowed) {
    return (
      <Section title="Site investigation" lede="Investigation of a property's Search Console, GA4 and site health.">
        <div className="notice">This tool is limited to the audit account.</div>
      </Section>
    );
  }

  const run = async () => {
    stop.current = false;
    setRunning(true);
    setError("");
    setGroups([]);
    setSols({});
    setWin(null);
    setCrawl(null);
    setActivity(null);
    setTimeline([]);
    setInvChecks([]);
    setInvGa4(null);
    const quick = mode === "quick";
    const st: Step[] = STEPS.map((label) => ({ label, state: "todo", note: "" }));
    let cur = 0;
    const upd = (i: number, p: Partial<Step>) => {
      cur = i;
      st[i] = { ...st[i], ...p };
      setSteps([...st]);
    };
    setSteps([...st]);
    let all: IssueGroup[] = [];
    let inv: IssueGroup[] = [];
    const inspMap: Record<string, Inspection> = {};
    // Audit groups get verification links; investigation groups carry their own where_to_check column.
    const show = () => setGroups(sortGroups([...withVerifyLinks(all, site, inspMap), ...inv]));

    try {
      // 0) Quick investigation
      upd(0, { state: "run" });
      try {
        const q = await post<Investigation>("/api/audit/investigate", { siteUrl: site, ga4 });
        inv = q.groups;
        setTimeline(q.timeline);
        setInvChecks(q.checks);
        setInvGa4(q.ga4);
        show();
        upd(0, { state: "done", note: `${num(q.groups.length)} finding(s) from ${num(q.checks.length)} checks${q.ga4 ? ` · GA4: ${q.ga4.name}` : ""}` });
      } catch (e) {
        upd(0, { state: "error", note: e instanceof Error ? e.message : "Investigation failed" });
      }

      // 1) Search Console data for the window + Sitemaps report
      upd(1, { state: "run" });
      const col = await post<Collected>("/api/audit/collect", { siteUrl: site, days });
      setWin(col.window);
      all = [...col.issues];
      show();
      upd(1, {
        state: "done",
        note: `${col.window.current.startDate} → ${col.window.current.endDate} vs ${col.window.previous.startDate} → ${col.window.previous.endDate} (data complete through ${col.window.dataThrough})`,
      });
      const clicks = new Map(Object.entries(col.clicksByUrl));

      // 2) Google's index status, from the daily index checks' Sheet (no URL Inspection here)
      upd(2, { state: "run" });
      const sitemapSet = new Set<string>();
      let listed = 0;
      let withResult = 0;
      let from = "";
      let to = "";
      let configured = true;
      let job: IndexResults["job"] = null;
      for (let offset = 0, page = 0; page < MAX_INDEX_PAGES && !stop.current; page++) {
        const r = await get<IndexResults>(`/api/audit/index-results?site=${encodeURIComponent(site)}&offset=${offset}`);
        if (!r.configured) {
          configured = false;
          break;
        }
        if (r.job) job = r.job;
        for (const [url, status, coverage, fetchState, lastCrawl, canonical, inspected, inSm] of r.rows) {
          listed++;
          if (inSm) sitemapSet.add(url);
          if (!status) continue;
          withResult++;
          const d = inspected.slice(0, 10);
          if (d && (!from || d < from)) from = d;
          if (d > to) to = d;
          inspMap[url] = {
            url, verdict: status === "Indexed" ? "PASS" : "NEUTRAL", coverageState: coverage, indexingState: "",
            pageFetchState: fetchState, robotsTxtState: "", lastCrawlTime: lastCrawl, googleCanonical: canonical, userCanonical: "",
            crawledAs: "", sitemaps: [], referringUrls: [], richIssues: [], link: inspectLink(site, url),
            checkedAt: inspected || new Date(0).toISOString(),
          } as Inspection;
        }
        upd(2, { note: `${num(listed)} tracked URLs read` });
        if (r.done) break;
        offset = r.next;
      }
      const inspAll = Object.values(inspMap);
      if (!configured) {
        upd(2, { state: "skip", note: "Daily index checks aren't on for this property. Start them in the Index checks tab; this step then uses their results." });
      } else {
        all = [...all, ...inspectionIssues(inspAll, sitemapSet, clicks)];
        show();
        upd(2, {
          state: "done",
          note:
            `${num(withResult)} of ${num(listed)} tracked URLs have Google's result` +
            (from ? ` (checked ${from === to ? from : `${from} to ${to}`})` : "") +
            (job && !job.enabled ? " · daily checks are paused" : "") +
            (job?.stats?.cycleDays ? ` · each URL is re-checked about every ${job.stats.cycleDays} days` : ""),
        });
      }

      // 3) URL list: only when the daily index checks gave no sitemap URLs (full mode)
      if (quick) {
        upd(3, { state: "skip", note: "quick mode" });
      } else if (sitemapSet.size) {
        upd(3, { state: "skip", note: `${num(sitemapSet.size)} sitemap URLs from the daily index checks` });
      } else {
        upd(3, { state: "run" });
        let cache = await loadIndexCache(site);
        if (!cache?.urls.length || Date.now() - Date.parse(cache.listedAt || "0") > DAY) cache = (await loadUrlList(site)).cache;
        cache.urls.filter((u) => u.sources.includes("sitemap")).forEach((u) => sitemapSet.add(u.url));
        upd(3, { state: "done", note: `${num(sitemapSet.size)} URLs from sitemaps` });
      }

      // 4) Live page checks (full mode): top sitemap pages first, then recently dropped pages, then the rest
      if (quick) {
        upd(4, { state: "skip", note: "quick mode: choose Full to run it" });
      } else {
        upd(4, { state: "run" });
        const ordered = Array.from(new Set([...col.topPages.filter((u) => sitemapSet.has(u)), ...col.droppedPages, ...Array.from(sitemapSet)]));
        const targets = httpN ? ordered.slice(0, httpN) : ordered;
        const rows: HttpRow[] = [];
        for (let i = 0; i < targets.length && !stop.current; i += 25) {
          const r = await post<{ rows: HttpRow[] }>("/api/audit/http", { siteUrl: site, urls: targets.slice(i, i + 25) });
          rows.push(...r.rows);
          upd(4, { note: `${num(rows.length)} of ${num(targets.length)}` });
        }
        all = [...all, ...httpIssues(rows, sitemapSet, clicks)];
        show();
        upd(4, { state: "done", note: `${num(rows.length)} pages checked` });
      }

      // 5) Googlebot crawl activity: last-crawl dates saved by the daily index checks, remembered across runs
      if (!inspAll.length) {
        upd(5, { state: "skip", note: "no saved results from the daily index checks" });
      } else {
        upd(5, { state: "run" });
        const histKey = `dash:crawlhist:${site}`;
        const prevHist = (await kvGet<CrawlHistory>(histKey).catch(() => undefined)) || null;
        const hist = mergeHistory(prevHist, inspAll);
        await kvSet(histKey, hist).catch(() => {});
        const act = crawlActivity(inspAll, hist);
        setActivity(act);
        upd(5, {
          state: "done",
          note: `${num(act.inspected)} URLs: ${num(act.d1 + act.d7)} crawled within 7 days of their check, ${num(act.never)} never crawled, ${num(act.recrawled)} seen recrawled since ${act.since || "today"}`,
        });
      }

      // 6) Deep crawl (full mode). Starts from the homepage, top pages and sitemap pages and follows internal links.
      if (quick || !crawlN || stop.current) {
        upd(6, { state: "skip", note: quick ? "quick mode: choose Full to run it" : crawlN ? "stopped" : "turned off" });
      } else {
        upd(6, { state: "run" });
        try {
          const plan = planCrawl(site, [], col.topPages, Array.from(sitemapSet));
          const pages = new Map<string, CrawlPage>();
          const inlinks = new Map<string, Inlink>();
          const found = new Set<string>();
          const refChecked = new Set<string>();
          const hi: string[] = plan.refs.slice();
          const lo: string[] = plan.seeds;
          const queued = new Set<string>([...hi, ...lo]);
          const retries = new Map<string, number>();
          let hiPos = 0;
          let loPos = 0;
          const left = () => hi.length - hiPos + (lo.length - loPos);
          const addLink = (fromPage: string, toUrl: string) => {
            const e = inlinks.get(toUrl) || { count: 0, from: [] };
            e.count++;
            if (e.from.length < SOURCES_KEPT && e.from.indexOf(fromPage) < 0) e.from.push(fromPage);
            inlinks.set(toUrl, e);
            if (!queued.has(toUrl) && queued.size < MAX_QUEUED) {
              queued.add(toUrl);
              hi.push(toUrl);
            }
          };
          const take = (): string[] => {
            const b: string[] = [];
            while (b.length < CRAWL_BATCH && hiPos < hi.length) b.push(hi[hiPos++]);
            while (b.length < CRAWL_BATCH && loPos < lo.length) b.push(lo[loPos++]);
            return b;
          };
          while (left() > 0 && pages.size < crawlN && !stop.current) {
            const batches: string[][] = [];
            for (let p = 0; p < CRAWL_PARALLEL; p++) {
              const b = take();
              if (b.length) batches.push(b);
            }
            const results = await Promise.all(batches.map((b) => post<{ rows: CrawlRow[] }>("/api/audit/crawl", { siteUrl: site, urls: b })));
            for (const res of results) {
              for (const row of res.rows) {
                if (row.skipped) {
                  const n = (retries.get(row.url) || 0) + 1;
                  retries.set(row.url, n);
                  if (n < 3) hi.push(row.url);
                  continue;
                }
                const page: CrawlPage = {
                  url: row.url, status: row.status, chain: row.chain, finalUrl: row.finalUrl, redirects: row.redirects,
                  loop: row.loop, robotsBlocked: row.robotsBlocked, inconclusive: row.inconclusive, error: row.error,
                };
                pages.set(row.url, page);
                const src = normalizeUrl(row.finalUrl || row.url);
                if (row.redirects > 0 && src !== row.url && row.status === 200 && !pages.has(src)) {
                  pages.set(src, { ...page, url: src, chain: "200", finalUrl: src, redirects: 0 });
                  queued.add(src);
                }
                row.links.forEach((l) => addLink(src, l));
              }
            }
            upd(6, { note: `${num(pages.size)} pages fetched, ${num(left())} queued (limit ${num(crawlN)})` });
          }
          const out = crawlResults({
            siteUrl: site, pages, inlinks, inspections: [], found, refChecked,
            sitemap: sitemapSet, limit: crawlN, queuedLeft: left(),
          });
          setCrawl(out.report);
          all = [...all, ...out.groups];
          show();
          upd(6, {
            state: "done",
            note: `${num(out.report.fetched)} pages: ${num(out.report.brokenRows.length)} broken-link sources, ${num(out.report.redirectRows.length)} links to redirects`,
          });
        } catch (e) {
          upd(6, { state: "error", note: e instanceof Error ? e.message : "Crawl failed" });
        }
      }

      // 7) Fixes for the most important groups (cached per issue + evidence for 7 days)
      if (!useAi || !access.gpt) {
        upd(7, { state: "skip", note: access.gpt ? "turned off: standard fixes shown" : "OPENAI_API_KEY isn't set: standard fixes shown" });
      } else {
        upd(7, { state: "run" });
        const targetsAi = sortGroups([...all, ...inv]).slice(0, access.maxGroups || 15);
        const out: Record<string, Solution> = {};
        const s: Spent = { gptIn: 0, gptOut: 0, jevIn: 0, aiCalls: 0, cached: 0 };
        for (const [i, gr] of targetsAi.entries()) {
          if (stop.current) break;
          const key = `dash:audit:${site}:${gr.fingerprint}`;
          const hit = await kvGet<{ at: number; sol: Solution }>(key).catch(() => undefined);
          if (hit && Date.now() - hit.at < AI_CACHE_DAYS * DAY) {
            out[gr.fingerprint] = hit.sol;
            s.cached++;
          } else {
            try {
              const sol = await post<Solution>("/api/audit/solve", { siteUrl: site, group: forAi(gr) });
              out[gr.fingerprint] = sol;
              s.gptIn += sol.usage.gptIn;
              s.gptOut += sol.usage.gptOut;
              s.jevIn += sol.usage.jevIn;
              s.aiCalls += sol.usage.gptCalls + sol.usage.jevCalls;
              await kvSet(key, { at: Date.now(), sol }).catch(() => {});
            } catch (e) {
              out[gr.fingerprint] = failed(e);
            }
          }
          setSols({ ...out });
          setSpent({ ...s });
          upd(7, { note: `${i + 1} of ${targetsAi.length} issue groups` });
        }
        upd(7, { state: "done" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Investigation failed");
      upd(cur, { state: "error" });
    }
    setRunning(false);
  };

  const sev = (s: Severity) => num(groups.filter((g) => g.severity === s).length);
  const affected = new Set(groups.filter((g) => (UNIT[g.type] ?? "URLs") === "URLs").flatMap((g) => g.urls)).size;
  const verified = Object.values(sols).filter((s) => s.status === "verified" || s.status === "revised").length;
  const review = Object.values(sols).filter((s) => s.status === "needs_review" || s.status === "error").length;
  const stamp = new Date().toISOString().slice(0, 10);
  const full = mode === "full";

  return (
    <Section
      title="Site investigation"
      lede="Investigates one property end to end: whether GA4 traffic is real readers, how Google Search is trending, which pages Google has indexed or dropped (from the daily index checks), whether Googlebot is crawling less, how the sitemaps and addresses are set up, and (in Full mode) live page checks and a deep crawl. A timeline links changes by date. Findings and counts come only from Google's data, the extension's Search Console captures and this dashboard's own checks; GPT writes the fixes, and code plus Jev (or a second GPT pass) check them."
    >
      <div className="panel">
        <div className="row">
          <label className="control">
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={running}>
              <option value="quick">Quick (about a minute)</option>
              <option value="full">Full (adds live page checks and the deep crawl)</option>
            </select>
          </label>
          <label className="control">
            Search Console window
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={running}>
              {WINDOWS.filter((d) => d <= 30).map((d) => (
                <option key={d} value={d}>Last {d} days vs previous {d}</option>
              ))}
            </select>
          </label>
          {full && (
            <>
              <label className="control">
                Live page checks
                <select value={httpN} onChange={(e) => setHttpN(Number(e.target.value))} disabled={running}>
                  {[200, 500, 1000, 2000, 0].map((n) => (
                    <option key={n} value={n}>{n ? num(n) : "All sitemap URLs"}</option>
                  ))}
                </select>
              </label>
              <label className="control">
                Deep crawl
                <select value={crawlN} onChange={(e) => setCrawlN(Number(e.target.value))} disabled={running}>
                  {[0, 500, 2000, 5000, 20000].map((n) => (
                    <option key={n} value={n}>{n ? `${num(n)} pages` : "Off"}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={useAi && !!access.gpt} onChange={(e) => setUseAi(e.target.checked)} disabled={running || !access.gpt} />
            AI fixes ({access.gpt ? access.gptModel : "no OpenAI key"}
            {access.jev ? ` + ${access.jevModel} checks` : access.gpt ? ", no Jev key: GPT reviews itself" : ""})
          </label>
          <button className="btn primary" onClick={run} disabled={running}>{running ? "Running…" : "Run investigation"}</button>
          {running && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {groups.length > 0 && !running && (
            <>
              <button className="btn" onClick={() => downloadFile(`site-investigation-${fileSafe(site)}-${stamp}.html`, auditReportHtml({ site, window: win, groups, sols }), "text/html")}>
                Download report
              </button>
              <button
                className="btn"
                onClick={() =>
                  downloadJson(`site-investigation-${fileSafe(site)}-${stamp}.json`, {
                    site, window: win, generatedAt: new Date().toISOString(), ga4: invGa4, timeline, checks: invChecks,
                    groups, solutions: sols, crawl, crawlActivity: activity,
                  })
                }
              >
                Download data
              </button>
            </>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Google's index status comes from the daily index checks, and the indexing and crawl trends from the Chrome extension's latest
          captures, so keep both running for current numbers. Only the AI step costs money.
        </p>
        {steps.length > 0 && (
          <ol className="muted" style={{ marginBottom: 0 }}>
            {steps.map((s) => (
              <li key={s.label}>
                <span className={`pill ${STEP_TONE[s.state]}`}>{s.state}</span> {s.label}
                {s.note ? ` — ${s.note}` : ""}
              </li>
            ))}
          </ol>
        )}
        {error && <div className="notice error">{error}</div>}
      </div>

      {(timeline.length > 0 || invChecks.length > 0) && (
        <div className="grid-2" style={{ marginTop: 16, alignItems: "start" }}>
          <div className="panel">
            <PanelTitle>Timeline</PanelTitle>
            <p className="muted" style={{ marginTop: 0 }}>When things changed, from every source, so related problems can be read together.</p>
            {timeline.length ? (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {timeline.map((t, i) => (
                    <tr key={i}>
                      <td style={{ ...TD, whiteSpace: "nowrap" }}>{t.date}</td>
                      <td style={TD}>
                        <span className={`pill ${LEVEL_TONE[t.level]}`}>{t.source}</span> {t.what}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No sharp changes found in the last 90 days.</p>
            )}
          </div>
          <div className="panel">
            <PanelTitle>What was checked</PanelTitle>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
              {invChecks.map((c) => (
                <li key={c.name}>
                  <b>{c.name}:</b> {c.result}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Kpis
            items={[
              { label: "Critical", value: sev("critical") },
              { label: "High", value: sev("high") },
              { label: "Medium", value: sev("medium") },
              { label: "Low", value: sev("low") },
              { label: "URLs affected", value: num(affected) },
              { label: "AI fixes verified", value: `${num(verified)} / ${num(Object.keys(sols).length)}`, sub: review ? `${num(review)} need human review` : undefined },
              {
                label: "AI tokens this run",
                value: num(spent.gptIn + spent.gptOut + spent.jevIn),
                sub: `GPT ${num(spent.gptIn)} in / ${num(spent.gptOut)} out · Jev ${num(spent.jevIn)} in${spent.cached ? ` · ${num(spent.cached)} reused` : ""}`,
              },
            ]}
          />
        </div>
      )}

      <AuditCrawl report={crawl} activity={activity} />

      {groups.map((g) => (
        <IssueCard key={g.fingerprint} g={g} sol={sols[g.fingerprint]} />
      ))}

      {!running && steps.length > 0 && !groups.length && !error && (
        <div className="notice" style={{ marginTop: 16 }}>No issues found with these settings.</div>
      )}
    </Section>
  );
}

function IssueCard({ g, sol }: { g: IssueGroup; sol?: Solution }) {
  const c = CATALOG[g.type];
  const ai = sol && sol.status !== "error" ? sol : null;
  const show = ai || { summary: c.what, causes: c.causes, steps: c.steps, verify: c.verify, checks: [], models: [] as string[] };
  const cols = g.evidence.length ? Object.keys(g.evidence[0]) : [];
  const unit = UNIT[g.type] ?? "URLs";
  const cell = (v: unknown) =>
    typeof v === "string" && /^https?:\/\//i.test(v) ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : String(v ?? "");

  return (
    <details className="panel" style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer" }}>
        <span className={`pill ${SEV_TONE[g.severity]}`}>{g.severity}</span> <b>{g.title}</b>
        {unit !== "" && <> — {num(g.count)} {unit}</>} <span className="muted">· {g.category} · {g.source}</span>{" "}
        <span className={`pill ${sol ? STATUS_TONE[sol.status] : "info"}`}>{sol ? STATUS_LABEL[sol.status] : "Standard fix"}</span>
      </summary>
      <p>{c.what}</p>
      {sol?.status === "error" && <div className="notice error">AI failed: {sol.summary}. Showing the standard fix.</div>}
      {ai && ai.status !== "standard" && (
        <p>
          <b>Summary:</b> {ai.summary}
        </p>
      )}
      <h4>Likely causes</h4>
      <ul>{show.causes.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <h4>Fix</h4>
      <ol>{show.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>
      <h4>Confirm the fix</h4>
      <ul>{show.verify.map((x, i) => <li key={i}>{x}</li>)}</ul>
      {ai && ai.checks.length > 0 && (
        <>
          <h4>Checks run on this answer</h4>
          <ul>
            {ai.checks.map((k, i) => (
              <li key={i}>
                <span className={`pill ${k.passed ? "ok" : "no"}`}>{k.passed ? "pass" : "fail"}</span> {k.name} — <span className="muted">{k.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {ai && ai.models.length > 0 && <p className="muted">Models used: {ai.models.join(" + ")}</p>}
      {c.doc && (
        <p>
          <a href={c.doc} target="_blank" rel="noreferrer">Google's documentation</a>
        </p>
      )}
      {cols.length > 0 && (
        <>
          <h4>
            Evidence (first {num(g.evidence.length)} rows{unit !== "" ? ` · ${num(g.count)} ${unit}` : ""})
          </h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>{cols.map((k) => <th key={k} style={TH}>{k}</th>)}</tr>
              </thead>
              <tbody>
                {g.evidence.map((r, i) => (
                  <tr key={i}>{cols.map((k) => <td key={k} style={TD}>{cell(r[k])}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {g.urls.length > g.evidence.length && <p className="muted">All {num(g.urls.length)} URLs are in “Download data”.</p>}
    </details>
  );
}
