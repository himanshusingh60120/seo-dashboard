// lib/liveCheck.ts
// Server-side fetch that behaves like a crawler: redirects are followed one hop at a time
// (redirect: "manual") so every 3xx is recorded, the same way each hop is a separate request in
// Google's Crawl stats. 200 HTML responses are parsed for what Google reads: robots meta tag,
// X-Robots-Tag header, rel=canonical and <a href> links.

export type Hop = { url: string; status: number; location?: string };

export type LiveResult = {
  url: string;
  chain: Hop[];
  finalUrl: string;
  /** Status of the last response received; 0 = no response at all. */
  finalStatus: number;
  loop: boolean;
  tooManyHops: boolean;
  contentType: string;
  xRobotsTag: string;
  metaRobots: string;
  noindex: boolean;
  canonical: string;
  title: string;
  /** Rough count of visible words (scripts and styles removed). */
  words: number;
  links?: string[];
  error?: string;
  /** The server's time budget ran out before the chain finished. */
  outOfTime?: boolean;
  ms: number;
};

const UA = "Mozilla/5.0 (compatible; SearchDashboard/1.0)";
const MAX_HOPS = 10;
const MAX_HTML_CHARS = 3000000;
const MAX_LINKS = 3000;
const NOINDEX = /(^|[\s,;])(noindex|none)(?=$|[\s,;])/i;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** X-Robots-Tag can target one crawler ("otherbot: noindex"); only generic or googlebot values count. */
function headerNoindex(h: string): boolean {
  if (!h) return false;
  return h.split(",").reduce<{ agent: string; hit: boolean }>(
    (acc, part) => {
      const m = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(part);
      let directive = part;
      if (m && !/^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/i.test(m[1])) {
        acc.agent = m[1].toLowerCase();
        directive = m[2];
      }
      if ((acc.agent === "" || acc.agent === "googlebot") && NOINDEX.test(directive)) acc.hit = true;
      return acc;
    },
    { agent: "", hit: false }
  ).hit;
}

export function parseHtml(html: string, pageUrl: string) {
  let base = pageUrl;
  const baseTag = /<base\b[^>]*>/i.exec(html);
  if (baseTag) {
    const h = attrs(baseTag[0]).href;
    if (h) {
      try { base = new URL(h, pageUrl).toString(); } catch { /* keep page URL */ }
    }
  }
  // Scan the whole document: some frameworks stream metadata into <body> for non-bot user agents
  const robots: string[] = [];
  (html.match(/<meta\b[^>]*>/gi) || []).forEach((tag) => {
    const a = attrs(tag);
    const name = (a.name || "").toLowerCase();
    if ((name === "robots" || name === "googlebot") && a.content) robots.push(a.content);
  });
  let canonical = "";
  (html.match(/<link\b[^>]*>/gi) || []).forEach((tag) => {
    if (canonical) return;
    const a = attrs(tag);
    if (a.href && (a.rel || "").toLowerCase().split(/\s+/).indexOf("canonical") >= 0) {
      try { canonical = new URL(a.href, base).toString(); } catch { /* bad href */ }
    }
  });
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = t ? decode(t[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const words = (text.match(/[A-Za-z0-9\u00C0-\u024F]{2,}/g) || []).length;

  const links: string[] = [];
  const seen = new Set<string>();
  const tags = html.match(/<a\b[^>]*>/gi) || [];
  for (let i = 0; i < tags.length && links.length < MAX_LINKS; i++) {
    const href = (attrs(tags[i]).href || "").trim();
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      const s = u.toString();
      if (!seen.has(s)) {
        seen.add(s);
        links.push(s);
      }
    } catch { /* unparsable href */ }
  }
  return { metaRobots: robots.join(", "), canonical, title, words, links };
}

async function drain(res: Response) {
  try { await res.body?.cancel(); } catch { /* ignore */ }
}

export async function followChain(
  start: string,
  opts: { deadline: number; withLinks?: boolean; hopTimeoutMs?: number }
): Promise<LiveResult> {
  const t0 = Date.now();
  const out: LiveResult = {
    url: start, chain: [], finalUrl: start, finalStatus: 0, loop: false, tooManyHops: false,
    contentType: "", xRobotsTag: "", metaRobots: "", noindex: false, canonical: "", title: "", words: 0, ms: 0,
  };
  const visited = new Set<string>();
  let url = start;
  try {
    for (let hop = 0; ; hop++) {
      if (visited.has(url)) { out.loop = true; break; }
      if (hop > MAX_HOPS) { out.tooManyHops = true; break; }
      visited.add(url);
      const left = opts.deadline - Date.now();
      if (left < 2000) { out.outOfTime = true; out.error = "Time limit reached"; break; }
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(Math.min(opts.hopTimeoutMs || 10000, left)),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        let next = "";
        try { next = new URL(location, url).toString(); } catch { /* handled below */ }
        out.chain.push({ url, status: res.status, location: next || location });
        await drain(res);
        if (!next) { out.error = `Bad Location header: ${location}`; break; }
        url = next;
        continue;
      }
      out.chain.push({ url, status: res.status });
      out.finalUrl = url;
      out.finalStatus = res.status;
      out.contentType = res.headers.get("content-type") || "";
      out.xRobotsTag = res.headers.get("x-robots-tag") || "";
      if (res.status === 200 && /html/i.test(out.contentType)) {
        const p = parseHtml((await res.text()).slice(0, MAX_HTML_CHARS), url);
        out.metaRobots = p.metaRobots;
        out.canonical = p.canonical;
        out.title = p.title;
        out.words = p.words;
        if (opts.withLinks) out.links = p.links;
      } else await drain(res);
      break;
    }
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    out.error = err?.name === "TimeoutError" || err?.name === "AbortError" ? "Timed out" : err?.cause?.code || err?.message || "Request failed";
  }
  if (!out.finalStatus && out.chain.length) {
    const last = out.chain[out.chain.length - 1];
    out.finalUrl = last.location || last.url;
    out.finalStatus = last.status;
  }
  out.noindex = NOINDEX.test(out.metaRobots) || headerNoindex(out.xRobotsTag);
  out.ms = Date.now() - t0;
  return out;
}
