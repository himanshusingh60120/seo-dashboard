// lib/auditStore.ts
"use client";
// Per-property audit data in IndexedDB (same store as the Indexing tab), with an in-memory copy
// so tabs read the latest data instantly. Writes are batched every 2 seconds unless `now`.
import { kvGet, kvSet, kvDel } from "./idb";

export type AuditPart = "imports" | "checks" | "crawl" | "logs";
const key = (site: string, part: AuditPart) => `dash:audit:${part}:${site}`;
const mem = new Map<string, unknown>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export async function loadPart<T>(site: string, part: AuditPart): Promise<T | null> {
  const k = key(site, part);
  if (mem.has(k)) return (mem.get(k) as T | null) ?? null;
  let v: T | null = null;
  try {
    v = ((await kvGet<T>(k)) as T | undefined) || null;
  } catch {
    v = null;
  }
  mem.set(k, v);
  return v;
}

export function savePart<T>(site: string, part: AuditPart, value: T, now = false) {
  const k = key(site, part);
  mem.set(k, value);
  const t = timers.get(k);
  if (t) clearTimeout(t);
  const write = () => {
    timers.delete(k);
    kvSet(k, mem.get(k)).catch(() => {});
  };
  if (now) write();
  else timers.set(k, setTimeout(write, 2000));
}

export async function clearPart(site: string, part: AuditPart) {
  const k = key(site, part);
  const t = timers.get(k);
  if (t) clearTimeout(t);
  timers.delete(k);
  mem.delete(k);
  await kvDel(k).catch(() => {});
}
