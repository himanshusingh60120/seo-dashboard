// lib/aiImpressions.ts
"use client";
// Google's Generative AI performance report (AI Overviews + AI Mode) has no API. This reads its Search Console export
// (Performance → Generative AI features → Export → Download CSV) and keeps the data in shared storage (Upstash Redis),
// or in this browser when shared storage isn't set up. Same pattern as the Crawl activity tab.
import { useEffect, useState } from "react";
import { parseCsv, readPicked } from "./gscImport";
import { toIsoDate } from "./crawlStats";
import { kvDel, kvGet, kvSet } from "./idb";
import { normalizeUrl } from "./url";
import { emptyAiStore, mergeAi, type AiParsed, type AiStore } from "./aiStore";

export const AI_HOW_TO =
  "In Search Console open Performance → Generative AI features (Beta). Keep Search type on Web (text), choose the date range, " +
  "then Export → Download CSV and import the ZIP here as it is. Each import adds its days to the saved history, so importing " +
  "every few weeks builds a record longer than Search Console keeps.";

const NOT_AI =
  "This looks like a regular Performance export (it has a Clicks column). Export from Performance → Generative AI features instead.";

const DATE_CELL = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/;
const num = (s?: string) => {
  const t = (s ?? "").replace(/[,\s]/g, "");
  return t && t !== "-" && t !== "—" ? Number(t) : NaN;
};

type Kind = "chart" | "pages" | "countries" | "devices" | "skip";
function kindOf(name: string, header: string[]): Kind {
  const n = name.toLowerCase();
  const h = (header[0] || "").trim().toLowerCase();
  if (/filter/.test(n) || h === "filter") return "skip";
  if (/chart|dates?\b/.test(n) || /^(date|day)/.test(h)) return "chart";
  if (/page/.test(n) || /page/.test(h)) return "pages";
  if (/countr/.test(n) || /countr/.test(h)) return "countries";
  if (/device/.test(n) || /device/.test(h)) return "devices";
  return "skip";
}

const imprCol = (header: string[]) => {
  const i = header.findIndex((h) => /impression/i.test(h));
  return i >= 0 ? i : 1;
};

/** Reads picked ZIP / CSV files. Each ZIP (or the set of loose CSVs) becomes one parsed export. */
export async function parseAiFiles(files: File[]): Promise<{ parsed: AiParsed[]; skipped: string[] }> {
  const { groups, skipped } = await readPicked(files);
  const parsed: AiParsed[] = [];
  for (const g of groups) {
    const out: AiParsed = { file: g.label, from: "", to: "", days: {}, pages: {}, countries: {}, devices: {} };
    for (const f of g.csv) {
      const rows = parseCsv(f.text);
      if (rows.length < 2) continue;
      const header = rows[0].map((h) => h.trim());
      const kind = kindOf(f.name, header);
      if (kind === "skip") continue;
      if (header.some((h) => /click/i.test(h))) throw new Error(`${g.label}: ${NOT_AI}`);
      const ic = imprCol(header);
      for (const r of rows.slice(1)) {
        const key = (r[0] || "").trim();
        const v = num(r[ic]);
        if (!key || !Number.isFinite(v)) continue;
        if (kind === "chart") {
          const d = DATE_CELL.test(key) ? toIsoDate(key) : null;
          if (d) out.days[d] = v;
        } else if (kind === "pages") {
          if (/^https?:\/\//i.test(key)) {
            const u = normalizeUrl(key);
            out.pages[u] = (out.pages[u] || 0) + v;
          }
        } else {
          out[kind][key] = v;
        }
      }
    }
    const dates = Object.keys(out.days).sort();
    if (!dates.length) throw new Error(`${g.label}: no daily AI impressions were found. ${AI_HOW_TO}`);
    out.from = dates[0];
    out.to = dates[dates.length - 1];
    parsed.push(out);
  }
  return { parsed, skipped };
}

/* ---------- Saved data, shared by every component that shows it ---------- */

export type AiState = { store: AiStore; shared: boolean; note?: string };
const mem = new Map<string, AiState>();
const loading = new Map<string, Promise<AiState>>();
const subs = new Set<(site: string, s: AiState) => void>();
const localKey = (site: string) => `dash:ai:${site}`;

function publish(site: string, s: AiState) {
  mem.set(site, s);
  subs.forEach((f) => f(site, s));
}

async function localStore(site: string): Promise<AiStore> {
  try {
    return (await kvGet<AiStore>(localKey(site))) || emptyAiStore();
  } catch {
    return emptyAiStore();
  }
}

export function loadAi(site: string, force = false): Promise<AiState> {
  if (!force && mem.has(site)) return Promise.resolve(mem.get(site)!);
  if (!force && loading.has(site)) return loading.get(site)!;
  const p = (async (): Promise<AiState> => {
    try {
      const r = await fetch(`/api/ai-impressions?site=${encodeURIComponent(site)}`, { cache: "no-store" });
      if (r.status === 501) return { store: await localStore(site), shared: false };
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      return { store: (j.store as AiStore) || emptyAiStore(), shared: true };
    } catch (e) {
      return {
        store: await localStore(site),
        shared: false,
        note: `Couldn't reach shared storage (${e instanceof Error ? e.message : "error"}). Showing AI data saved in this browser.`,
      };
    }
  })().then((s) => {
    loading.delete(site);
    publish(site, s);
    return s;
  });
  loading.set(site, p);
  return p;
}

/** Saved AI data for a property; updates everywhere after an import. Null while loading. */
export function useAiStore(site: string): AiState | null {
  const [s, setS] = useState<AiState | null>(() => mem.get(site) ?? null);
  useEffect(() => {
    setS(mem.get(site) ?? null);
    const f = (x: string, v: AiState) => {
      if (x === site) setS(v);
    };
    subs.add(f);
    loadAi(site).catch(() => {});
    return () => {
      subs.delete(f);
    };
  }, [site]);
  return s;
}

export async function saveAi(site: string, items: AiParsed[]): Promise<AiState> {
  const cur = await loadAi(site);
  if (cur.shared) {
    const r = await fetch("/api/ai-impressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site, imports: items }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Saving failed (${r.status})`);
    const s: AiState = { store: j.store as AiStore, shared: true };
    publish(site, s);
    return s;
  }
  let store = cur.store;
  for (const p of items) store = mergeAi(store, p);
  await kvSet(localKey(site), store);
  const s: AiState = { store, shared: false };
  publish(site, s);
  return s;
}

export async function clearAi(site: string): Promise<void> {
  const cur = await loadAi(site);
  if (cur.shared) {
    const r = await fetch(`/api/ai-impressions?site=${encodeURIComponent(site)}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Delete failed (${r.status})`);
  } else {
    await kvDel(localKey(site));
  }
  publish(site, { store: emptyAiStore(), shared: cur.shared });
}
