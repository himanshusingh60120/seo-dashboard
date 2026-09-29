// lib/checks.ts
"use client";
import type { Inspection, SiteCheck } from "./types";

export type InspectionRec = Inspection & { checkedAt: string };
export type BatchResult<T> = { results: T[]; quotaExceeded?: boolean; stopReason?: string };
/** Search provider in use; direct = asking google.com without an API key. */
export type ProviderInfo = { provider: string | null; archives: boolean; direct?: boolean };

async function post<T>(url: string, body: unknown): Promise<BatchResult<T>> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const inspectBatch = (site: string, urls: string[]) => post<InspectionRec>("/api/gsc/inspect", { siteUrl: site, urls });
export const siteBatch = (site: string, urls: string[]) => post<SiteCheck>("/api/index/site-check", { siteUrl: site, urls });

export async function providerInfo(): Promise<ProviderInfo> {
  try {
    const res = await fetch("/api/index/site-check", { cache: "no-store" });
    if (!res.ok) return { provider: null, archives: false };
    return await res.json();
  } catch {
    return { provider: null, archives: false };
  }
}

/**
 * Sends URLs to a check endpoint 20 at a time and reports each batch as it lands.
 * Stops on quota exhaustion, an error, or when shouldStop() returns true.
 */
export async function runBatches<T>(
  urls: string[],
  call: (batch: string[]) => Promise<BatchResult<T>>,
  onBatch: (results: T[], done: number) => void,
  shouldStop: () => boolean,
  size = 20
): Promise<{ stopped: boolean; quotaExceeded: boolean; error?: string; reason?: string }> {
  for (let i = 0; i < urls.length; i += size) {
    if (shouldStop()) return { stopped: true, quotaExceeded: false };
    try {
      const data = await call(urls.slice(i, i + size));
      onBatch(data.results, Math.min(i + size, urls.length));
      if (data.quotaExceeded) return { stopped: true, quotaExceeded: true, reason: data.stopReason };
    } catch (e) {
      return { stopped: true, quotaExceeded: false, error: e instanceof Error ? e.message : "Request failed" };
    }
  }
  return { stopped: false, quotaExceeded: false };
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
