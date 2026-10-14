// lib/audit/catalog.ts
// Shared (browser + server). Every issue type the audit can report, with a standard fix based on Google's
// documentation. Severity is fixed here, never chosen by the AI.

export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "Indexing" | "Crawling" | "Sitemaps" | "Canonicals" | "Performance" | "Structured data";
export type IssueType =
  | "http_404" | "soft_404" | "server_error" | "redirect_error" | "access_denied" | "blocked_robots" | "noindex"
  | "canonical_mismatch" | "crawled_not_indexed" | "discovered_not_indexed" | "duplicate_no_canonical" | "unknown_to_google"
  | "rich_result_errors" | "stale_crawl"
  | "url_4xx" | "url_5xx" | "url_redirect" | "redirect_chain" | "url_noindex" | "url_robots_blocked" | "url_canonical_elsewhere" | "http_inconclusive"
  | "no_sitemaps" | "sitemap_errors" | "sitemap_warnings" | "sitemap_stale"
  | "traffic_drop" | "lost_visibility" | "position_drop" | "low_ctr" | "cannibalization";

export type CatalogEntry = {
  title: string; severity: Severity; category: Category; what: string;
  causes: string[]; steps: string[]; verify: string[]; doc?: string;
};

export type IssueGroup = {
  type: IssueType; title: string; severity: Severity; category: Category;
  /** Number of affected URLs (or queries, for cannibalisation), counted from the data. */
  count: number;
  urls: string[];
  evidence: Record<string, string | number | null>[];
  metrics: Record<string, string | number>;
  source: string;
  fingerprint: string;
};

export type Check = { name: string; passed: boolean; detail: string };
export type AiUsage = { gptIn: number; gptOut: number; jevIn: number; gptCalls: number; jevCalls: number };
export type Solution = {
  status: "verified" | "revised" | "needs_review" | "standard" | "error";
  summary: string; causes: string[]; steps: string[]; verify: string[]; examples: string[];
  checks: Check[]; usage: AiUsage; models: string[]; generatedAt: string;
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const STATUS_LABEL: Record<Solution["status"], string> = {
  verified: "AI fix — verified",
  revised: "AI fix — corrected, then verified",
  standard: "Standard fix",
  needs_review: "AI fix — needs human review",
  error: "AI failed",
};

const DOC = {
  http: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors",
  robots: "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
  noindex: "https://developers.google.com/search/docs/crawling-indexing/block-indexing",
  canonical: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
  redirects: "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
  sitemap: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap",
  pages: "https://support.google.com/webmasters/answer/7440203",
  drops: "https://developers.google.com/search/docs/monitor-debug/debugging-search-traffic-drops",
  rich: "https://search.google.com/test/rich-results",
};

export const CATALOG: Record<IssueType, CatalogEntry> = {
  /* ---------- From Google's URL Inspection API ---------- */
  http_404: {
    title: "Pages Google found returning 404 (Not found)", severity: "high", category: "Indexing",
    what: "URL Inspection reports these URLs return 404, so Google drops them from its index.",
    causes: ["The page was deleted or moved without a redirect", "Internal links or sitemaps still point to the old URL", "Mistyped links from other sites"],
    steps: [
      "If the content moved, 301-redirect each old URL straight to its closest replacement",
      "If it's gone with no replacement, keep the 404 (or use 410)",
      "Remove these URLs from your XML sitemaps",
      "Update internal links that point to them",
    ],
    verify: ["Each URL returns 301 → 200, or an intentional 404/410", "Run 'Test live URL' in URL Inspection, then 'Validate fix' in the Page indexing report"],
    doc: DOC.http,
  },
  soft_404: {
    title: "Soft 404: pages that look empty or 'not found' but return 200", severity: "high", category: "Indexing",
    what: "Google treats these pages as missing even though the server answers 200, so they won't be indexed.",
    causes: ["The page is empty or nearly empty (no results, out of stock, placeholder)", "An error message is shown with a 200 status", "Removed pages redirect to an unrelated page such as the homepage"],
    steps: [
      "If the page is gone, return 404 or 410 instead of 200",
      "If it should rank, give it substantial, unique content",
      "Redirect removed pages only to a close equivalent, never blanket-redirect to the homepage",
      "Check templates that render empty states (search, filters, categories)",
    ],
    verify: ["'Test live URL' no longer reports Soft 404", "'Validate fix' in the Page indexing report"],
    doc: DOC.http,
  },
  server_error: {
    title: "Server errors (5xx) when Googlebot crawls", severity: "critical", category: "Crawling",
    what: "Googlebot got 5xx errors on these pages. Repeated server errors slow crawling and can drop pages from the index.",
    causes: ["Server overload or timeouts at crawl time", "Application errors on specific templates", "Firewall, CDN or bot protection blocking or rate-limiting Googlebot"],
    steps: [
      "Find these requests in server or CDN logs and fix the failing code paths",
      "Make sure the firewall/CDN doesn't challenge verified Googlebot (verify by reverse DNS, not the user-agent)",
      "Add capacity or caching if errors line up with traffic peaks",
      "Use 503 with Retry-After only for planned maintenance",
    ],
    verify: ["'Test live URL' fetches the page successfully", "Settings → Crawl stats shows no server errors for the host"],
    doc: DOC.http,
  },
  redirect_error: {
    title: "Redirect errors (loops, long chains, bad targets)", severity: "high", category: "Crawling",
    what: "Redirects on these URLs can't be followed, so neither the old nor the new URL gets the signals.",
    causes: ["A redirect loop", "A chain with too many hops", "A redirect to an empty, invalid or very long URL"],
    steps: [
      "Trace each URL's redirects",
      "Point every old URL directly to the final 200 URL in one hop",
      "Fix loops and malformed Location headers",
      "Update internal links and sitemaps to the final URL",
    ],
    verify: ["Each URL returns a single 301 to a 200 page", "'Test live URL' succeeds"],
    doc: DOC.redirects,
  },
  access_denied: {
    title: "Blocked by 401, 403 or another 4xx", severity: "high", category: "Crawling",
    what: "Googlebot is refused on these pages, so it can't crawl or index them.",
    causes: ["Login or password protection", "Firewall or bot rules blocking Googlebot", "Geo or IP blocking"],
    steps: [
      "Decide whether each page should be public",
      "For public pages, allow verified Googlebot in the firewall or CDN (verify by reverse DNS)",
      "For private pages, remove them from sitemaps and internal links",
    ],
    verify: ["'Test live URL' fetches the page successfully"],
    doc: DOC.http,
  },
  blocked_robots: {
    title: "Blocked by robots.txt but in your sitemap or getting clicks", severity: "high", category: "Crawling",
    what: "robots.txt stops Google from crawling these pages even though you list them in a sitemap or they earn clicks.",
    causes: ["A Disallow rule is broader than intended", "Rules left over from staging or a migration"],
    steps: [
      "Find the rule in robots.txt that matches these URLs",
      "Narrow or remove it if these pages should rank",
      "To keep pages out of Google, allow crawling and use noindex instead (robots.txt blocks crawling, not indexing)",
      "Remove intentionally blocked URLs from sitemaps",
    ],
    verify: ["URL Inspection shows 'Crawl allowed: Yes' after Google refetches robots.txt"],
    doc: DOC.robots,
  },
  noindex: {
    title: "noindex on pages that are in your sitemap or getting clicks", severity: "high", category: "Indexing",
    what: "These pages tell Google not to index them, which conflicts with listing them in a sitemap or earning clicks.",
    causes: ["noindex left over from staging or a CMS/plugin setting", "A template applies noindex too broadly", "An X-Robots-Tag header set by the server or CDN"],
    steps: [
      "Confirm whether each page should be indexed",
      "If yes, remove the robots meta noindex and any X-Robots-Tag noindex",
      "If no, remove the page from sitemaps",
      "Request indexing for the most important fixed pages",
    ],
    verify: ["The page source and response headers show no noindex", "'Test live URL' shows 'Indexing allowed: Yes'"],
    doc: DOC.noindex,
  },
  canonical_mismatch: {
    title: "Google chose a different canonical than yours", severity: "medium", category: "Canonicals",
    what: "Google picked another URL as canonical instead of the one these pages declare, so your chosen URL may not be the one shown in search.",
    causes: [
      "The pages are duplicates or near-duplicates",
      "Internal links, sitemaps or hreflang point to the other version",
      "The declared canonical redirects, errors or is noindexed",
      "http/https, www or trailing-slash variants both resolve",
    ],
    steps: [
      "Compare your declared canonical with Google's choice for each URL",
      "Make canonical tags, internal links, sitemaps and hreflang all point to the same URL",
      "Make sure the declared canonical returns 200 and is indexable",
      "Merge true duplicates, or make each page clearly distinct",
    ],
    verify: ["URL Inspection shows Google-selected canonical = user-declared canonical (this can take weeks)"],
    doc: DOC.canonical,
  },
  crawled_not_indexed: {
    title: "Crawled – currently not indexed", severity: "medium", category: "Indexing",
    what: "Google crawled these pages but decided not to index them for now. Some of this is normal on large sites.",
    causes: ["Google judged the page low-value or too similar to other pages", "Thin or templated content", "Few internal links point to the page"],
    steps: [
      "Prioritise the pages that matter for the business",
      "Add unique, substantive content and consolidate near-duplicates",
      "Link to them from relevant, already-indexed pages",
      "Keep them in the sitemap with an accurate lastmod, then request indexing for the most important ones",
    ],
    verify: ["Re-inspect after the changes; the status should move to 'Submitted and indexed'"],
    doc: DOC.pages,
  },
  discovered_not_indexed: {
    title: "Discovered – currently not indexed", severity: "medium", category: "Indexing",
    what: "Google knows these URLs but hasn't crawled them yet.",
    causes: ["Google is pacing crawling (server capacity or crawl demand)", "Many low-value URLs compete for crawling", "Weak internal linking"],
    steps: [
      "Link to these pages from strong, indexed pages",
      "Cut low-value URL generation (parameters, filters, endless calendars)",
      "Improve server response time",
      "Keep sitemaps limited to canonical, indexable URLs",
    ],
    verify: ["These URLs move to crawled or indexed states in URL Inspection over the following weeks"],
    doc: DOC.pages,
  },
  duplicate_no_canonical: {
    title: "Duplicate without user-selected canonical", severity: "medium", category: "Canonicals",
    what: "Google sees these pages as duplicates and you haven't said which version to use.",
    causes: ["Parameter, sort or tracking URLs serve the same content", "Printer or session variants", "Mixed case or trailing-slash variants"],
    steps: [
      "Pick the preferred URL for each set of duplicates",
      "Add rel=canonical pointing to the preferred URL on every duplicate",
      "301-redirect duplicates that don't need to exist",
      "Link internally only to the preferred URL",
    ],
    verify: ["URL Inspection shows your chosen canonical"],
    doc: DOC.canonical,
  },
  unknown_to_google: {
    title: "Sitemap URLs unknown to Google", severity: "medium", category: "Indexing",
    what: "These URLs are in your sitemaps but Google hasn't discovered them yet.",
    causes: ["The sitemap that lists them hasn't been read since they were added", "No internal links point to them"],
    steps: [
      "Check the sitemap that contains them is submitted and was read recently",
      "Add internal links from relevant pages",
      "Request indexing for the most important URLs",
    ],
    verify: ["URL Inspection no longer says 'URL is unknown to Google'"],
    doc: DOC.sitemap,
  },
  rich_result_errors: {
    title: "Structured data errors", severity: "medium", category: "Structured data",
    what: "Structured data on these pages has errors, so they can't get rich results.",
    causes: ["Required properties are missing or invalid", "Markup doesn't match the visible content"],
    steps: ["Fix each error named in the evidence", "Validate with Google's Rich Results Test", "Keep markup consistent with what users see"],
    verify: ["The Rich Results Test shows no errors", "The enhancement report's validation passes"],
    doc: DOC.rich,
  },
  stale_crawl: {
    title: "Indexed sitemap pages not crawled in 90+ days", severity: "low", category: "Crawling",
    what: "Google hasn't recrawled these indexed sitemap URLs for over 90 days, so recent changes may not be reflected.",
    causes: ["Google sees little change or demand", "Weak internal linking", "lastmod isn't updated, or is updated without real changes"],
    steps: ["Update lastmod only when the content actually changes", "Refresh and improve important pages", "Add internal links from frequently crawled pages"],
    verify: ["The last crawl date in URL Inspection moves forward"],
    doc: DOC.sitemap,
  },

  /* ---------- From the dashboard's own live page checks ---------- */
  url_4xx: {
    title: "URLs returning 4xx errors right now", severity: "high", category: "Crawling",
    what: "Our live check got a 4xx error for these URLs (they're in your sitemaps or earn search traffic).",
    causes: ["Deleted or moved pages still listed or linked", "Access rules returning 401, 403 or 410"],
    steps: [
      "301-redirect moved pages to their replacement",
      "Return 404/410 for removed pages and remove them from sitemaps",
      "Fix internal links that point to them",
    ],
    verify: ["Re-run this audit or /site-check and confirm 200 or an intentional 404/410"],
    doc: DOC.http,
  },
  url_5xx: {
    title: "URLs returning 5xx errors right now", severity: "critical", category: "Crawling",
    what: "Our live check got a server error for these URLs. If Googlebot sees the same, they can drop from the index.",
    causes: ["Application errors on these templates", "Upstream services or databases failing", "Overload or timeouts"],
    steps: [
      "Check server logs for these URLs at the time of the check",
      "Fix the failing templates or upstream services",
      "Re-check under load: intermittent 5xx errors often appear only at busy times",
    ],
    verify: ["Every URL returns 200 on repeated checks", "URL Inspection 'Test live URL' succeeds"],
    doc: DOC.http,
  },
  url_redirect: {
    title: "Sitemaps list URLs that redirect", severity: "medium", category: "Sitemaps",
    what: "These sitemap URLs redirect elsewhere. Sitemaps should list only final, canonical URLs.",
    causes: ["The sitemap wasn't updated after URL changes or an http→https / www migration"],
    steps: ["Replace each URL in the sitemap with its final 200 destination", "Update internal links to the final URL"],
    verify: ["Every sitemap URL returns 200 directly"],
    doc: DOC.sitemap,
  },
  redirect_chain: {
    title: "Redirect chains (two or more hops)", severity: "low", category: "Crawling",
    what: "These URLs pass through more than one redirect before reaching the final page.",
    causes: ["Old redirects were stacked during several migrations"],
    steps: ["Redirect each starting URL straight to the final URL", "Point links and sitemaps at the final URL"],
    verify: ["Each URL reaches its final page in one hop"],
    doc: DOC.redirects,
  },
  url_noindex: {
    title: "noindex pages that are in sitemaps or earn clicks (live check)", severity: "high", category: "Indexing",
    what: "Our live check found a noindex (meta robots or X-Robots-Tag) on these pages.",
    causes: ["noindex left over from staging or a CMS/plugin setting", "A template or header applies noindex too broadly"],
    steps: ["Confirm whether each page should be indexed", "If yes, remove the noindex directive", "If no, remove it from sitemaps"],
    verify: ["The page source and headers show no noindex", "'Test live URL' shows 'Indexing allowed: Yes'"],
    doc: DOC.noindex,
  },
  url_robots_blocked: {
    title: "Sitemap URLs blocked by robots.txt (live check)", severity: "high", category: "Crawling",
    what: "Your current robots.txt blocks Googlebot from these sitemap URLs.",
    causes: ["A Disallow rule is broader than intended"],
    steps: [
      "Find the matching rule in robots.txt",
      "Narrow or remove it if these pages should rank",
      "Otherwise remove the URLs from sitemaps (and use noindex if they must stay out of Google)",
    ],
    verify: ["URL Inspection shows 'Crawl allowed: Yes'"],
    doc: DOC.robots,
  },
  url_canonical_elsewhere: {
    title: "Sitemap URLs whose canonical points to another URL", severity: "medium", category: "Canonicals",
    what: "These sitemap URLs declare a different URL as canonical, which sends Google mixed signals.",
    causes: ["The sitemap lists non-canonical variants", "Canonical tags point to the wrong URL"],
    steps: ["List only canonical URLs in sitemaps", "Where the canonical tag is wrong, make it self-referencing", "Make sure every canonical target returns 200"],
    verify: ["Each sitemap URL's canonical points to itself"],
    doc: DOC.canonical,
  },
  http_inconclusive: {
    title: "Pages our checker couldn't verify", severity: "low", category: "Crawling",
    what: "These URLs timed out, failed DNS, or answered 403/429/503 to our checker. That's often bot protection rather than a Google problem.",
    causes: ["Bot protection or rate limiting on the site", "Slow responses", "DNS problems"],
    steps: ["Re-run the check", "Compare with URL Inspection: if Google also reports errors, treat it as a server or firewall issue"],
    verify: ["The pages answer 200 to a re-check, or URL Inspection shows a successful fetch"],
    doc: DOC.http,
  },

  /* ---------- From the Sitemaps API ---------- */
  no_sitemaps: {
    title: "No sitemap submitted in Search Console", severity: "high", category: "Sitemaps",
    what: "Search Console lists no sitemaps for this property, so Google relies only on links to find pages.",
    causes: ["Never submitted, or removed during a migration"],
    steps: [
      "Generate an XML sitemap of canonical, indexable URLs",
      "Submit it in Search Console → Sitemaps",
      "Reference it in robots.txt with a Sitemap: line",
    ],
    verify: ["The Sitemaps report shows status 'Success'"],
    doc: DOC.sitemap,
  },
  sitemap_errors: {
    title: "Search Console reports errors in these sitemaps", severity: "high", category: "Sitemaps",
    what: "Google couldn't fully process these sitemaps.",
    causes: [
      "Invalid XML or an unsupported format",
      "URLs on another host or protocol",
      "A file over 50,000 URLs or 50 MB uncompressed",
      "The sitemap URL returns an error or redirects",
    ],
    steps: [
      "Open the sitemap in Search Console → Sitemaps to read the exact errors",
      "Fix the XML and URL format",
      "Split large files and use a sitemap index",
      "Resubmit the sitemap",
    ],
    verify: ["The Sitemaps report shows status 'Success'"],
    doc: DOC.sitemap,
  },
  sitemap_warnings: {
    title: "Search Console reports warnings in these sitemaps", severity: "medium", category: "Sitemaps",
    what: "Google processed these sitemaps but flagged problems.",
    causes: ["Listed URLs are blocked by robots.txt", "Invalid dates or tags"],
    steps: ["Read the warnings in Search Console → Sitemaps", "Fix them and resubmit"],
    verify: ["Warnings drop to zero after Google rereads the sitemap"],
    doc: DOC.sitemap,
  },
  sitemap_stale: {
    title: "Sitemaps Google hasn't read in 30+ days, or still pending", severity: "medium", category: "Sitemaps",
    what: "These sitemaps haven't been downloaded recently, so new URLs in them may not be discovered.",
    causes: ["The sitemap URL changed or returns an error", "Google sees no changes in it"],
    steps: ["Check the sitemap URL returns 200 with valid XML", "Resubmit it in Search Console", "Reference it in robots.txt"],
    verify: ["'Last read' updates in the Sitemaps report"],
    doc: DOC.sitemap,
  },

  /* ---------- From Search Analytics (window vs previous window) ---------- */
  traffic_drop: {
    title: "Pages that lost half or more of their clicks", severity: "high", category: "Performance",
    what: "These pages got at most half the clicks of the previous window of the same length.",
    causes: [
      "Lower rankings for their main queries",
      "An indexing or canonical change for the page",
      "Seasonality or lower demand",
      "Changes in the search results (new features or competitors)",
    ],
    steps: [
      "Compare positions before and after (in the evidence)",
      "Inspect each URL for indexing, canonical or fetch changes",
      "Compare the page's top queries before vs after in Search Console",
      "Look for content, template or internal-link changes in this window",
      "Check Google's Search Status Dashboard for ranking updates on the same dates",
    ],
    verify: ["Clicks recover in the next window of the same length"],
    doc: DOC.drops,
  },
  lost_visibility: {
    title: "Pages that stopped appearing in Google Search", severity: "high", category: "Performance",
    what: "These pages had impressions in the previous window and none in this one.",
    causes: ["The page was removed, redirected or returns errors", "noindex, or a canonical pointing elsewhere", "It was dropped from the index"],
    steps: ["Inspect each URL in Search Console", "Check the status code, noindex and canonical", "Restore the page, or redirect it on purpose"],
    verify: ["URL Inspection shows 'URL is on Google' and impressions return"],
    doc: DOC.drops,
  },
  position_drop: {
    title: "Pages whose average position fell by 5+ places", severity: "medium", category: "Performance",
    what: "These pages still appear but rank noticeably lower than in the previous window.",
    causes: ["Competitors improved", "The content went stale", "Internal linking or technical changes"],
    steps: [
      "Check which queries lost position for each page",
      "Compare with the pages now ranking for those queries",
      "Improve content depth, freshness and internal links",
      "Rule out technical changes (canonical, noindex, speed)",
    ],
    verify: ["Average position recovers in the next window"],
    doc: DOC.drops,
  },
  low_ctr: {
    title: "Low CTR for their ranking position", severity: "low", category: "Performance",
    what: "These pages get clicked far less than your own pages at the same position (the benchmark is in the evidence).",
    causes: ["The title or description doesn't match search intent", "Search features push the result down", "Competing results have rich results"],
    steps: [
      "Rewrite titles and descriptions to match the page's main queries",
      "Add eligible structured data",
      "Check how the result appears in Google for its top queries",
    ],
    verify: ["CTR rises in the next window at similar positions"],
  },
  cannibalization: {
    title: "Several of your pages compete for the same query", severity: "medium", category: "Performance",
    what: "For these queries, two or more of your pages each get a meaningful share of impressions, which can split ranking signals.",
    causes: ["Overlapping pages target the same topic", "Internal links are split between the pages"],
    steps: [
      "Pick one primary page per query",
      "Merge overlapping content into it and 301 the others, or give each page a clearly different focus",
      "Point internal links for that topic at the primary page",
    ],
    verify: ["One page gets most of the impressions for the query in the next window"],
    doc: DOC.canonical,
  },
};
