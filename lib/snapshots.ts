// lib/snapshots.ts
"use client";
import type { SiteCheck } from "./types";
import type { InspectionRec } from "./checks";
import { isIndexedVerdict, isNotIndexedVerdict } from "./indexCache";
import { tx } from "./idb";

/* ---------- Types ---------- */

export type Method = "inspection" | "site";
export type UrlCheck = { url: string; inspection?: InspectionRec; site?: SiteCheck };

/** One day's index check for one Search Console property. */
export type Snapshot = {
  id: string; // `${site}|${date}`
  site: string;
  date: string; // local YYYY-MM-DD
  startedAt: string;
  updatedAt: string;
  methods: Method[];
  planned: string[];
  checks: Record<string, UrlCheck>;
};

export type Status = "indexed" | "not_indexed" | "conflict" | "unknown";

/* ---------- Status rules ---------- */

export function inspectionStatus(c?: UrlCheck): Status {
  const v = c?.inspection?.verdict;
  if (!v) return "unknown";
  if (isIndexedVerdict(v)) return "indexed";
  if (isNotIndexedVerdict(v)) return "not_indexed";
  return "unknown";
}

export function siteStatus(c?: UrlCheck): Status {
  const s = c?.site?.status;
  if (s === "found") return "indexed";
  if (s === "not_found") return "not_indexed";
  return "unknown";
}

/** Combines both checks. If they disagree the page is marked "conflict" rather than guessed. */
export function overall(c?: UrlCheck): Status {
  const a = inspectionStatus(c), b = siteStatus(c);
  if (a === "unknown") return b;
  if (b === "unknown") return a;
  return a === b ? a : "conflict";
}

const anyIndexed = (c?: UrlCheck) => inspectionStatus(c) === "indexed" || siteStatus(c) === "indexed";

/* ---------- Comparison ---------- */

export type Confidence = "Both checks agree" | "URL Inspection only" | "site: search only" | "Checks disagree";

export type DeindexRow = {
  url: string;
  confidence: Confidence;
  before: UrlCheck;
  now: UrlCheck;
};

export function confidenceOf(now: UrlCheck): Confidence {
  const a = inspectionStatus(now), b = siteStatus(now);
  if (a !== "unknown" && b !== "unknown") return a === b ? "Both checks agree" : "Checks disagree";
  return a !== "unknown" ? "URL Inspection only" : "site: search only";
}

/**
 * A page counts as deindexed when at least one check said "indexed" on the earlier day,
 * and today at least one check says "not indexed".
 * Pages where today's two checks disagree are reported separately as "possibly deindexed".
 */
export function compare(prev: Snapshot | null, cur: Snapshot) {
  const deindexed: DeindexRow[] = [];
  const possible: DeindexRow[] = [];
  const newlyIndexed: DeindexRow[] = [];
  let stillIndexed = 0, stillNot = 0, notRechecked = 0, firstSeen = 0;

  for (const [url, now] of Object.entries(cur.checks)) {
    const before = prev?.checks[url];
    const n = overall(now);
    if (!before || overall(before) === "unknown") { firstSeen++; continue; }
    if (n === "unknown") continue;
    const wasIndexed = anyIndexed(before);
    if (wasIndexed && n === "not_indexed") deindexed.push({ url, confidence: confidenceOf(now), before, now });
    else if (wasIndexed && n === "conflict") possible.push({ url, confidence: "Checks disagree", before, now });
    else if (wasIndexed) stillIndexed++;
    else if (n === "indexed") newlyIndexed.push({ url, confidence: confidenceOf(now), before, now });
    else stillNot++;
  }
  if (prev) for (const url of Object.keys(prev.checks)) if (!cur.checks[url] && anyIndexed(prev.checks[url])) notRechecked++;

  const rank: Record<Confidence, number> = { "Both checks agree": 0, "URL Inspection only": 1, "site: search only": 2, "Checks disagree": 3 };
  deindexed.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.url.localeCompare(b.url));
  return { deindexed, possible, newlyIndexed, stillIndexed, stillNot, notRechecked, firstSeen };
}

/* ---------- IndexedDB storage ---------- */

const snap = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => tx<T>("snapshots", mode, fn);

export const snapshotId = (site: string, date: string) => `${site}|${date}`;

export async function listSnapshots(site: string): Promise<Snapshot[]> {
  const all = await snap<Snapshot[]>("readonly", (s) => s.index("site").getAll(site));
  return all.sort((a, b) => a.date.localeCompare(b.date));
}

export const putSnapshot = (s: Snapshot) => snap("readwrite", (st) => st.put(s));
export const deleteSnapshot = (id: string) => snap("readwrite", (st) => st.delete(id));

/** Imports a history file exported earlier. Existing days are kept unless the file has more checks for that day. */
export async function importSnapshots(list: Snapshot[]) {
  let n = 0;
  for (const s of list) {
    if (!s?.id || !s.site || !s.date || !s.checks) continue;
    const existing = await snap<Snapshot | undefined>("readonly", (st) => st.get(s.id));
    if (!existing || Object.keys(existing.checks).length < Object.keys(s.checks).length) {
      await putSnapshot(s);
      n++;
    }
  }
  return n;
}
