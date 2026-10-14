// lib/monitor.ts
"use client";
// Live index monitor engine. One instance per browser tab, kept outside React so it keeps running while you
// switch dashboard tabs. Loop: every 15 min read fresh Search Console data → build a priority queue → inspect
// 10 URLs → pause 15 s → repeat, within a daily budget (Google allows ~2,000 inspections per property per day).
import { useEffect, useState } from "react";
import { DAILY_INSPECTION_LIMIT, inspectAndStore, quotaUsed } from "./checks";
import { EVENT_LABEL, isIndexedVerdict, loadEvents, loadIndexCache, type IndexCache, type IndexEvent } from "./indexCache";

export { EVENT_LABEL };

export type FreshPage = { page: string; baselineDays: number; baselineAvg: number; recent: number; lastSeen: string; impressions: number; clicks: number };
export type FreshSignal = {
  asOf: string;
  recentDays: string[];
  hourly: { hour: string; clicks: number; impressions: number }[];
  hourlyAvailable: boolean;
  pagesSeenRecent: number;
  pagesSeenTotal: number;
  suspected: FreshPage[];
  top: FreshPage[];
  capped: boolean;
  fetchedAt: string;
};
export type Phase = "idle" | "signal" | "inspecting" | "waiting" | "quota" | "locked" | "error";
export type MonitorState = {
  site: string; running: boolean; phase: Phase; message: string; fresh: FreshSignal | null;
  used: number; budget: number; queue: number; lastBatchAt: string; recentEvents: IndexEvent[];
};

const SIGNAL_EVERY = 15 * 60_000;
const BATCH = 10;
const PAUSE = 15_000;
const H = 3_600_000;
const D = 24 * H;

type QItem = { url: string; pri: number; why: string };

/** Who gets checked first: suspected drops, failed checks, new sitemap URLs, top pages, indexed pages, the rest. */
export function buildQueue(c: IndexCache, fresh: FreshSignal | null): QItem[] {
  const now = Date.now();
  const age = (u: string) => {
    const r = c.inspected[u];
    return r && r.verdict !== "ERROR" ? now - Date.parse(r.checkedAt) : Infinity;
  };
  const out = new Map<string, QItem>();
  const add = (url: string, pri: number, why: string) => {
    const cur = out.get(url);
    if (!cur || cur.pri > pri) out.set(url, { url, pri, why });
  };
  for (const p of fresh?.suspected || []) if (age(p.page) > 6 * H) add(p.page, 0, "impressions stopped in the last 2 days");
  for (const u of c.urls) {
    const r = c.inspected[u.url];
    if (r?.verdict === "ERROR") add(u.url, 1, "retrying a failed check");
    else if (!r && u.lastmod && now - Date.parse(u.lastmod) < 7 * D) add(u.url, 1, "new or updated in the sitemap");
  }
  for (const p of fresh?.top || []) if (age(p.page) > D) add(p.page, 2, "top page, not checked in 24 h");
  for (const u of c.urls) {
    const r = c.inspected[u.url];
    if (r && isIndexedVerdict(r.verdict) && age(u.url) > 3 * D) add(u.url, 3, "indexed page, re-checked every 3 days");
  }
  for (const u of c.urls) if (!c.inspected[u.url]) add(u.url, 4, "never checked");
  for (const u of c.urls) if (age(u.url) !== Infinity && age(u.url) > 7 * D) add(u.url, 5, "oldest result first");
  return Array.from(out.values()).sort((a, b) => a.pri - b.pri);
}

export function monitorPrefs(): { on: Record<string, boolean>; budget: number } {
  try {
    return {
      on: JSON.parse(localStorage.getItem("dash:monitor:on") || "{}"),
      budget: Number(localStorage.getItem("dash:monitor:budget")) || 1500,
    };
  } catch {
    return { on: {}, budget: 1500 };
  }
}

export function saveMonitorPrefs(site: string, on: boolean, budget: number) {
  try {
    const p = monitorPrefs();
    p.on[site] = on;
    localStorage.setItem("dash:monitor:on", JSON.stringify(p.on));
    localStorage.setItem("dash:monitor:budget", String(budget));
  } catch {}
}

function notify(events: IndexEvent[]) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const bad = events.filter((e) => e.type === "deindexed" || e.type === "fetch_error");
  if (!bad.length) return;
  try {
    new Notification(bad.length === 1 ? EVENT_LABEL[bad[0].type] : `${bad.length} pages need attention`, {
      body: bad.slice(0, 3).map((e) => `${e.url}\n→ ${e.to}`).join("\n"),
    });
  } catch {}
}

const initial = (): MonitorState => ({
  site: "", running: false, phase: "idle", message: "", fresh: null, used: 0, budget: 1500, queue: 0, lastBatchAt: "", recentEvents: [],
});

export class Monitor {
  private state = initial();
  private listeners = new Set<(s: MonitorState) => void>();
  private runId = 0;
  private readonly tabId = Math.random().toString(36).slice(2);

  get() {
    return this.state;
  }

  subscribe(fn: (s: MonitorState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(p: Partial<MonitorState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((f) => f(this.state));
  }

  async start(site: string, budget: number) {
    if (this.state.running && this.state.site === site) {
      this.set({ budget });
      return;
    }
    this.stop();
    const id = ++this.runId;
    const recentEvents = (await loadEvents(site)).slice(-200).reverse();
    this.set({
      site, running: true, phase: "signal", message: "Starting…", budget, used: quotaUsed(site), recentEvents,
      fresh: this.state.site === site ? this.state.fresh : null,
    });
    this.loop(id, site).catch((e) => {
      if (this.runId === id) this.set({ running: false, phase: "error", message: e instanceof Error ? e.message : "Monitor stopped" });
    });
  }

  stop() {
    this.runId++;
    this.unlock(this.state.site);
    if (this.state.running) this.set({ running: false, phase: "idle", message: "Stopped." });
  }

  setBudget(n: number) {
    this.set({ budget: n });
  }

  /** Fresh Search Console data (a few hours behind): hourly totals and pages that suddenly stopped showing. */
  async refreshSignal(site: string): Promise<FreshSignal> {
    const res = await fetch(`/api/gsc/fresh?site=${encodeURIComponent(site)}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Fresh data request failed (${res.status})`);
    const fresh: FreshSignal = { ...data, fetchedAt: new Date().toISOString() };
    if (!this.state.running || this.state.site === site) this.set({ site, fresh });
    return fresh;
  }

  // Only one tab per site runs the loop, so two open tabs don't spend the quota twice.
  private lockKey(site: string) {
    return `dash:monitor:lock:${site}`;
  }
  private lock(site: string) {
    try {
      const l = JSON.parse(localStorage.getItem(this.lockKey(site)) || "null");
      if (l && l.owner !== this.tabId && Date.now() - l.at < 45_000) return false;
      localStorage.setItem(this.lockKey(site), JSON.stringify({ owner: this.tabId, at: Date.now() }));
    } catch {}
    return true;
  }
  private unlock(site: string) {
    try {
      const l = JSON.parse(localStorage.getItem(this.lockKey(site)) || "null");
      if (l?.owner === this.tabId) localStorage.removeItem(this.lockKey(site));
    } catch {}
  }
  private async sleep(ms: number, id: number, site: string) {
    const end = Date.now() + ms;
    let touched = Date.now();
    while (Date.now() < end && this.runId === id) {
      await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
      if (Date.now() - touched > 15_000) {
        this.lock(site);
        touched = Date.now();
      }
    }
  }

  private async loop(id: number, site: string) {
    let lastSignal = 0;
    while (this.runId === id) {
      if (!this.lock(site)) {
        this.set({ phase: "locked", message: "Already running in another tab of this browser." });
        await this.sleep(30_000, id, site);
        continue;
      }
      if (Date.now() - lastSignal > SIGNAL_EVERY) {
        this.set({ phase: "signal", message: "Reading fresh Search Console data…" });
        try {
          await this.refreshSignal(site);
        } catch (e) {
          this.set({ message: `Fresh data unavailable: ${e instanceof Error ? e.message : ""}` });
        }
        lastSignal = Date.now();
      }
      if (this.runId !== id) break;
      const used = quotaUsed(site);
      const budget = Math.min(this.state.budget, DAILY_INSPECTION_LIMIT);
      if (used >= budget) {
        this.set({
          used, phase: "quota",
          message: `Today's inspection budget is used (${used.toLocaleString()} of ${budget.toLocaleString()}). It resets at midnight Pacific time; fresh-data checks continue.`,
        });
        await this.sleep(5 * 60_000, id, site);
        continue;
      }
      const cache = await loadIndexCache(site);
      if (!cache?.urls.length) {
        this.set({ used, phase: "waiting", message: "No URL list yet: click “Reload URL list” so the monitor knows which pages to check." });
        await this.sleep(60_000, id, site);
        continue;
      }
      const queue = buildQueue(cache, this.state.fresh);
      this.set({ used, queue: queue.length });
      if (!queue.length) {
        this.set({ phase: "waiting", message: "Every page has a recent result. Next pass in 5 minutes." });
        await this.sleep(5 * 60_000, id, site);
        continue;
      }
      const batch = queue.slice(0, Math.min(BATCH, budget - used));
      this.set({ phase: "inspecting", message: `Inspecting ${batch.length} page(s) — ${batch[0].why}` });
      try {
        const r = await inspectAndStore(site, batch.map((q) => q.url));
        if (this.runId !== id) break;
        if (r.events.length) {
          notify(r.events);
          this.set({ recentEvents: [...r.events.slice().reverse(), ...this.state.recentEvents].slice(0, 200) });
        }
        this.set({ used: quotaUsed(site), lastBatchAt: new Date().toISOString() });
        if (r.rateLimited) {
          await this.sleep(60_000, id, site);
          continue;
        }
      } catch (e) {
        this.set({ phase: "error", message: e instanceof Error ? e.message : "Inspection failed" });
        await this.sleep(60_000, id, site);
        continue;
      }
      await this.sleep(PAUSE, id, site);
    }
    this.unlock(site);
  }
}

let instance: Monitor | null = null;

export function getMonitor() {
  if (!instance) instance = new Monitor();
  return instance;
}

export function useMonitor(): [MonitorState, Monitor] {
  const m = getMonitor();
  const [s, setS] = useState<MonitorState>(m.get());
  useEffect(() => m.subscribe(setS), [m]);
  return [s, m];
}
