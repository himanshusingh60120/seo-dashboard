// lib/safeFetch.ts
// Server-only. Fetches pages on your own sites safely: http(s) on standard ports, public IP addresses only
// (re-checked on every redirect hop), timeouts and size limits. Reads robots.txt the way Googlebot does and
// pulls noindex / canonical from pages. Free: no third-party APIs.
import { lookup } from "dns/promises";
import { isIP } from "net";
import { normalizeUrl } from "./url";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 KRSearchDashboard/2.0";

export class BlockedUrlError extends Error {}

function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))
  );
}

function privateIp(ip: string) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) {
    const rest = v.slice(7);
    return rest.includes(":") ? true : privateV4(rest);
  }
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || v.startsWith("fe80");
}

export async function assertPublicUrl(raw: string, allowHost?: (host: string) => boolean): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError("Only http and https URLs can be checked");
  if (u.port && u.port !== "80" && u.port !== "443") throw new BlockedUrlError("Only standard ports can be checked");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowHost && !allowHost(host)) throw new BlockedUrlError(`${host} isn't part of your Search Console properties`);
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new BlockedUrlError(`DNS lookup failed for ${host}`);
  }
  if (!addrs.length || addrs.some(privateIp)) throw new BlockedUrlError("Private or reserved network address");
  return u;
}

export type Hop = { url: string; status: number };
export type FetchResult = { res: Response | null; chain: Hop[]; finalUrl: string; loop: boolean };

/** Follows redirects by hand so every hop is recorded and re-checked. `allowHost` applies to the first URL. */
export async function safeFetch(
  url: string,
  opts: { allowHost?: (h: string) => boolean; maxRedirects?: number; timeoutMs?: number; accept?: string } = {}
): Promise<FetchResult> {
  const chain: Hop[] = [];
  let cur = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    await assertPublicUrl(cur, hop === 0 ? opts.allowHost : undefined);
    const res = await fetch(cur, {
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": UA, Accept: opts.accept || "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    chain.push({ url: cur, status: res.status });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(loc, cur).toString();
      if (chain.some((h) => h.url === next)) return { res: null, chain, finalUrl: next, loop: true };
      cur = next;
      continue;
    }
    return { res, chain, finalUrl: cur, loop: false };
  }
  return { res: null, chain, finalUrl: cur, loop: false };
}

/** Reads at most `maxBytes` of a response body. */
export async function readText(res: Response, maxBytes = 600_000) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Buffer[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    parts.push(Buffer.from(value));
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(parts).toString("utf8");
}

/* ---------- robots.txt ---------- */

type Rule = { allow: boolean; path: string };
export type Robots = { groups: { agents: string[]; rules: Rule[] }[]; sitemaps: string[] };

export function parseRobots(txt: string): Robots {
  const groups: Robots["groups"] = [];
  const sitemaps: string[] = [];
  let cur: Robots["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, "").trim();
    const m = clean.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur && (field === "allow" || field === "disallow")) cur.rules.push({ allow: field === "allow", path: value });
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath: string, path: string) {
  if (!rulePath) return false; // empty Disallow allows everything
  const anchored = rulePath.endsWith("$");
  const body = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** Googlebot's view: its own group if there is one (else "*"), longest matching rule wins, Allow wins ties. */
export function robotsAllows(r: Robots, pathWithQuery: string) {
  const own = r.groups.filter((g) => g.agents.includes("googlebot"));
  const groups = own.length ? own : r.groups.filter((g) => g.agents.includes("*"));
  let best: Rule | null = null;
  for (const g of groups) {
    for (const rule of g.rules) {
      if (!ruleMatches(rule.path, pathWithQuery)) continue;
      if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
    }
  }
  return !best || best.allow;
}

const robotsCache = new Map<string, { at: number; robots: Robots | null }>();

export async function getRobots(origin: string): Promise<Robots | null> {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.robots;
  let robots: Robots | null = null;
  try {
    const r = await safeFetch(`${origin}/robots.txt`, { accept: "text/plain,*/*", timeoutMs: 8000 });
    if (r.res?.ok) robots = parseRobots(await readText(r.res, 500_000));
    else await r.res?.body?.cancel().catch(() => {});
  } catch {
    /* no robots.txt = everything allowed */
  }
  robotsCache.set(origin, { at: Date.now(), robots });
  return robots;
}

/* ---------- page checks ---------- */

const NOT_A_BOT = new Set(["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"]);

/** True when robots directives (meta content or X-Robots-Tag) apply noindex to Googlebot. */
export function noindexFor(value: string) {
  let bot = "";
  for (const part of value.split(",")) {
    let p = part.trim().toLowerCase();
    const m = p.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/);
    if (m && !NOT_A_BOT.has(m[1])) {
      bot = m[1];
      p = m[2].trim();
    }
    if ((!bot || bot === "googlebot") && /^(noindex|none)$/.test(p)) return true;
  }
  return false;
}

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? m[1] ?? m[2] ?? m[3] ?? "" : "";
};

export type PageCheck = {
  url: string;
  status: number;
  chain: Hop[];
  finalUrl: string;
  redirects: number;
  loop: boolean;
  ok: boolean;
  inconclusive: boolean;
  noindex: boolean;
  canonical: string;
  canonicalElsewhere: boolean;
  robotsBlocked: boolean;
  error: string;
  checkedAt: string;
};

export async function checkPage(url: string, opts: { allowHost?: (h: string) => boolean; robots?: boolean } = {}): Promise<PageCheck> {
  const out: PageCheck = {
    url, status: 0, chain: [], finalUrl: url, redirects: 0, loop: false, ok: false, inconclusive: false,
    noindex: false, canonical: "", canonicalElsewhere: false, robotsBlocked: false, error: "", checkedAt: new Date().toISOString(),
  };
  const setCanonical = (href: string) => {
    out.canonical = new URL(href, out.finalUrl).toString();
    out.canonicalElsewhere = normalizeUrl(out.canonical) !== normalizeUrl(out.finalUrl);
  };
  try {
    const r = await safeFetch(url, { allowHost: opts.allowHost });
    out.chain = r.chain;
    out.finalUrl = r.finalUrl;
    out.redirects = Math.max(0, r.chain.length - 1);
    out.loop = r.loop;
    if (opts.robots) {
      const u = new URL(url);
      const rb = await getRobots(u.origin);
      if (rb) out.robotsBlocked = !robotsAllows(rb, u.pathname + u.search);
    }
    if (!r.res) {
      out.status = r.chain[r.chain.length - 1]?.status || 0;
      out.error = r.loop ? "Redirect loop" : "More than 5 redirects";
      return out;
    }
    const res = r.res;
    out.status = res.status;
    out.ok = res.status === 200;
    // 403/429/503 to an automated checker is often bot protection, not what Googlebot sees.
    out.inconclusive = res.status === 403 || res.status === 429 || res.status === 503;
    if (noindexFor(res.headers.get("x-robots-tag") || "")) out.noindex = true;
    const headerCanonical = (res.headers.get("link") || "").match(/<([^>]+)>\s*;[^,]*rel\s*=\s*"?canonical"?/i)?.[1] || "";
    if (out.ok && (res.headers.get("content-type") || "").includes("html")) {
      const html = await readText(res);
      for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
        const name = attr(tag, "name").toLowerCase();
        if ((name === "robots" || name === "googlebot") && noindexFor(attr(tag, "content"))) out.noindex = true;
      }
      const linkTag = (html.match(/<link\b[^>]*>/gi) || []).find((t) => /(^|\s)canonical(\s|$)/i.test(attr(t, "rel")));
      const href = (linkTag && attr(linkTag, "href")) || headerCanonical;
      if (href) setCanonical(href);
    } else {
      await res.body?.cancel().catch(() => {});
      if (headerCanonical) setCanonical(headerCanonical);
    }
  } catch (e) {
    out.error = e instanceof Error ? (e.name === "TimeoutError" ? "Timed out after 10 s" : e.message) : "Request failed";
    out.inconclusive = !(e instanceof BlockedUrlError);
  }
  return out;
}
