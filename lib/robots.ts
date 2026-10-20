// lib/robots.ts
// robots.txt as Google applies it to Googlebot: the most specific user-agent group applies
// ("googlebot" beats "*", groups for the same agent merge), the longest matching path wins,
// Allow wins a tie, "*" = any characters, trailing "$" = end of URL.
// 4xx (except 429) = no robots.txt (all allowed); 5xx / 429 / network error = unknown.

export type RobotsRule = { allow: boolean; path: string; re: RegExp };
export type RobotsVerdict = { allowed: boolean | null; rule: string; robotsUrl: string; robotsStatus: number };
type RobotsFile = { url: string; status: number; rules: RobotsRule[] | null; error?: string; at: number };

const UA = "Mozilla/5.0 (compatible; SearchDashboard/1.0)";
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, RobotsFile>();

function toRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, agent = "googlebot"): RobotsRule[] {
  type Group = { agents: string[]; rules: RobotsRule[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let readingAgents = false;
  const lines = text.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k].replace(/#.*$/, "").trim();
    const i = line.indexOf(":");
    if (i < 1) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === "user-agent") {
      if (!cur || !readingAgents) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      readingAgents = true;
    } else if (field === "allow" || field === "disallow") {
      readingAgents = false;
      if (cur && value) cur.rules.push({ allow: field === "allow", path: value, re: toRegex(value) });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a === agent));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.indexOf("*") >= 0);
  return chosen.reduce<RobotsRule[]>((all, g) => all.concat(g.rules), []);
}

export function matchRobots(rules: RobotsRule[], pathAndQuery: string): { allowed: boolean; rule: string } {
  if (pathAndQuery === "/robots.txt") return { allowed: true, rule: "" };
  let best: RobotsRule | null = null;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!r.re.test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  return best ? { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` } : { allowed: true, rule: "" };
}

async function getRobots(origin: string): Promise<RobotsFile> {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const url = `${origin}/robots.txt`;
  let file: RobotsFile;
  try {
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (res.ok) file = { url, status: res.status, rules: parseRobots(await res.text()), at: Date.now() };
    else if (res.status >= 400 && res.status < 500 && res.status !== 429) file = { url, status: res.status, rules: [], at: Date.now() };
    else file = { url, status: res.status, rules: null, error: `robots.txt returned HTTP ${res.status}`, at: Date.now() };
  } catch (e) {
    file = { url, status: 0, rules: null, error: `robots.txt unreachable: ${e instanceof Error ? e.message : "failed"}`, at: Date.now() };
  }
  cache.set(origin, file);
  return file;
}

export async function robotsVerdict(url: string): Promise<RobotsVerdict> {
  const u = new URL(url);
  const f = await getRobots(u.origin);
  if (!f.rules) return { allowed: null, rule: f.error || "unknown", robotsUrl: f.url, robotsStatus: f.status };
  const m = matchRobots(f.rules, u.pathname + u.search);
  return { allowed: m.allowed, rule: m.rule, robotsUrl: f.url, robotsStatus: f.status };
}
