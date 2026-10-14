// components/IndexMonitor.tsx
"use client";
// The Live index monitor (replaces the old Deindexed pages tab). The engine is in lib/monitor.ts and keeps running
// while you use other tabs. Status changes come from comparing successive URL Inspection results per URL.
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataTable, Kpis, Section, SubTabs, num } from "./ui";
import { EVENT_LABEL, isIndexedVerdict, loadEvents, peekIndexCache, type IndexEvent } from "@/lib/indexCache";
import { monitorPrefs, saveMonitorPrefs, useMonitor, type Phase } from "@/lib/monitor";
import { DAILY_INSPECTION_LIMIT, loadUrlList, quotaUsed } from "@/lib/checks";
import { WINDOWS } from "@/lib/dates";
import { downloadFile, eventsReportHtml, fileSafe } from "@/lib/evidence";

type View = "events" | "suspected";
type EventRow = { at: string; type: string; url: string; from: string; to: string; link: string; kind: IndexEvent["type"] };
type SuspectRow = { url: string; baselineAvg: number; baselineDays: number; lastSeen: string; inspection: string };

const TONE: Record<IndexEvent["type"], string> = { deindexed: "no", fetch_error: "no", canonical_changed: "warn", indexed: "ok", recovered: "ok" };
const PHASE: Record<Phase, string> = {
  idle: "Idle", signal: "Reading fresh data", inspecting: "Inspecting", waiting: "Waiting",
  quota: "Daily budget used", locked: "Running in another tab", error: "Error",
};
const BUDGETS = [500, 1000, 1500, 1900];

export default function IndexMonitor({ site }: { site: string }) {
  const [state, monitor] = useMonitor();
  const [days, setDays] = useState<number>(7);
  const [budget, setBudget] = useState(1500);
  const [events, setEvents] = useState<IndexEvent[]>([]);
  const [view, setView] = useState<View>("events");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState("default");
  const mine = state.site === site;
  const running = state.running && mine;

  useEffect(() => {
    setBudget(monitorPrefs().budget);
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
  }, []);

  // Reload saved changes whenever the engine records new ones (the Indexing tab and the audit add to them too)
  useEffect(() => {
    loadEvents(site).then(setEvents);
  }, [site, state.recentEvents]);

  const toggle = () => {
    if (running) {
      monitor.stop();
      saveMonitorPrefs(site, false, budget);
    } else {
      monitor.start(site, budget);
      saveMonitorPrefs(site, true, budget);
    }
  };
  const changeBudget = (n: number) => {
    setBudget(n);
    saveMonitorPrefs(site, running, n);
    if (running) monitor.setBudget(n);
  };
  const askNotify = async () => {
    if (typeof Notification !== "undefined") setPerm(await Notification.requestPermission());
  };
  const refreshNow = async () => {
    setBusy(true);
    setMsg("");
    try {
      await monitor.refreshSignal(site);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't read fresh data");
    }
    setBusy(false);
  };
  const reloadList = async () => {
    setBusy(true);
    setMsg("Reading sitemaps…");
    try {
      setMsg((await loadUrlList(site)).message);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't load the URL list");
    }
    setBusy(false);
  };

  const fresh = mine ? state.fresh : null;
  const used = mine && state.running ? state.used : quotaUsed(site);
  const cutoff = Date.now() - days * 864e5;
  const inWindow = events.filter((e) => Date.parse(e.at) >= cutoff).sort((a, b) => b.at.localeCompare(a.at));
  const count = (t: IndexEvent["type"]) => inWindow.filter((e) => e.type === t).length;
  const cache = peekIndexCache(site);
  const status = (u: string) => {
    const r = cache?.inspected[u];
    if (!r) return "Not inspected yet (queued first)";
    if (r.verdict === "ERROR") return "Last check failed (will retry)";
    return `${isIndexedVerdict(r.verdict) ? "Indexed" : "NOT indexed"} · ${r.coverageState} · ${new Date(r.checkedAt).toLocaleString()}`;
  };

  const eventRows: EventRow[] = inWindow.map((e) => ({
    at: new Date(e.at).toLocaleString(), type: EVENT_LABEL[e.type], url: e.url, from: e.from, to: e.to, link: e.link, kind: e.type,
  }));
  const suspectRows: SuspectRow[] = (fresh?.suspected || []).map((p) => ({
    url: p.page, baselineAvg: p.baselineAvg, baselineDays: p.baselineDays, lastSeen: p.lastSeen || "–", inspection: status(p.page),
  }));
  const hours = (fresh?.hourly || []).map((h) => ({
    label: new Date(h.hour).toLocaleString([], { day: "2-digit", hour: "2-digit" }),
    impressions: h.impressions,
    clicks: h.clicks,
  }));

  return (
    <Section
      title="Live index monitor"
      lede="Watches indexing while this dashboard is open in a browser tab. Every 15 minutes it reads Search Console's fresh data (a few hours behind) to spot pages that suddenly stopped getting impressions, and it keeps re-checking pages with the URL Inspection API in priority order: suspected drops first, then failed checks, new sitemap URLs, top pages, and indexed pages every 3 days. Every status change is saved in this browser. Google doesn't offer a real-time index feed, so this is the closest free option."
    >
      <div className="panel">
        <div className="row">
          <button className={`btn${running ? "" : " primary"}`} onClick={toggle}>
            {running ? "Stop live monitoring" : "Start live monitoring"}
          </button>
          <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            Daily inspection budget
            <select value={budget} onChange={(e) => changeBudget(Number(e.target.value))}>
              {BUDGETS.map((b) => (
                <option key={b} value={b}>{num(b)}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={refreshNow} disabled={busy}>Refresh fresh data now</button>
          <button className="btn" onClick={reloadList} disabled={busy}>Reload URL list</button>
          {perm === "default" && <button className="btn" onClick={askNotify}>Enable desktop alerts</button>}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {mine && state.phase !== "idle" ? (
            <>
              <b>{PHASE[state.phase]}</b> · {state.message} ·{" "}
            </>
          ) : (
            "Not running for this property. "
          )}
          URL Inspection today: {num(used)} of {num(Math.min(budget, DAILY_INSPECTION_LIMIT))}
          {running && state.queue ? ` · ${num(state.queue)} page(s) in the queue` : ""}
          {running && state.lastBatchAt ? ` · last batch ${new Date(state.lastBatchAt).toLocaleTimeString()}` : ""}
        </p>
        {perm === "denied" && <p className="muted" style={{ marginBottom: 0 }}>Desktop alerts are blocked in this browser's site settings.</p>}
        {msg && <p className="muted" style={{ marginBottom: 0 }}>{msg}</p>}
      </div>

      <div style={{ marginTop: 16 }}>
        <Kpis
          items={[
            { label: "Fresh data as of", value: fresh ? fresh.asOf : "–", sub: fresh ? `read at ${new Date(fresh.fetchedAt).toLocaleTimeString()}` : "start monitoring or refresh" },
            { label: "Pages seen in Google (2 days)", value: fresh ? num(fresh.pagesSeenRecent) : "–", sub: fresh ? `of ${num(fresh.pagesSeenTotal)} seen in 10 days` : undefined },
            { label: "Suspected drops", value: fresh ? num(fresh.suspected.length) : "–", sub: "impressions stopped; inspected first" },
            { label: `Dropped from index (${days} d)`, value: num(count("deindexed")), sub: "confirmed by URL Inspection" },
            { label: `Fetch errors (${days} d)`, value: num(count("fetch_error")) },
            { label: `Newly indexed (${days} d)`, value: num(count("indexed")) },
          ]}
        />
      </div>

      {fresh && (
        <div className="panel" style={{ marginTop: 16 }}>
          <h3 style={{ margin: "0 0 8px" }}>Impressions per hour (fresh data, your local time)</h3>
          {fresh.hourlyAvailable && hours.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hours}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" fontSize={11} interval="preserveStartEnd" />
                <YAxis fontSize={11} width={48} />
                <Tooltip />
                <Bar dataKey="impressions" fill="#4f6bd8" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="muted">Search Console didn't return hourly data for this property.</p>
          )}
          {fresh.capped && (
            <p className="muted" style={{ marginBottom: 0 }}>
              This site has more page-days than the 100,000-row limit, so only pages averaging 20+ impressions a day can be flagged as suspected drops.
            </p>
          )}
        </div>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <SubTabs
            value={view}
            onChange={setView}
            options={[
              { id: "events", label: `Status changes (${inWindow.length})` },
              { id: "suspected", label: `Suspected drops (${suspectRows.length})` },
            ]}
          />
          <div className="row">
            <label className="control" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              Window
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {WINDOWS.map((d) => (
                  <option key={d} value={d}>Last {d} days</option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              disabled={!inWindow.length}
              onClick={() => downloadFile(`index-changes-${fileSafe(site)}-${new Date().toISOString().slice(0, 10)}.html`, eventsReportHtml(site, inWindow, days), "text/html")}
            >
              Download report
            </button>
          </div>
        </div>
        {view === "events" ? (
          <DataTable
            rows={eventRows}
            cols={[
              { key: "at", label: "When" },
              { key: "type", label: "Change", render: (r) => <span className={`pill ${TONE[r.kind]}`}>{r.type}</span> },
              { key: "url", label: "URL", url: true },
              { key: "from", label: "Before" },
              { key: "to", label: "After" },
              { key: "link", label: "", render: (r) => (r.link ? <a href={r.link} target="_blank" rel="noreferrer">Search Console</a> : "") },
            ]}
            csvRow={(r) => ({ when: r.at, change: r.type, url: r.url, before: r.from, after: r.to, search_console_link: r.link })}
            csvName={`index-changes-last-${days}-days.csv`}
            empty="No status changes in this window yet. Changes appear once a page has been inspected at least twice."
          />
        ) : (
          <DataTable
            rows={suspectRows}
            cols={[
              { key: "url", label: "URL", url: true },
              { key: "baselineAvg", label: "Avg impressions/day before", num: true },
              { key: "baselineDays", label: "Days seen (of 6)", num: true },
              { key: "lastSeen", label: "Last impression" },
              { key: "inspection", label: "Latest URL Inspection" },
            ]}
            csvRow={(r) => ({ url: r.url, avg_impressions_per_day_before: r.baselineAvg, days_seen_of_6: r.baselineDays, last_impression: r.lastSeen, latest_inspection: r.inspection })}
            csvName="suspected-drops.csv"
            empty={fresh ? "No page that showed up regularly has stopped appearing." : "Start monitoring or click “Refresh fresh data now”."}
          />
        )}
      </div>
    </Section>
  );
}
