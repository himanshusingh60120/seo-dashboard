// lib/audit/rules.ts
// Turns raw results into issue groups. Pure functions (no network), shared by the browser and the server.
// Counts, URLs and severity come from here and from Google's data, never from the AI.
import { CATALOG, SEVERITY_RANK, type IssueGroup, type IssueType } from "./catalog";
import type { Inspection } from "../types";

export type Ev = Record<string, string | number | null>;
export type HttpRow = {
  url: string; status: number; chain: string; finalUrl: string; redirects: number; loop: boolean;
  inconclusive: boolean; noindex: boolean; canonical: string; canonicalElsewhere: boolean; robotsBlocked: boolean; error: string;
};

/** FNV-1a: small, stable fingerprint used to cache AI answers per issue + evidence. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function makeGroup(
  type: IssueType, urls: string[], evidence: Ev[], source: string,
  metrics: Record<string, string | number> = {}, count?: number
): IssueGroup {
  const c = CATALOG[type];
  const uniq = Array.from(new Set(urls));
  const fp = hash(`${type}|${uniq.slice().sort().slice(0, 300).join("|")}|${JSON.stringify(evidence.slice(0, 15))}`);
  return {
    type, title: c.title, severity: c.severity, category: c.category,
    count: count ?? uniq.length, urls: uniq, evidence: evidence.slice(0, 25), metrics, source, fingerprint: `${type}-${fp}`,
  };
}

export const sortGroups = (groups: IssueGroup[]) =>
  groups.slice().sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);

function collector() {
  const m = new Map<IssueType, { urls: string[]; ev: Ev[] }>();
  return {
    add(t: IssueType, url: string, ev: Ev) {
      const b = m.get(t) || { urls: [], ev: [] };
      b.urls.push(url);
      b.ev.push(ev);
      m.set(t, b);
    },
    groups(source: string, sortKey?: string) {
      return Array.from(m.entries()).map(([t, b]) => {
        if (sortKey) b.ev.sort((x, y) => Number(y[sortKey] ?? 0) - Number(x[sortKey] ?? 0));
        return makeGroup(t, b.ev.map((e) => String(e.url)), b.ev, source);
      });
    },
  };
}

/** Maps one URL Inspection result to issue types. Expected states (alternate page, page with redirect) aren't issues. */
export function inspectionTypes(r: Inspection, inSitemap: boolean, clicks: number): IssueType[] {
  const pf = r.pageFetchState;
  const cov = (r.coverageState || "").toLowerCase();
  const matters = inSitemap || clicks > 0;
  const primary = (): IssueType | null => {
    if (pf === "NOT_FOUND" || /not found \(404\)/.test(cov)) return "http_404";
    if (pf === "SOFT_404" || /soft 404/.test(cov)) return "soft_404";
    if (pf === "SERVER_ERROR" || /server error/.test(cov)) return "server_error";
    if (pf === "REDIRECT_ERROR" || /redirect error/.test(cov)) return "redirect_error";
    if (["ACCESS_DENIED", "ACCESS_FORBIDDEN", "BLOCKED_4XX"].includes(pf) || /\(401\)|\(403\)|other 4xx/.test(cov)) return "access_denied";
    if (r.robotsTxtState === "DISALLOWED" || pf === "BLOCKED_ROBOTS_TXT" || /blocked by robots\.txt/.test(cov)) return matters ? "blocked_robots" : null;
    if (r.indexingState === "BLOCKED_BY_META_TAG" || r.indexingState === "BLOCKED_BY_HTTP_HEADER" || /noindex/.test(cov)) return matters ? "noindex" : null;
    if (/crawled\s*[-–—]\s*currently not indexed/.test(cov)) return "crawled_not_indexed";
    if (/discovered\s*[-–—]\s*currently not indexed/.test(cov)) return "discovered_not_indexed";
    if (/duplicate without user-selected canonical/.test(cov)) return "duplicate_no_canonical";
    if (/google chose different canonical/.test(cov) || (r.userCanonical && r.googleCanonical && r.userCanonical !== r.googleCanonical)) return "canonical_mismatch";
    if (/unknown to google/.test(cov)) return inSitemap ? "unknown_to_google" : null;
    return null;
  };
  const out: IssueType[] = [];
  const p = primary();
  if (p) out.push(p);
  if (r.richIssues?.some((i) => i.severity === "ERROR")) out.push("rich_result_errors");
  if ((r.verdict === "PASS" || r.verdict === "PARTIAL") && inSitemap && r.lastCrawlTime && Date.now() - Date.parse(r.lastCrawlTime) > 90 * 864e5) out.push("stale_crawl");
  return out;
}

export function inspectionIssues(results: Inspection[], sitemap: Set<string>, clicks: Map<string, number>): IssueGroup[] {
  const c = collector();
  for (const r of results) {
    const inSm = sitemap.has(r.url);
    const cl = clicks.get(r.url) || 0;
    const ev: Ev = {
      url: r.url, coverage: r.coverageState, fetch: r.pageFetchState || null, robots_txt: r.robotsTxtState || null,
      indexing: r.indexingState || null, last_crawl: r.lastCrawlTime ? r.lastCrawlTime.slice(0, 10) : null,
      user_canonical: r.userCanonical || null, google_canonical: r.googleCanonical || null,
      in_sitemap: inSm ? "yes" : "no", clicks: cl, inspected: r.checkedAt.slice(0, 10),
    };
    for (const t of inspectionTypes(r, inSm, cl)) {
      const rich = t === "rich_result_errors"
        ? { rich_errors: r.richIssues.filter((i) => i.severity === "ERROR").slice(0, 2).map((i) => `${i.type}: ${i.message}`).join(" | ") }
        : {};
      c.add(t, r.url, { ...ev, ...rich });
    }
  }
  return c.groups("Google URL Inspection API", "clicks");
}

export function httpIssues(rows: HttpRow[], sitemap: Set<string>, clicks: Map<string, number>): IssueGroup[] {
  const c = collector();
  for (const r of rows) {
    const inSm = sitemap.has(r.url);
    const matters = inSm || (clicks.get(r.url) || 0) > 0;
    const ev: Ev = {
      url: r.url, status: r.status || null, chain: r.chain || null, final_url: r.finalUrl !== r.url ? r.finalUrl : null,
      canonical: r.canonical || null, in_sitemap: inSm ? "yes" : "no", clicks: clicks.get(r.url) || 0, note: r.error || null,
    };
    if (r.loop) c.add("redirect_error", r.url, ev);
    else if (r.inconclusive || !r.status) {
      if (!/isn't part of|Private or reserved|Invalid URL|Only (http|standard)/i.test(r.error)) c.add("http_inconclusive", r.url, ev);
    } else if (r.status >= 500) c.add("url_5xx", r.url, ev);
    else if (r.status >= 400) c.add("url_4xx", r.url, ev);
    else {
      if (r.redirects > 0 && inSm) c.add("url_redirect", r.url, ev);
      if (r.redirects > 1) c.add("redirect_chain", r.url, ev);
      if (r.status === 200 && r.noindex && matters) c.add("url_noindex", r.url, ev);
      if (r.status === 200 && r.canonicalElsewhere && inSm) c.add("url_canonical_elsewhere", r.url, ev);
    }
    if (r.robotsBlocked && inSm) c.add("url_robots_blocked", r.url, ev);
  }
  return c.groups("Live check by this dashboard", "clicks");
}
