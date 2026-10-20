// lib/audit/verify.ts
// Shared (browser + server), no network. Adds two columns to every evidence row so each figure can be checked:
//  - verify_link: Google's own page for it. For an inspected URL that's the Search Console URL Inspection link the
//    API returns (inspectionResultLink); otherwise the Search Console report the figure comes from.
//  - how_to_verify: what to look at there, or on your own site for this dashboard's live checks and crawl.
// Added for display and downloads only: the AI step gets the evidence without them.
import type { IssueGroup } from "./catalog";
import type { Ev } from "./rules";
import type { Inspection } from "../types";

export const VERIFY_LINK = "verify_link";
export const HOW_TO_VERIFY = "how_to_verify";

const GSC = "https://search.google.com/search-console";
type Report = "index" | "sitemaps" | "performance/search-analytics" | "settings/crawl-stats";
export const gscReport = (site: string, report: Report) => `${GSC}/${report}?resource_id=${encodeURIComponent(site)}`;

const pathOf = (u: unknown) => {
  if (typeof u !== "string") return "";
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

function howFor(g: IssueGroup, row: Ev, hasInspection: boolean): string {
  const t = g.type;
  if (g.category === "Performance") {
    return row.query != null
      ? `Performance report → Queries → filter Query = "${row.query}" (same date range)`
      : "Performance report → Pages → + New → Page → Exact URL (same date range)";
  }
  if (g.source.indexOf("Sitemaps") >= 0) return "Sitemaps report → click this sitemap for its errors, warnings and last read date";
  if (t === "http_404_sources") {
    return row.source_type === "Page on your site"
      ? `Open the source page and search it (Ctrl+F) for ${pathOf(row.url)}`
      : "URL Inspection → Page indexing → Discovery lists Google's referring pages and sitemaps";
  }
  if (t === "broken_links" || t === "links_to_redirects") {
    return String(row.linked_from || "").indexOf("http") === 0
      ? `Open the linked_from page and search it (Ctrl+F) for ${pathOf(row.url)}`
      : "Your sitemap lists this URL; open the URL to see the error";
  }
  if (g.source.indexOf("Live check") >= 0) {
    if (t === "url_noindex") return "Open the URL, view page source and search for noindex (also check the X-Robots-Tag response header)";
    if (t === "url_canonical_elsewhere") return 'Open the URL, view page source and search for rel="canonical"';
    if (t === "url_robots_blocked") return "Open /robots.txt on the URL's host and find the matching Disallow rule";
    return `Open the URL: it answers ${row.status ?? "no response"}${row.chain ? ` (${row.chain})` : ""}`;
  }
  return hasInspection
    ? "Opens Google's URL Inspection for this URL; coverage, last crawl and canonicals match this row as of the inspected date"
    : "Inspect this URL in Search Console";
}

export function withVerifyLinks(groups: IssueGroup[], site: string, inspected: Record<string, Inspection>): IssueGroup[] {
  return groups.map((g) => {
    const fallback =
      g.category === "Performance"
        ? gscReport(site, "performance/search-analytics")
        : g.source.indexOf("Sitemaps") >= 0
        ? gscReport(site, "sitemaps")
        : g.source.indexOf("URL Inspection") >= 0
        ? gscReport(site, "index")
        : "";
    const evidence = g.evidence.map((row) => {
      const url = typeof row.url === "string" ? row.url : "";
      const insp = url ? inspected[url] : undefined;
      const hasInsp = !!(insp && insp.link);
      const link = g.category === "Performance" ? fallback : (hasInsp ? insp!.link : "") || fallback;
      return { ...row, [VERIFY_LINK]: link || null, [HOW_TO_VERIFY]: howFor(g, row, hasInsp) };
    });
    return { ...g, evidence };
  });
}

export function stripVerify(g: IssueGroup): IssueGroup {
  return {
    ...g,
    evidence: g.evidence.map((row) => {
      const out: Ev = {};
      Object.keys(row).forEach((k) => {
        if (k !== VERIFY_LINK && k !== HOW_TO_VERIFY) out[k] = row[k];
      });
      return out;
    }),
  };
}
