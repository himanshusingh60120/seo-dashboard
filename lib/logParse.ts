// lib/logParse.ts
"use client";
// Reads server access logs in the browser (nothing is uploaded) and counts Googlebot's requests
// per URL. Formats: Apache/Nginx combined/common, and JSON lines (Vercel log drains, Cloudflare,
// Google Cloud, generic). .gz files are unzipped with the browser's DecompressionStream.
// Optionally checks each IP against Google's published crawler IP ranges.

export type UrlHit = { path: string; hits: number; first: string; last: string; statuses: string; s404: number; s3xx: number; s5xx: number; isNew: boolean };
type Count = Record<string, number>;
type Agg = { total: number; status: Count; day: Count; bot: Count };
export type LogReport = {
  files: string[];
  analyzedAt: string;
  lines: number;
  parsed: number;
  sample: string;
  basis: "verified" | "user-agent";
  verifyRequested: boolean;
  claimed: number;
  verified: number;
  from: string;
  to: string;
  days: number;
  byStatus: { label: string; value: number }[];
  byBot: { label: string; value: number }[];
  byDay: { label: string; value: number }[];
  urls: UrlHit[];
  once: number;
  multi: number;
  repeatRequests: number;
  newUrls: number | null;
};
type Hit = { ip: string; time: string; path: string; status: string; ua: string };

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const CLF = /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+)[^"]*" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?/;

function toPath(u: string): string {
  if (/^https?:\/\//i.test(u)) {
    try { const x = new URL(u); return x.pathname + x.search; } catch { return u; }
  }
  return u;
}

function parseClf(line: string): Hit | null {
  const m = CLF.exec(line);
  if (!m) return null;
  const d = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/.exec(m[2]);
  const time = d ? `${d[3]}-${MONTHS[d[2]] || "01"}-${d[1]}T${d[4]}:${d[5]}:${d[6]}` : "";
  return { ip: m[1], time, path: toPath(m[4]), status: m[5], ua: m[6] || "" };
}

function pick(o: Record<string, unknown>, paths: string[]): string {
  for (let i = 0; i < paths.length; i++) {
    let v: unknown = o;
    const parts = paths[i].split(".");
    for (let j = 0; j < parts.length && v != null; j++) v = (v as Record<string, unknown>)[parts[j]];
    if (v != null && v !== "") return Array.isArray(v) ? v.join(" ") : String(v);
  }
  return "";
}

function jsonTime(raw: string): string {
  if (!raw) return "";
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const ms = n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 19);
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? raw.slice(0, 19) : d.toISOString().slice(0, 19);
}

function parseJson(line: string): Hit | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return null; }
  const ua = pick(o, ["proxy.userAgent", "userAgent", "user_agent", "http_user_agent", "ClientRequestUserAgent", "httpRequest.userAgent", "request.headers.user-agent"]);
  const path = pick(o, ["proxy.path", "path", "ClientRequestURI", "request_uri", "uri", "url", "httpRequest.requestUrl"]);
  const status = pick(o, ["proxy.statusCode", "statusCode", "status", "EdgeResponseStatus", "OriginResponseStatus", "httpRequest.status"]);
  if (!ua || !path || !status) return null;
  const ip = pick(o, ["proxy.clientIp", "clientIp", "ClientIP", "remote_addr", "ip", "httpRequest.remoteIp"]);
  const time = jsonTime(pick(o, ["proxy.timestamp", "timestamp", "EdgeStartTimestamp", "time", "@timestamp"]));
  return { ip, time, path: toPath(path), status: String(status).slice(0, 3), ua };
}

function botOf(ua: string): string | null {
  const m = /(Googlebot-[A-Za-z]+|Googlebot|AdsBot-Google(?:-Mobile)?|Storebot-Google|Google-InspectionTool|GoogleOther(?:-[A-Za-z]+)?)/.exec(ua);
  if (!m) return null;
  if (m[1] === "Googlebot") return /Mobile|Android|iPhone/.test(ua) ? "Googlebot Smartphone" : "Googlebot Desktop";
  return m[1];
}

function ipBig(raw: string): { v6: boolean; n: bigint } | null {
  let ip = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v6: false, n: BigInt(p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3]) };
  }
  if (ip.indexOf(":") < 0) return null;
  const dbl = ip.indexOf("::");
  const head = dbl >= 0 ? ip.slice(0, dbl) : ip;
  const tail = dbl >= 0 ? ip.slice(dbl + 2) : "";
  const hg = head ? head.split(":") : [];
  const tg = tail ? tail.split(":") : [];
  if (dbl < 0 && hg.length !== 8) return null;
  const fill = 8 - hg.length - tg.length;
  if (fill < 0) return null;
  const groups = hg.concat(new Array<string>(dbl >= 0 ? fill : 0).fill("0"), tg);
  let n = BigInt(0);
  for (let i = 0; i < groups.length; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(groups[i], 16));
  }
  return { v6: true, n };
}

function ipMatcher(prefixes: string[]) {
  const nets: { v6: boolean; base: bigint; mask: bigint }[] = [];
  prefixes.forEach((cidr) => {
    const [addr, len] = cidr.split("/");
    const p = ipBig(addr);
    if (!p) return;
    const bits = p.v6 ? 128 : 32;
    const l = Math.min(bits, Number(len));
    const mask = l === 0 ? BigInt(0) : ((BigInt(1) << BigInt(l)) - BigInt(1)) << BigInt(bits - l);
    nets.push({ v6: p.v6, base: p.n & mask, mask });
  });
  const memo = new Map<string, boolean>();
  return (ip: string): boolean => {
    const hit = memo.get(ip);
    if (hit !== undefined) return hit;
    const p = ipBig(ip);
    const ok = !!p && nets.some((n) => n.v6 === p.v6 && (p.n & n.mask) === n.base);
    memo.set(ip, ok);
    return ok;
  };
}

const newAgg = (): Agg => ({ total: 0, status: {}, day: {}, bot: {} });
const inc = (c: Count, k: string) => { c[k] = (c[k] || 0) + 1; };
function addHit(a: Agg, h: Hit, bot: string) {
  a.total++;
  inc(a.status, h.status);
  inc(a.bot, bot);
  if (h.time) inc(a.day, h.time.slice(0, 10));
}

export async function analyzeLogs(
  files: File[],
  opts: { ranges: string[] | null; known: Set<string>; onProgress?: (p: { file: number; files: number; lines: number }) => void }
): Promise<LogReport> {
  const isGoogle = opts.ranges ? ipMatcher(opts.ranges) : null;
  const all = newAgg();
  const ver = newAgg();
  type Acc = { hits: number; vhits: number; first: string; last: string; vfirst: string; vlast: string; st: Count; vst: Count };
  const urls = new Map<string, Acc>();
  let lines = 0;
  let parsed = 0;
  let sample = "";

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let stream = f.stream() as ReadableStream<Uint8Array>;
    if (/\.gz$/i.test(f.name)) {
      const DS = (globalThis as unknown as { DecompressionStream?: new (format: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
      if (!DS) throw new Error(`${f.name}: this browser can't unzip .gz files. Unzip it first.`);
      stream = stream.pipeThrough(new DS("gzip"));
    }
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let chunks = 0;
    for (;;) {
      const r = await reader.read();
      buf += r.done ? dec.decode() : dec.decode(r.value as Uint8Array, { stream: true });
      const parts = buf.split("\n");
      buf = r.done ? "" : parts.pop() || "";
      for (let j = 0; j < parts.length; j++) {
        const line = parts[j].trim();
        if (!line) continue;
        lines++;
        const h = line[0] === "{" ? parseJson(line) : parseClf(line);
        if (!h) {
          if (!sample) sample = line.slice(0, 300);
          continue;
        }
        parsed++;
        const bot = botOf(h.ua);
        if (!bot) continue;
        const ok = isGoogle ? isGoogle(h.ip) : false;
        addHit(all, h, bot);
        if (ok) addHit(ver, h, bot);
        let a = urls.get(h.path);
        if (!a) {
          a = { hits: 0, vhits: 0, first: "", last: "", vfirst: "", vlast: "", st: {}, vst: {} };
          urls.set(h.path, a);
        }
        a.hits++;
        inc(a.st, h.status);
        if (h.time) {
          if (!a.first || h.time < a.first) a.first = h.time;
          if (h.time > a.last) a.last = h.time;
        }
        if (ok) {
          a.vhits++;
          inc(a.vst, h.status);
          if (h.time) {
            if (!a.vfirst || h.time < a.vfirst) a.vfirst = h.time;
            if (h.time > a.vlast) a.vlast = h.time;
          }
        }
      }
      if (r.done) break;
      if (++chunks % 25 === 0) {
        if (opts.onProgress) opts.onProgress({ file: i + 1, files: files.length, lines });
        await new Promise((res) => setTimeout(res, 0));
      }
    }
  }

  const useVer = !!isGoogle && ver.total > 0;
  const A = useVer ? ver : all;
  const rows: UrlHit[] = [];
  let once = 0;
  let multi = 0;
  let repeat = 0;
  let fresh = 0;
  urls.forEach((a, path) => {
    const hits = useVer ? a.vhits : a.hits;
    if (!hits) return;
    const st = useVer ? a.vst : a.st;
    const sum = (re: RegExp) => Object.keys(st).filter((k) => re.test(k)).reduce((s, k) => s + st[k], 0);
    const isNew = opts.known.size > 0 && !opts.known.has(path);
    if (hits === 1) once++;
    else { multi++; repeat += hits - 1; }
    if (isNew) fresh++;
    rows.push({
      path, hits,
      first: useVer ? a.vfirst : a.first,
      last: useVer ? a.vlast : a.last,
      statuses: Object.keys(st).sort().map((k) => `${k}×${st[k]}`).join(" "),
      s404: (st["404"] || 0) + (st["410"] || 0),
      s3xx: sum(/^3/),
      s5xx: sum(/^5/),
      isNew,
    });
  });
  rows.sort((x, y) => y.hits - x.hits);
  const days = Object.keys(A.day).sort();
  const list = (c: Count, byKey = false) =>
    Object.keys(c).map((k) => ({ label: k, value: c[k] })).sort((x, y) => (byKey ? x.label.localeCompare(y.label) : y.value - x.value));

  return {
    files: files.map((f) => f.name),
    analyzedAt: new Date().toISOString(),
    lines, parsed, sample,
    basis: useVer ? "verified" : "user-agent",
    verifyRequested: !!isGoogle,
    claimed: all.total,
    verified: ver.total,
    from: days[0] || "",
    to: days[days.length - 1] || "",
    days: days.length,
    byStatus: list(A.status),
    byBot: list(A.bot),
    byDay: list(A.day, true),
    urls: rows,
    once, multi,
    repeatRequests: repeat,
    newUrls: opts.known.size ? fresh : null,
  };
}
