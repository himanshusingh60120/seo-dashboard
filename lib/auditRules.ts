// lib/auditRules.ts
// Shared by API routes and the browser: types, Search Console's reason catalogue, and the rules
// that turn evidence (URL Inspection record + live hop-by-hop fetch + verified referring pages)
// into a verdict and concrete fixes. Every action names the evidence it comes from.

import type { LiveResult } from "./liveCheck";
import type { RobotsVerdict } from "./robots";

/* ---------- Types ---------- */

export type GoogleView = {
  verdict: string;
  coverageState: string;
  indexingState: string;
  lastCrawlTime: string;
  googleCanonical: string;
  userCanonical: string;
  pageFetchState: string;
  robotsTxtState: string;
  crawledAs: string;
  sitemaps: string[];
  referringUrls: string[];
  link: string;
};

export type RefCheck = { url: string; status: "links" | "no_link" | "unreachable"; exact?: boolean; http: number; href?: string; note?: string };

export type AuditCheck = {
  url: string;
  checkedAt: string;
  google: GoogleView | null;
  googleError?: string;
  live: LiveResult | null;
  robots: RobotsVerdict | null;
  refs: RefCheck[];
  listedAs?: string;
};

export type CrawlResult = {
  url: string;
  skipped?: boolean;
  outside?: boolean;
  blocked?: boolean;
  rule?: string;
  live?: LiveResult;
  links?: string[];
  finalInternal?: boolean;
};

export type CrawlPage = {
  url: string;
  depth: number;
  inlinks: number;
  /** Up to 10 pages that link here. */
  sources: string[];
  inSitemap?: boolean;
  crawledAt?: string;
  tries?: number;
  status?: number;
  hops?: number;
  chain?: string;
  finalUrl?: string;
  loop?: boolean;
  blocked?: boolean;
  rule?: string;
  noindex?: boolean;
  canonical?: string;
  title?: string;
  words?: number;
  type?: string;
  error?: string;
  redirectedFrom?: number;
};

export type CrawlState = {
  startUrl: string;
  startedAt: string;
  max: number;
  respectRobots: boolean;
  queue: string[];
  pos: number;
  pages: Record<string, CrawlPage>;
  count: number;
  capped: boolean;
  sitemap?: Record<string, 1>;
};

/* ---------- URL helpers ---------- */

export function isInternal(url: string, siteUrl: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (siteUrl.startsWith("sc-domain:")) {
      const d = siteUrl.slice(10).toLowerCase();
      return u.hostname === d || u.hostname.endsWith(`.${d}`);
    }
    return url.startsWith(siteUrl) || url === siteUrl.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return u;
  }
}

/** Same page ignoring www., a trailing slash and the protocol. */
export function looseKey(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "") || "/"}${x.search}`;
  } catch {
    return u;
  }
}
export const sameUrlLoose = (a: string, b: string) => looseKey(a) === looseKey(b);

export function chainLabel(l: LiveResult): string {
  if (!l.chain.length) return l.error ? `no response (${l.error})` : "no response";
  return (
    l.chain.map((h) => String(h.status || "no response")).join(" → ") +
    (l.loop ? " → loop" : l.tooManyHops ? " → …" : "") +
    (l.error ? ` (${l.error})` : "")
  );
}

/* ---------- Search Console reasons ---------- */

export type ReasonKey =
  | "robots" | "redirect" | "notFound" | "soft404" | "alternate" | "noindex" | "redirectError" | "server"
  | "crawledNot" | "discoveredNot" | "canonicalMismatch" | "duplicateNoCanonical" | "blocked4xx" | "unknown" | "indexed";

export type Reason = { label: string; source: "Website" | "Google systems"; kind: "fix" | "review" | "expected" | "ok"; meaning: string; fixes: string[] };

export const REASONS: Record<ReasonKey, Reason> = {
  robots: {
    label: "Blocked by robots.txt", source: "Website", kind: "expected",
    meaning: "A robots.txt rule stops Googlebot fetching the URL. Usually intentional.",
    fixes: [
      "Confirm the matching rule (shown per URL) is meant to block it.",
      "Keep blocked URLs out of sitemaps.",
      "To keep a page out of Google, allow crawling and use noindex instead: Google can't see a noindex on a page it may not fetch.",
      "Don't block CSS, JS or API calls a page needs to render its main content.",
    ],
  },
  redirect: {
    label: "Page with redirect", source: "Website", kind: "expected",
    meaning: "The URL redirects, so only its target can be indexed. Normal for old URLs and http / non-www variants.",
    fixes: ["Point internal links, canonicals and sitemap entries at the final URL.", "Collapse chains to one hop: every hop is a separate crawl request."],
  },
  notFound: {
    label: "Not found (404)", source: "Website", kind: "fix",
    meaning: "The URL returned 404. Fine for removed pages with no replacement; Google suggests fixing only 404s you link to yourself or list in a sitemap.",
    fixes: ["Moved: 301 it to the new URL.", "Gone: keep the 404/410 and remove the internal links and sitemap entries (sources are listed per URL)."],
  },
  soft404: {
    label: "Soft 404", source: "Website", kind: "fix",
    meaning: "The page looks like a 'not found' page but returns 200.",
    fixes: ["Return a real 404/410 for missing content, or give the page real content."],
  },
  alternate: {
    label: "Alternate page with proper canonical tag", source: "Website", kind: "expected",
    meaning: "An alternate version that correctly points to an indexed canonical.",
    fixes: ["Nothing to do."],
  },
  noindex: {
    label: "Excluded by ‘noindex’ tag", source: "Website", kind: "review",
    meaning: "Google found a noindex directive (robots meta tag or X-Robots-Tag header).",
    fixes: ["If the page should rank: remove noindex, then Request indexing.", "If intentional: keep it out of sitemaps."],
  },
  redirectError: {
    label: "Redirect error", source: "Website", kind: "fix",
    meaning: "The redirect chain was too long, looped, exceeded the max URL length, or contained a bad or empty URL.",
    fixes: ["Make the URL redirect once, straight to a page that returns 200, then Validate fix."],
  },
  server: {
    label: "Server error (5xx)", source: "Website", kind: "fix",
    meaning: "Your server returned a 5xx when Google requested the page.",
    fixes: ["If the live check returns 200 it was transient: Validate fix and watch Host status in Crawl stats.", "If it still fails: fix the error or timeout behind it."],
  },
  crawledNot: {
    label: "Crawled - currently not indexed", source: "Google systems", kind: "review",
    meaning: "Google fetched the page and chose not to index it for now. Not a technical block; resubmitting alone won't change it.",
    fixes: [
      "Make the page clearly more useful than similar pages; merge or noindex thin and near-duplicate pages.",
      "Link to it from related, indexed pages.",
      "Check URL Inspection → View crawled page to confirm the main content is in the rendered HTML.",
    ],
  },
  discoveredNot: {
    label: "Discovered - currently not indexed", source: "Google systems", kind: "review",
    meaning: "Google knows the URL but hasn't crawled it; typically it postponed the crawl to avoid overloading the site.",
    fixes: [
      "Cut wasted crawl requests (redirect hops, 404s) so more go to real pages.",
      "Link to these pages from pages Google crawls; keep them in sitemaps with an accurate lastmod.",
      "Keep server response times low.",
    ],
  },
  canonicalMismatch: {
    label: "Duplicate, Google chose different canonical than user", source: "Google systems", kind: "review",
    meaning: "Your canonical and Google's choice differ.",
    fixes: ["Compare the page, your canonical and Google's choice.", "Duplicates: consolidate on one URL (canonical, internal links, sitemap). Not duplicates: make the content clearly different."],
  },
  duplicateNoCanonical: {
    label: "Duplicate without user-selected canonical", source: "Google systems", kind: "review",
    meaning: "A duplicate with no declared canonical; Google picked another URL.",
    fixes: ["Add rel=canonical on the version you want, or make the pages distinct."],
  },
  blocked4xx: {
    label: "Blocked (401 / 403 / other 4xx)", source: "Website", kind: "fix",
    meaning: "The server refused the request. Googlebot never sends credentials.",
    fixes: ["Allow anonymous access if it should be indexed; otherwise stop linking to it."],
  },
  unknown: {
    label: "URL is unknown to Google", source: "Google systems", kind: "review",
    meaning: "Google has no record of the URL.",
    fixes: ["Link to it from a crawled page and list it in a sitemap."],
  },
  indexed: { label: "Indexed", source: "Google systems", kind: "ok", meaning: "The URL is in Google's index.", fixes: [] },
};

export function reasonOf(state: string): ReasonKey {
  const s = (state || "").toLowerCase().replace(/[\u2010-\u2015]/g, "-");
  if (s.includes("indexed, though")) return "indexed";
  if (s.includes("robots")) return "robots";
  if (s.includes("redirect error")) return "redirectError";
  if (s.includes("redirect")) return "redirect";
  if (s.includes("soft 404")) return "soft404";
  if (s.includes("404")) return "notFound";
  if (s.includes("5xx") || s.includes("server error")) return "server";
  if (s.includes("noindex")) return "noindex";
  if (s.includes("crawled - currently")) return "crawledNot";
  if (s.includes("discovered - currently")) return "discoveredNot";
  if (s.includes("google chose different canonical")) return "canonicalMismatch";
  if (s.includes("duplicate")) return "duplicateNoCanonical";
  if (s.includes("alternate") || s.includes("alternative")) return "alternate";
  if (/\b(401|403|4xx)\b/.test(s)) return "blocked4xx";
  if (s.includes("unknown")) return "unknown";
  if (s.includes("indexed")) return "indexed";
  return "unknown";
}

export function listReason(id: string): ReasonKey | null {
  if (id === "crawl:404") return "notFound";
  if (id === "crawl:301") return "redirect";
  return id in REASONS ? (id as ReasonKey) : null;
}

/* ---------- Verdicts and actions ---------- */

export type Verdict = "failing" | "fixed" | "expected" | "review" | "error";
export const VERDICT_LABEL: Record<Verdict, string> = {
  failing: "Still failing",
  fixed: "Fixed – validate in GSC",
  expected: "Working as intended",
  review: "Needs a decision",
  error: "Check failed",
};
export const VERDICT_PILL: Record<Verdict, string> = { failing: "no", fixed: "ok", expected: "ok", review: "warn", error: "warn" };

export type ActionKind =
  | "brokenLink" | "sitemapRemove" | "linkToRedirect" | "chain" | "loop" | "serverError" | "access"
  | "noindex" | "robotsConflict" | "canonical" | "quality" | "discovery" | "validate" | "restoreOrRedirect" | "info";

export const ACTION_LABEL: Record<ActionKind, string> = {
  loop: "Fix a redirect loop / redirect error",
  serverError: "Fix a server error",
  access: "Allow Googlebot access (401/403)",
  brokenLink: "Remove or fix a broken internal link",
  sitemapRemove: "Fix a sitemap entry",
  chain: "Shorten a redirect chain to one hop",
  linkToRedirect: "Point a link straight at the final URL",
  robotsConflict: "Resolve a robots.txt conflict",
  noindex: "Review a noindex",
  canonical: "Resolve a canonical conflict",
  restoreOrRedirect: "Decide: 301 to a replacement or leave the 404",
  discovery: "Help Google discover and crawl",
  quality: "Improve or consolidate content",
  validate: "Already fixed – click Validate fix",
  info: "No action needed",
};

export const ACTION_PRIORITY: Record<ActionKind, number> = {
  loop: 1, serverError: 1, access: 1, brokenLink: 2, sitemapRemove: 2, chain: 3, linkToRedirect: 3,
  robotsConflict: 3, noindex: 4, canonical: 4, restoreOrRedirect: 4, discovery: 5, quality: 5, validate: 6, info: 9,
};

export type Action = { kind: ActionKind; text: string; url: string; page?: string };
export type Diagnosis = { verdict: Verdict; summary: string; actions: Action[]; reason: ReasonKey };

export function diagnose(c: AuditCheck): Diagnosis {
  const g = c.google;
  const l = c.live;
  const listed = c.listedAs ? listReason(c.listedAs) : null;
  const now = g ? reasonOf(g.coverageState) : null;
  const key: ReasonKey = listed || now || "unknown";
  const actions: Action[] = [];
  const add = (kind: ActionKind, text: string, page?: string) => actions.push({ kind, text, page, url: c.url });
  const out = (verdict: Verdict, summary: string): Diagnosis => ({ verdict, summary, actions, reason: key });

  if (!g && !l) return out("error", c.googleError || "Not checked");

  const final = l ? l.finalStatus : -1;
  const hops = l ? Math.max(0, l.chain.length - 1) : 0;
  const chain = l ? chainLabel(l) : "";
  const sitemaps = g ? g.sitemaps : [];
  const confirmed = c.refs.filter((r) => r.status === "links" && r.exact);
  const crawled = g && g.lastCrawlTime ? ` (Google last crawled it ${g.lastCrawlTime.slice(0, 10)})` : "";
  const gone = final === 404 || final === 410;
  const canonElsewhere = !!(l && l.finalStatus === 200 && l.canonical && !sameUrlLoose(l.canonical, l.finalUrl));

  // What the live fetch shows, whatever Google's label says
  if (l && (l.loop || l.tooManyHops)) add("loop", `Redirects never settle (${chain}). Make it redirect once, straight to a page that returns 200.`);
  else if (l && hops >= 2) add("chain", `${hops} redirect hops (${chain}). Redirect the first URL straight to ${l.finalUrl}.`);
  if (final >= 500) add("serverError", `Returns HTTP ${final} right now.`);
  if (final === 401 || final === 403) add("access", `Returns HTTP ${final}. Googlebot never logs in: allow access or stop linking to it.`);
  if (sitemaps.length && l) {
    const why = gone
      ? `it returns ${final}`
      : hops > 0 && final === 200
      ? `it redirects to ${l.finalUrl}; list that URL instead`
      : l.noindex
      ? "the page is noindex"
      : c.robots && c.robots.allowed === false
      ? `robots.txt blocks it (${c.robots.rule})`
      : canonElsewhere
      ? `its canonical is ${l.canonical}; list that URL instead`
      : "";
    if (why) sitemaps.forEach((s) => add("sitemapRemove", `This sitemap lists the URL but ${why}.`, s));
  }

  // Listed as a problem, but Google now reports it indexed
  if (listed && listed !== "indexed" && now === "indexed") {
    add("validate", `Google now reports “${g ? g.coverageState : ""}”${crawled}. Validate fix on the issue in Search Console.`);
    return out("fixed", "Indexed now");
  }

  switch (key) {
    case "notFound":
    case "soft404": {
      if (gone || (key === "soft404" && final === 200 && hops === 0)) {
        confirmed.forEach((r) => add("brokenLink", `This page still links to it (href="${r.href}"). Remove the link or point it at a live page.`, r.url));
        if (!confirmed.length && !sitemaps.length) {
          add(
            "restoreOrRedirect",
            (g && g.referringUrls.length
              ? `Google lists ${g.referringUrls.length} referring URL(s); none of those re-checked still link here.`
              : "Google reports no referring page or sitemap.") +
              " If the content moved, 301 this URL to its new home; if it is gone for good, leaving the 404 is fine."
          );
        }
        return out(confirmed.length || sitemaps.length ? "failing" : "expected", `Still returns ${final}${crawled}`);
      }
      if (final === 200 && l) {
        add("validate", `${hops ? `Now redirects to ${l.finalUrl}, which returns 200` : "Now returns 200"}${crawled}. Use “Validate fix” on this issue in Search Console.`);
        return out("fixed", hops ? `Fixed: ${chain}` : "Fixed: returns 200");
      }
      break;
    }
    case "redirectError": {
      if (l && (l.loop || l.tooManyHops || final >= 400 || final === 0)) return out("failing", `Still broken: ${chain}`);
      if (final === 200) {
        add("validate", `Now resolves in ${hops} hop(s) to a 200 page${crawled}. Use “Validate fix”.`);
        return out("fixed", `Fixed: ${chain}`);
      }
      break;
    }
    case "server": {
      if (l && (final >= 500 || final === 0)) return out("failing", final ? `Still returns ${final}` : `No response: ${l.error || ""}`);
      if (final === 200) {
        add("validate", `Returns 200 now${crawled}; the error was probably temporary. Use “Validate fix” and watch Host status in Crawl stats.`);
        return out("fixed", "Returns 200 now");
      }
      break;
    }
    case "redirect": {
      confirmed.forEach((r) => add("linkToRedirect", `Change this link (href="${r.href}") to ${l ? l.finalUrl : "the final URL"}.`, r.url));
      if (l && final === 200 && hops >= 1) return out(actions.length ? "review" : "expected", `Redirects: ${chain}`);
      if (l && final === 200 && hops === 0) return out("review", "No longer redirects: it returns 200 itself now.");
      break;
    }
    case "robots": {
      if (c.robots && c.robots.allowed === false) {
        const rule = c.robots.rule;
        confirmed.forEach((r) => add("robotsConflict", `Links to a URL that robots.txt blocks (${rule}). Fine if intended; otherwise unblock it or drop the link.`, r.url));
        return out(actions.length ? "review" : "expected", `Blocked by ${rule}`);
      }
      if (c.robots && c.robots.allowed === true) {
        add("validate", "robots.txt no longer blocks this URL; Google picks that up on its next robots.txt fetch and crawl.");
        return out("fixed", "Not blocked any more");
      }
      break;
    }
    case "noindex": {
      if (l && l.noindex) {
        const where = l.metaRobots && /noindex|none/i.test(l.metaRobots) ? `robots meta tag (“${l.metaRobots}”)` : `X-Robots-Tag header (“${l.xRobotsTag}”)`;
        add("noindex", `noindex found in the ${where}. Remove it only if this page should appear in Google.`);
        return out("review", "noindex on the live page");
      }
      if (final === 200) {
        add("validate", "No noindex on the live page any more. Request indexing in URL Inspection.");
        return out("fixed", "noindex removed");
      }
      break;
    }
    case "crawledNot": {
      const thin = l && final === 200 && l.words < 250 ? ` The page has only about ${l.words} words of visible text (rough count).` : "";
      add("quality", `Google fetched it and chose not to index it${crawled}.${thin} Make it clearly more useful than similar pages, merge near-duplicates, and link to it from related indexed articles.`);
      return out("review", "Google chose not to index it (quality / duplication)");
    }
    case "discoveredNot": {
      add("discovery", `Google knows the URL but hasn't crawled it yet.${sitemaps.length ? "" : " No sitemap Google knows of lists it; add it to one."} Link to it from pages Google already crawls and cut wasted requests (redirect hops, 404s).`);
      return out("review", "Waiting to be crawled");
    }
    case "canonicalMismatch":
    case "duplicateNoCanonical": {
      add("canonical", `Your canonical: ${(g && g.userCanonical) || (l && l.canonical) || "none declared"} · Google's choice: ${(g && g.googleCanonical) || "–"}. If duplicates, point canonical, internal links and sitemap at one URL; if not, make the content clearly different.`);
      return out("review", "Google picked a different canonical");
    }
    case "alternate":
      return out("expected", "Points to its canonical correctly");
    case "blocked4xx": {
      if (l && final >= 400 && final < 500 && !gone) return out("failing", `Still returns ${final}`);
      if (final === 200) {
        add("validate", `Returns 200 now${crawled}. Use “Validate fix”.`);
        return out("fixed", "Accessible now");
      }
      break;
    }
    case "indexed":
      return out(actions.length ? "review" : "expected", g ? g.coverageState : "Indexed");
  }
  return out(actions.length ? "review" : "review", g ? g.coverageState : `Live: ${chain}`);
}

/** Fixes found by the site crawl; `page` is the page to edit. */
export function crawlActions(s: CrawlState): Action[] {
  const out: Action[] = [];
  Object.keys(s.pages).forEach((k) => {
    const p = s.pages[k];
    if (!p.crawledAt) return;
    const add = (kind: ActionKind, text: string, page?: string) => out.push({ kind, text, page, url: p.url });
    if (p.blocked) {
      if (p.inSitemap) add("sitemapRemove", `Your sitemap lists this URL but robots.txt blocks it (${p.rule}).`, "your sitemap");
      return;
    }
    if (p.loop) add("loop", `Redirects never settle (${p.chain}).`);
    if (p.status === 404 || p.status === 410) {
      p.sources.forEach((src) => add("brokenLink", `Links to this URL, which returns ${p.status}.`, src));
      if (p.inlinks > p.sources.length) add("brokenLink", `${p.inlinks - p.sources.length} more internal links point here (only the first ${p.sources.length} pages are kept; re-crawl after fixing).`);
      if (p.inSitemap) add("sitemapRemove", `Your sitemap lists a URL that returns ${p.status}.`, "your sitemap");
    } else if ((p.status ?? -1) >= 500 || (p.status === 0 && !!p.error)) {
      add("serverError", `Returned ${p.status || p.error} during the crawl.`);
    }
    if ((p.hops || 0) > 0 && p.status === 200) {
      p.sources.forEach((src) => add("linkToRedirect", `Links to a redirecting URL (${p.chain}); link straight to ${p.finalUrl}.`, src));
      if ((p.hops || 0) >= 2) add("chain", `${p.hops} redirect hops (${p.chain}) before ${p.finalUrl}.`);
      if (p.inSitemap) add("sitemapRemove", `Your sitemap lists a redirecting URL; list ${p.finalUrl} instead.`, "your sitemap");
    }
    if (p.status === 200 && !p.hops) {
      if (p.noindex && p.inSitemap) add("sitemapRemove", "Your sitemap lists a noindex page.", "your sitemap");
      if (p.canonical && !sameUrlLoose(p.canonical, p.url) && p.inSitemap) add("sitemapRemove", `Your sitemap lists a URL whose canonical is ${p.canonical}.`, "your sitemap");
    }
  });
  return out;
}
