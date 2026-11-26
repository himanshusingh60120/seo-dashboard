// lib/clientCache.ts
"use client";
/**
 * Keeps the dashboard's last answers in this browser, so a property, period or tab opened before shows its numbers at
 * once while fresh ones load in the background and replace them. While a saved copy is younger than its freshness
 * time (FRESH), the server isn't asked at all, which also saves Vercel and Google calls. Costs nothing on Vercel or Upstash.
 *
 *   - Saved per signed-in person (the key includes their email), in IndexedDB (lib/idb.ts) and in memory for this page.
 *     Nothing is saved or shown until the dashboard knows who is signed in (setCacheUser).
 *   - Identical requests running at the same moment share one network call.
 *   - Only successful answers are saved. Copies older than MAX_AGE are never shown; at most MAX_ENTRIES are kept.
 *   - Signing out clears everything (clearCache).
 */
import { kvDel, kvGet, kvSet, tx } from "./idb";

/** How long a saved copy is used without asking the server again. */
export const FRESH = {
  /** Search Console numbers, which change about once a day. */
  search: 60 * 60_000,
  /** GA4 reports (full days, ending yesterday). */
  ga: 15 * 60_000,
  /** Screens with live numbers: GA4 "users right now", index-check progress. */
  live: 5 * 60_000,
} as const;

const PREFIX = "dash:cache:";
const META_KEY = "dash:cache-meta";
const MAX_AGE = 3 * 864e5;
const MAX_ENTRIES = 40;
const MEM_ENTRIES = 15;

type Entry<T> = { at: number; data: T };
export type CacheInfo = { cached: boolean; at: number };

let user = "";
const mem = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<Entry<unknown>>>();
/** Saved key → when it was saved, so old copies can be cleared without reading them. */
let metaP: Promise<Record<string, number>> | null = null;

/** Called by the dashboard with the signed-in email. Empty (still loading) = nothing is saved or shown. */
export function setCacheUser(email: string | null | undefined) {
  user = (email || "").trim().toLowerCase();
}

const keyOf = (url: string) => (user ? `${PREFIX}${user}:${url}` : "");
const hasError = (d: unknown) =>
  !!d && typeof d === "object" && typeof (d as { error?: unknown }).error === "string" && (d as { error: string }).error !== "";

function memSet(key: string, e: Entry<unknown>) {
  mem.delete(key);
  mem.set(key, e);
  while (mem.size > MEM_ENTRIES) {
    const first = mem.keys().next().value;
    if (first === undefined) break;
    mem.delete(first);
  }
}

/** The list of saved copies. The first time per page, copies older than MAX_AGE (and beyond MAX_ENTRIES) are deleted. */
function loadMeta(): Promise<Record<string, number>> {
  if (!metaP) {
    metaP = (async () => {
      const m: Record<string, number> = (await kvGet<Record<string, number>>(META_KEY).catch(() => undefined)) || {};
      const now = Date.now();
      const drop = Object.keys(m)
        .sort((a, b) => m[b] - m[a])
        .filter((k, i) => now - m[k] >= MAX_AGE || i >= MAX_ENTRIES);
      if (drop.length) {
        for (const k of drop) {
          delete m[k];
          kvDel(k).catch(() => {});
        }
        kvSet(META_KEY, m).catch(() => {});
      }
      return m;
    })();
  }
  return metaP;
}

async function readSaved<T>(key: string): Promise<Entry<T> | null> {
  const hit = mem.get(key) as Entry<T> | undefined;
  if (hit) return Date.now() - hit.at < MAX_AGE ? hit : null;
  const m = await loadMeta();
  if (!m[key]) return null;
  const e = await kvGet<Entry<T>>(key).catch(() => undefined);
  if (!e || Date.now() - e.at >= MAX_AGE) return null;
  memSet(key, e);
  return e;
}

async function save(key: string, e: Entry<unknown>) {
  memSet(key, e);
  try {
    const m = await loadMeta();
    m[key] = e.at;
    for (const k of Object.keys(m).sort((a, b) => m[b] - m[a]).slice(MAX_ENTRIES)) {
      delete m[k];
      kvDel(k).catch(() => {});
    }
    await kvSet(key, e);
    await kvSet(META_KEY, m);
  } catch {
    /* storage full or blocked: the copy in memory still works for this page */
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j && j.error) || `Request failed (${res.status})`);
  return j as T;
}

/**
 * Hands over a saved copy of url's answer at once (if there is one), then a fresh one from the server unless the saved
 * copy is younger than freshMs (0 = always ask). onData can be called twice. Rejects only when the server call fails.
 */
export async function cachedFetch<T>(url: string, freshMs: number, onData: (data: T, info: CacheInfo) => void): Promise<void> {
  const key = keyOf(url);
  if (key) {
    const saved = await readSaved<T>(key).catch(() => null);
    if (saved) {
      onData(saved.data, { cached: true, at: saved.at });
      if (Date.now() - saved.at < freshMs) return;
    }
  }
  let p = inflight.get(url) as Promise<Entry<T>> | undefined;
  if (!p) {
    p = fetchJson<T>(url)
      .then((data) => {
        const e: Entry<T> = { at: Date.now(), data };
        const k = keyOf(url);
        if (k && !hasError(data)) void save(k, e);
        return e;
      })
      .finally(() => inflight.delete(url));
    inflight.set(url, p as Promise<Entry<unknown>>);
  }
  const e = await p;
  onData(e.data, { cached: false, at: e.at });
}

/** Saves an answer the screen already has (for example after changing a setting), so the next visit shows it. */
export function remember(url: string, data: unknown) {
  const key = keyOf(url);
  if (key && !hasError(data)) void save(key, { at: Date.now(), data });
}

/** Deletes every saved answer in this browser (on sign-out). */
export async function clearCache() {
  mem.clear();
  inflight.clear();
  try {
    const keys = (await tx<IDBValidKey[]>("kv", "readonly", (s) => s.getAllKeys())) || [];
    await Promise.all(
      keys
        .filter((k): k is string => typeof k === "string" && (k.startsWith(PREFIX) || k === META_KEY))
        .map((k) => kvDel(k).catch(() => {}))
    );
  } catch {
    /* nothing saved, or storage blocked */
  }
  metaP = Promise.resolve({});
}
