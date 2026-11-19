// lib/audit/investigateCatalog.ts
// Shared (browser + server). Issue types found by the Site investigation's quick checks (lib/investigate.ts), each with
// a standard fix. Merged into CATALOG in ./catalog, so the AI fix step, the HTML report and the tab treat them like
// every other issue. Severity is fixed here, never chosen by the AI.
import type { CatalogEntry } from "./catalog";

export type InvestigateType =
  | "ga4_pairing" | "bot_traffic" | "foreign_hostnames" | "low_quality_sources" | "search_vs_traffic" | "clicks_decline"
  | "index_drop" | "index_reasons_growth" | "captures_stale" | "crawl_drop" | "crawl_slow"
  | "sitemaps_unread" | "sitemap_index_missing" | "sitemap_thin_sections" | "sitemap_no_lastmod" | "host_variants";

const DOC = {
  drops: "https://developers.google.com/search/docs/monitor-debug/debugging-search-traffic-drops",
  pages: "https://support.google.com/webmasters/answer/7440203",
  crawl: "https://support.google.com/webmasters/answer/9679690",
  sitemap: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap",
  redirects: "https://developers.google.com/search/docs/crawling-indexing/301-redirects",
  canonical: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
  ga4Filters: "https://support.google.com/analytics/answer/10108813",
};

export const INVESTIGATE_CATALOG: Record<InvestigateType, CatalogEntry> = {
  ga4_pairing: {
    title: "The GA4 property chosen for this site has (almost) no data", severity: "high", category: "Site setup",
    what: "The GA4 property selected in the top bar has far fewer sessions than another GA4 property for the same site, so this site's traffic figures are wrong or empty.",
    causes: ["An old or test GA4 property has a web stream for the same address", "The site's tag sends data to a different property than the one selected"],
    steps: [
      "Select the GA4 property marked “used here” in the top bar",
      "Rename or delete the unused property's web stream so it can't be picked by mistake",
      "If both are meant to have data, check which measurement ID the site's tag actually uses",
    ],
    verify: ["The dashboard's traffic figures match GA4's own Reports snapshot for the same dates"],
  },
  bot_traffic: {
    title: "Traffic that looks like bots, not readers", severity: "high", category: "Traffic",
    what: "Several signs together point to automated traffic: almost no reading time, very low engagement, a sudden jump, or one country or city taking most sessions. It inflates sessions and hides how real readers behave.",
    causes: [
      "Scrapers or bot networks loading pages (often from data-centre cities such as Singapore or Ashburn)",
      "Low-quality paid or exchanged traffic that started on the jump date",
      "Monitoring or testing tools that run JavaScript",
    ],
    steps: [
      "In GA4 → Explore, break the jump down by country, city, source / medium, browser and operating system to find what the bot sessions share",
      "Block that pattern at the CDN or host (for example a Cloudflare bot or WAF rule), keeping verified search-engine crawlers allowed",
      "Stop any paid or exchanged traffic campaign that started on the same date",
      "Until it's gone, report engaged sessions rather than sessions",
    ],
    verify: ["Average engagement time and engagement rate return to their usual level", "Daily sessions fall back to the baseline before the jump"],
    doc: DOC.ga4Filters,
  },
  foreign_hostnames: {
    title: "GA4 receives visits recorded on other websites", severity: "high", category: "Traffic",
    what: "Some sessions in this GA4 property were recorded on hostnames that aren't this site, so another site, a copy of it, or fake hits use your GA4 tag.",
    causes: ["Your tag was copied onto another site, or a scraper republishes your pages with the tag", "Staging or old domains still carry the tag", "Fake hits sent with your measurement ID"],
    steps: [
      "Check each hostname in the evidence",
      "Remove the tag from staging and old domains",
      "Filter reports to your own hostnames, and block scrapers that copy the site at the CDN",
    ],
    verify: ["GA4's Hostname dimension shows only your own domains"],
    doc: DOC.ga4Filters,
  },
  low_quality_sources: {
    title: "Traffic sources with almost no engagement", severity: "medium", category: "Traffic",
    what: "These sources send a noticeable share of sessions, but almost nobody engages. That usually means bots, link previews or misattributed traffic.",
    causes: ["Bots arriving as direct or referral traffic", "Link-preview fetchers from apps", "Paid placements that buy low-quality clicks"],
    steps: [
      "Look at each source's country, city and device breakdown in GA4 → Explore",
      "Block automated sources at the CDN; stop paying for low-quality placements",
      "Exclude these sources from performance reporting until fixed",
    ],
    verify: ["Engagement rate for these sources rises, or the sources disappear"],
  },
  search_vs_traffic: {
    title: "Google Search and GA4 traffic don't add up", severity: "high", category: "Performance",
    what: "Search Console clicks and GA4's Organic Search sessions disagree far more than usual, or the site has plenty of traffic but almost no visibility in Google Search.",
    causes: [
      "The site has lost most of its Google visibility (see the indexing findings)",
      "The Search Console property doesn't cover the address the site really uses",
      "GA4 tagging or channel rules count search visits wrongly",
      "Most visits come from other sources, including bots",
    ],
    steps: [
      "Confirm the Search Console property covers the site's real address (a domain property covers every variant)",
      "Read the indexing, bot-traffic and pairing findings in this report first",
      "Compare GA4 Organic Search with Search Console clicks for the same dates",
    ],
    verify: ["Organic Search sessions and Search Console clicks move together within a normal range"],
    doc: DOC.drops,
  },
  clicks_decline: {
    title: "Google clicks fell sharply", severity: "high", category: "Performance",
    what: "Clicks in the last 28 days are at least 30% below the 28 days before. The evidence shows when the sharpest fall started.",
    causes: ["Pages dropped from Google's index", "A Google ranking update", "A technical change (noindex, redirects, robots.txt, canonical)", "Seasonality"],
    steps: [
      "Match the fall's start date with the timeline in this report",
      "Check Google's Search Status Dashboard for ranking updates on that date",
      "In Performance, find which pages and queries lost the most",
      "Fix any technical cause found elsewhere in this report",
    ],
    verify: ["Clicks recover towards the earlier level in the following weeks"],
    doc: DOC.drops,
  },
  index_drop: {
    title: "Indexed pages fell sharply", severity: "critical", category: "Indexing",
    what: "Google's Page indexing report shows the number of indexed pages falling by 30% or more from its recent peak. The evidence shows when the fall started.",
    causes: [
      "Google judged many pages low-value or duplicate (for example press releases republished word for word)",
      "A site change: noindex, canonical tags, a plugin or theme update, robots.txt",
      "Server errors or outages while Googlebot was crawling",
      "Sitemaps removed or changed, so Google stopped revisiting pages",
    ],
    steps: [
      "Match the start date with the timeline (sitemap reads, crawl and traffic changes) and with site changes made then",
      "Open the reasons that grew in Indexing → Pages and inspect example URLs, including the Google-selected canonical",
      "Fix technical causes first (noindex, canonicals, sitemaps, server errors)",
      "For duplicate or thin content, add original value or set noindex on pure reposts",
    ],
    verify: ["The indexed count stops falling and recovers in Indexing → Pages over the following weeks"],
    doc: DOC.pages,
  },
  index_reasons_growth: {
    title: "Reasons for not indexing are growing", severity: "medium", category: "Indexing",
    what: "These “Why pages aren't indexed” reasons grew by 50% or more (and at least 50 pages) compared with an earlier capture.",
    causes: ["New pages Google doesn't consider worth indexing", "A site change that added noindex, redirects or duplicates", "Google discovering many URLs it hasn't crawled yet"],
    steps: ["Open each reason in Indexing → Pages and look at example URLs", "Fix site-side reasons (noindex, redirects, canonicals) first", "Improve or consolidate pages Google declines to index"],
    verify: ["The reason's page count stops growing in later captures"],
    doc: DOC.pages,
  },
  captures_stale: {
    title: "Search Console captures are out of date", severity: "low", category: "Site setup",
    what: "The latest Page indexing or Crawl stats capture is more than 10 days old, so the indexing and crawl checks use old numbers.",
    causes: ["The Chrome extension hasn't been run on this property recently"],
    steps: ["Run the extension (or “Get fresh GSC data”) on this property", "Run the investigation again"],
    verify: ["The capture date in the evidence is within the last week"],
  },
  crawl_drop: {
    title: "Googlebot is crawling much less", severity: "high", category: "Crawling",
    what: "Daily crawl requests over the last 14 days are at least 40% below the 4 weeks before.",
    causes: ["Server errors or slow responses made Google back off", "Google sees less value in crawling the site", "Sitemaps stopped being read", "robots.txt or firewall rules blocking Googlebot"],
    steps: [
      "Check Settings → Crawl stats → Host status and the By response breakdown",
      "Compare the start date with server, CDN or firewall changes",
      "Make sure sitemaps are submitted and read",
    ],
    verify: ["Crawl requests return to the earlier level in Crawl stats"],
    doc: DOC.crawl,
  },
  crawl_slow: {
    title: "Server responds slowly to Googlebot", severity: "medium", category: "Crawling",
    what: "Average response time to Googlebot over the last 14 days is at least 50% higher than the 4 weeks before, and above 500 ms.",
    causes: ["Server overload (including bot traffic)", "Slow database or plugins", "Missing caching"],
    steps: ["Enable page caching and a CDN", "Block abusive bots that load the server", "Profile the slowest templates"],
    verify: ["Average response time in Crawl stats falls back"],
    doc: DOC.crawl,
  },
  sitemaps_unread: {
    title: "Google hasn't read any sitemap for 14+ days", severity: "high", category: "Sitemaps",
    what: "None of the submitted sitemaps has been downloaded by Google in the last 14 days, so new pages are found more slowly.",
    causes: ["Sitemap addresses changed (SEO plugin update or switch)", "Sitemaps return errors or redirects", "Sitemaps were removed from Search Console"],
    steps: ["Open each sitemap address and confirm it loads as XML", "Submit the sitemap index again in Search Console", "List it in robots.txt with a Sitemap: line"],
    verify: ["“Last read” updates in Search Console → Sitemaps"],
    doc: DOC.sitemap,
  },
  sitemap_index_missing: {
    title: "Individual sitemap files submitted instead of the sitemap index", severity: "medium", category: "Sitemaps",
    what: "Search Console lists several numbered sitemap files but no sitemap index, so new files the site adds later won't be submitted automatically.",
    causes: ["Files were added one by one after the index was lost or removed"],
    steps: ["Submit the site's sitemap index (for Yoast: /sitemap_index.xml)", "Remove the individual files from Search Console once the index is read"],
    verify: ["Search Console → Sitemaps shows the index with its files listed under it"],
    doc: DOC.sitemap,
  },
  sitemap_thin_sections: {
    title: "Sitemaps list tag, template or author pages", severity: "medium", category: "Sitemaps",
    what: "The sitemap index includes sitemaps of tag, template or author pages. These are usually thin lists of links, and offering thousands of them to Google wastes crawling and lowers how Google rates the site.",
    causes: ["SEO plugin default settings", "Theme template pages exposed as a post type"],
    steps: [
      "In the SEO plugin, set tags (and theme templates) to not show in search results, which also removes their sitemaps",
      "Keep author archives only if they have real content",
      "Resubmit the sitemap index",
    ],
    verify: ["The sitemap index no longer lists these sitemaps"],
    doc: DOC.sitemap,
  },
  sitemap_no_lastmod: {
    title: "Sitemaps have no last-modified dates", severity: "low", category: "Sitemaps",
    what: "The sitemaps don't give a <lastmod> date, so Google can't tell which pages are new or changed and must recrawl to find out.",
    causes: ["The sitemap generator doesn't output lastmod"],
    steps: ["Add an accurate <lastmod> for every URL (only change it when content really changes)", "Split very large sitemaps into files of up to 50,000 URLs"],
    verify: ["The sitemap shows <lastmod> on every URL"],
    doc: DOC.sitemap,
  },
  host_variants: {
    title: "The site's address variants don't all lead to one address", severity: "medium", category: "Crawling",
    what: "Opening the site as http/https and with/without www should end on one address via a single redirect. These variants end elsewhere, answer without redirecting, or take several hops.",
    causes: ["Missing redirect rules at the host or CDN", "Redirect rules stacked over several migrations"],
    steps: ["Pick one address (for example https://example.com)", "301-redirect every other variant to it in one hop", "Use that address in canonical tags, sitemaps and internal links"],
    verify: ["Each variant returns one 301 to the chosen address, which returns 200"],
    doc: DOC.redirects,
  },
};
