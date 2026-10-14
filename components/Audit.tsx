// components/Audit.tsx
"use client";
// GSC audit (AI). Only the audit account (AUDIT_EMAILS, default hsingh@kingsresearch.com) sees this tab,
// and every API route behind it checks the account again. Issues and counts come from Google's data and
// the dashboard's own checks; GPT writes fixes; code + Jev (or a second GPT pass) double-check them.
import { useEffect, useRef, useState } from "react";
import { Kpis, Section, num } from "./ui";
import { WINDOWS, type Range } from "@/lib/dates";
import { kvGet, kvSet } from "@/lib/idb";
import { loadIndexCache, type IndexCache } from "@/lib/indexCache";
import { DAILY_INSPECTION_LIMIT, inspectAndStore, loadUrlList, quotaLeft } from "@/lib/checks";
import { CATALOG, STATUS_LABEL, type IssueGroup, type IssueType, type Severity, type Solution } from "@/lib/audit/catalog";
import { httpIssues, inspectionIssues, sortGroups, type HttpRow } from "@/lib/audit/rules";
import { auditReportHtml, downloadFile, downloadJson, fileSafe } from "@/lib/evidence";

type Access = { allowed: boolean; gpt?: boolean; jev?: boolean; gptModel?: string; jevModel?: string; maxGroups?: number };
type StepState = "todo" | "run" | "done" | "skip" | "error";
type Step = { label: string; state: StepState; note: string };
type AuditWindow = { days: number; current: Range; previous: Range; dataThrough: string };
type Collected = { window: AuditWindow; issues: IssueGroup[]; topPages: string[]; droppedPages: string[]; clicksByUrl: Record<string, number> };
type Spent = { gptIn: number; gptOut: number; jevIn: number; aiCalls: number; cached: number };

const SEV_TONE: Record<Severity, string> = { critical: "no", high: "no", medium: "warn", low: "info" };
const STATUS_TONE: Record<Solution["status"], string> = { verified: "ok", revised: "ok", standard: "info", needs_review: "warn", error: "no" };
const STEP_TONE: Record<StepState, string> = { todo: "info", run: "warn", done: "ok", skip: "info", error: "no" };
const UNIT: Partial<Record<IssueType, string>> = {
  cannibalization: "queries", sitemap_errors: "sitemaps", sitemap_warnings: "sitemaps", sitemap_stale: "sitemaps", no_sitemaps: "",
};
const STEPS = [
  "URL list (sitemaps + search pages)",
  "Search Console performance & Sitemaps report",
  "Live page checks (status, redirects, noindex, canonical, robots.txt)",
  "URL Inspection (Google's index status)",
  "Fixes: GPT writes, code + Jev double-check",
];
const FRESH_DAYS = 7;
const DAY = 864e5;
const TH: React.CSSProperties = { textAlign: "left", padding: 6, borderBottom: "1px solid var(--rule, #d5dbe1)", whiteSpace: "nowrap" };
const TD: React.CSSProperties = { textAlign: "left", padding: 6, borderBottom: "1px solid var(--rule, #e1e6eb)", verticalAlign: "top", overflowWrap: "anywhere" };

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

const forAi = (g: IssueGroup): IssueGroup => ({ ...g, urls: g.urls.slice(0, 300), evidence: g.evidence.slice(0, 15) });
const failed = (e: unknown): Solution => ({
  status: "error", summary: e instanceof Error ? e.message : "AI request failed", causes: [], steps: [], verify: [], examples: [], checks: [],
  usage: { gptIn: 0, gptOut: 0, jevIn: 0, gptCalls: 0, jevCalls: 0 }, models: [], generatedAt: new Date().toISOString(),
});
const isFresh = (c: IndexCache, u: string) => {
  const r = c.inspected[u];
  return !!r && r.verdict !== "ERROR" && Date.now() - Date.parse(r.checkedAt) < FRESH_DAYS * DAY;
};

export default function Audit({ site }: { site: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [days, setDays] = useState<number>(30);
  const [inspectN, setInspectN] = useState(200);
  const [httpN, setHttpN] = useState(1000);
  const [useAi, setUseAi] = useState(true);
  const [steps, setSteps] = useState<Step[]>([]);
  const [groups, setGroups] = useState<IssueGroup[]>([]);
  const [sols, setSols] = useState<Record<string, Solution>>({});
  const [win, setWin] = useState<AuditWindow | null>(null);
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
    setError("");
  }, [site]);

  if (!access) return <div className="notice">Checking access…</div>;
  if (!access.allowed) {
    return (
      <Section title="GSC audit (AI)" lede="AI-assisted audit of Search Console issues.">
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
    const st: Step[] = STEPS.map((label) => ({ label, state: "todo", note: "" }));
    let cur = 0;
    const upd = (i: number, p: Partial<Step>) => {
      cur = i;
      st[i] = { ...st[i], ...p };
      setSteps([...st]);
    };
    setSteps([...st]);
    let all: IssueGroup[] = [];
    const show = () => setGroups(sortGroups(all));

    try {
      // 1) URL list (reuses the Indexing tab's list if it's less than a day old)
      upd(0, { state: "run" });
      let cache = await loadIndexCache(site);
      if (!cache?.urls.length || Date.now() - Date.parse(cache.listedAt || "0") > DAY) cache = (await loadUrlList(site)).cache;
      const sitemapSet = new Set(cache.urls.filter((u) => u.sources.includes("sitemap")).map((u) => u.url));
      upd(0, { state: "done", note: `${num(cache.urls.length)} URLs, ${num(sitemapSet.size)} from sitemaps` });

      // 2) Search Console data for the window + Sitemaps report
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

      // 3) Live page checks: top sitemap pages first, then recently dropped pages, then the rest of the sitemaps
      upd(2, { state: "run" });
      const ordered = Array.from(new Set([...col.topPages.filter((u) => sitemapSet.has(u)), ...col.droppedPages, ...Array.from(sitemapSet)]));
      const targets = httpN ? ordered.slice(0, httpN) : ordered;
      const rows: HttpRow[] = [];
      for (let i = 0; i < targets.length && !stop.current; i += 25) {
        const r = await post<{ rows: HttpRow[] }>("/api/audit/http", { siteUrl: site, urls: targets.slice(i, i + 25) });
        rows.push(...r.rows);
        upd(2, { note: `${num(rows.length)} of ${num(targets.length)}` });
      }
      all = [...all, ...httpIssues(rows, sitemapSet, clicks)];
      show();
      upd(2, { state: "done", note: `${num(rows.length)} pages checked` });

      // 4) URL Inspection: reuse results from the last 7 days, spend quota only on the rest
      upd(3, { state: "run" });
      const want = Array.from(new Set([...col.droppedPages, ...col.topPages, ...Array.from(sitemapSet)]))
        .filter((u) => !isFresh(cache!, u))
        .slice(0, Math.min(inspectN, quotaLeft(site)));
      let checked = 0;
      for (let i = 0; i < want.length && !stop.current; i += 20) {
        const r = await inspectAndStore(site, want.slice(i, i + 20));
        checked += r.results.length;
        cache = r.cache;
        upd(3, { note: `${num(checked)} of ${num(want.length)} inspected` });
        if (r.quotaExceeded) break;
        if (r.rateLimited) await new Promise((res) => setTimeout(res, 60_000));
      }
      const recent = Object.values(cache.inspected).filter((r) => r.verdict !== "ERROR" && Date.now() - Date.parse(r.checkedAt) < FRESH_DAYS * DAY);
      all = [...all, ...inspectionIssues(recent, sitemapSet, clicks)];
      show();
      upd(3, { state: "done", note: `${num(recent.length)} pages with Google results from the last ${FRESH_DAYS} days (${num(checked)} checked now)` });

      // 5) Fixes for the most important groups (cached per issue + evidence for 7 days, so re-runs don't pay twice)
      if (!useAi || !access.gpt) {
        upd(4, { state: "skip", note: access.gpt ? "turned off: standard fixes shown" : "OPENAI_API_KEY isn't set: standard fixes shown" });
      } else {
        upd(4, { state: "run" });
        const targetsAi = sortGroups(all).slice(0, access.maxGroups || 15);
        const out: Record<string, Solution> = {};
        const s: Spent = { gptIn: 0, gptOut: 0, jevIn: 0, aiCalls: 0, cached: 0 };
        for (const [i, gr] of targetsAi.entries()) {
          if (stop.current) break;
          const key = `dash:audit:${site}:${gr.fingerprint}`;
          const hit = await kvGet<{ at: number; sol: Solution }>(key).catch(() => undefined);
          if (hit && Date.now() - hit.at < FRESH_DAYS * DAY) {
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
          upd(4, { note: `${i + 1} of ${targetsAi.length} issue groups` });
        }
        upd(4, { state: "done" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
      upd(cur, { state: "error" });
    }
    setRunning(false);
  };

  const sev = (s: Severity) => num(groups.filter((g) => g.severity === s).length);
  const affected = new Set(groups.filter((g) => g.type !== "cannibalization").flatMap((g) => g.urls)).size;
  const verified = Object.values(sols).filter((s) => s.status === "verified" || s.status === "revised").length;
  const review = Object.values(sols).filter((s) => s.status === "needs_review" || s.status === "error").length;
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <Section
      title="GSC audit (AI)"
      lede="Finds the issues Google reports for this property and gives a fix for each group. Issues and counts come only from Google's APIs (Search Analytics, Sitemaps, URL Inspection) and this dashboard's own live page checks — never from the AI. GPT writes the fix; code checks it uses only URLs and numbers from the data and gives no unsafe advice; Jev (or a second GPT pass) checks it's grounded, on-topic, safe and actionable. Anything that fails is marked “needs human review”."
    >
      <div className="panel">
        <div className="row">
          <label className="control">
            Window
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={running}>
              {WINDOWS.map((d) => (
                <option key={d} value={d}>Last {d} days vs previous {d}</option>
              ))}
            </select>
          </label>
          <label className="control">
            New URL Inspections
            <select value={inspectN} onChange={(e) => setInspectN(Number(e.target.value))} disabled={running}>
              {[0, 100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>{n ? num(n) : "None (reuse saved results)"}</option>
              ))}
            </select>
          </label>
          <label className="control">
            Live page checks
            <select value={httpN} onChange={(e) => setHttpN(Number(e.target.value))} disabled={running}>
              {[200, 500, 1000, 2000, 0].map((n) => (
                <option key={n} value={n}>{n ? num(n) : "All sitemap URLs"}</option>
              ))}
            </select>
          </label>
          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={useAi && !!access.gpt} onChange={(e) => setUseAi(e.target.checked)} disabled={running || !access.gpt} />
            AI fixes ({access.gpt ? access.gptModel : "no OpenAI key"}
            {access.jev ? ` + ${access.jevModel} checks` : access.gpt ? ", no Jev key: GPT reviews itself" : ""})
          </label>
          <button className="btn primary" onClick={run} disabled={running}>{running ? "Running…" : "Run audit"}</button>
          {running && <button className="btn" onClick={() => (stop.current = true)}>Stop</button>}
          {groups.length > 0 && !running && (
            <>
              <button className="btn" onClick={() => downloadFile(`gsc-audit-${fileSafe(site)}-${stamp}.html`, auditReportHtml({ site, window: win, groups, sols }), "text/html")}>
                Download report
              </button>
              <button className="btn" onClick={() => downloadJson(`gsc-audit-${fileSafe(site)}-${stamp}.json`, { site, window: win, generatedAt: new Date().toISOString(), groups, solutions: sols })}>
                Download data
              </button>
            </>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          URL Inspection left today: {num(quotaLeft(site))} of {num(DAILY_INSPECTION_LIMIT)} (shared with the Indexing tab and the Live index monitor).
          Live page checks and Search Console data are free; only the AI step costs money.
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
          <h4>Evidence (first {g.evidence.length} of {num(g.count)})</h4>
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
