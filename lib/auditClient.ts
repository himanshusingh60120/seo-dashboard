// lib/auditClient.ts
"use client";
import { REASONS, type AuditCheck, type CrawlResult, type ReasonKey } from "./auditRules";

export type ListedUrl = { url: string; date?: string; note?: string };
export type ImportedList = { id: string; label: string; urls: ListedUrl[]; importedAt: string; from: string };

export const LIST_OPTIONS: { id: string; label: string }[] = [
  ...(Object.keys(REASONS) as ReasonKey[]).filter((k) => k !== "indexed").map((k) => ({ id: k, label: `Page indexing · ${REASONS[k].label}` })),
  { id: "crawl:404", label: "Crawl stats · Not found (404) examples" },
  { id: "crawl:301", label: "Crawl stats · Moved permanently (301) examples" },
  { id: "crawl:discovery", label: "Crawl stats · Discovery examples" },
  { id: "crawl:refresh", label: "Crawl stats · Refresh examples" },
  { id: "crawl:other", label: "Crawl stats · Other file type examples" },
  { id: "other", label: "Any other URL list" },
];

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export const checkBatch = (site: string, urls: string[], opts: { live: boolean }) =>
  post<{ results: AuditCheck[]; quotaExceeded?: boolean }>("/api/audit/check", { siteUrl: site, urls, live: opts.live, verifyRefs: opts.live });

export const crawlBatch = (site: string, urls: string[], respectRobots: boolean) =>
  post<{ results: CrawlResult[] }>("/api/audit/crawl", { siteUrl: site, urls, respectRobots });

export async function googlebotRanges(): Promise<{ prefixes: string[]; creationTime: string }> {
  const res = await fetch("/api/audit/googlebot-ips", { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as { error?: string; prefixes?: string[]; creationTime?: string };
  if (!res.ok) throw new Error(data.error || `Could not load Google's IP ranges (${res.status})`);
  return { prefixes: data.prefixes || [], creationTime: data.creationTime || "" };
}

/* ---------- CSV / pasted text → URLs ---------- */

function csvRows(text: string): string[][] {
  const nl = text.indexOf("\n");
  const first = nl >= 0 ? text.slice(0, nl) : text;
  const n = (re: RegExp) => (first.match(re) || []).length;
  const delim = n(/\t/g) > n(/,/g) ? "\t" : n(/;/g) > n(/,/g) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Reads Search Console CSV exports (URL column + optional date/response) or any text containing URLs. */
export function parseUrlList(input: string): ListedUrl[] {
  const text = input.replace(/^\uFEFF/, "");
  const out = new Map<string, ListedUrl>();
  const rows = csvRows(text);
  const isUrlHeader = (c: string) => /^(url|urls|page|pages|address|top pages)$/i.test(c.trim());
  const head = rows.findIndex((r) => r.some(isUrlHeader));
  if (head >= 0) {
    const h = rows[head].map((c) => c.trim().toLowerCase());
    const ui = h.findIndex(isUrlHeader);
    const di = h.findIndex((c) => /crawl|time|date/.test(c));
    const ri = h.findIndex((c) => /response|status/.test(c));
    rows.slice(head + 1).forEach((r) => {
      const u = (r[ui] || "").trim();
      if (!/^https?:\/\//i.test(u) || out.has(u)) return;
      out.set(u, {
        url: u,
        date: di >= 0 ? (r[di] || "").trim() || undefined : undefined,
        note: ri >= 0 ? (r[ri] || "").trim() || undefined : undefined,
      });
    });
  }
  if (!out.size) {
    Array.from(text.matchAll(/https?:\/\/[^\s"'<>,]+/gi)).forEach((m) => {
      const u = m[0].replace(/[).;:]+$/, "");
      if (!out.has(u)) out.set(u, { url: u });
    });
  }
  return Array.from(out.values());
}
