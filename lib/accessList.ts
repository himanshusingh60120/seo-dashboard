// lib/accessList.ts
// Who can sign in and what each person can do. Managed in the "Manage access" tab and stored in Upstash Redis under
// "access:config". The two access admins are fixed below: nothing saved in Redis or Vercel can make anyone else an admin.
// Accounts on a sign-in domain who aren't listed can sign in and look, but get no extra tools; tools come only from the
// ticks given to a listed person.
// Each person chooses their own weekly report properties in the Weekly report tab ("weekly:sites:<email>" in Redis).
// The first time the list is read, it's filled from the old settings (people added earlier in Manage access, and
// CAPTURE_EMAILS, VIEWER_EMAILS, WEEKLY_REPORT_EMAILS, AUDIT_EMAILS, WEEKLY_SITES or their defaults). After that those
// Vercel variables aren't used. If Redis can't be reached, the admins and the built-in domains still get in. Server-only.
import { DEFAULT_ALLOWED_DOMAINS } from "./access";
import { getJson, setJson, sharedStorageReady } from "./kvStore";

export const ADMIN_EMAILS: readonly string[] = ["hsingh@kingsresearch.com", "sb@kingsresearch.com"];

/** Domains that are always allowed, on top of DEFAULT_ALLOWED_DOMAINS or ALLOWED_DOMAINS. */
const EXTRA_ALLOWED_DOMAINS = ["underratedclub.com"];

export type Perm = "viewOnly" | "captures" | "indexChecks" | "audit" | "weekly";
export const PERMS: readonly Perm[] = ["viewOnly", "captures", "indexChecks", "audit", "weekly"];
export type Perms = Record<Perm, boolean>;

const NONE: Perms = { viewOnly: false, captures: false, indexChecks: false, audit: false, weekly: false };
const ALL: Perms = { viewOnly: false, captures: true, indexChecks: true, audit: true, weekly: true };

export type AccessUser = {
  email: string;
  perms: Perms;
  /** Weekly report properties an admin picked earlier; used only until the person chooses their own. */
  weeklySites: string[];
  addedBy: string;
  addedAt: string;
  updatedBy: string;
  updatedAt: string;
};
export type AddedDomain = { domain: string; addedBy: string; addedAt: string };
export type AccessConfig = {
  v: 1;
  users: AccessUser[];
  domains: AddedDomain[];
  /** No longer used: unlisted accounts get no extra tools. Kept so older saved lists still read. */
  domainDefaults: Perms;
  /** Weekly report properties picked earlier for the admins; used only until they choose their own. */
  adminSites: Record<string, string[]>;
  updatedAt: string;
  updatedBy: string;
};

const KEY = "access:config";
const OLD_KEY = "access:granted";
const WEEKLY_KEY = (email: string) => `weekly:sites:${email}`;
const CACHE_MS = 30_000; // a change reaches every server within 30 seconds
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const norm = (s?: string | null) => String(s ?? "").trim().toLowerCase();
const split = (v?: string) => (v || "").split(/[,\s]+/).map(norm).filter(Boolean);
export const domainOf = (email: string) => {
  const e = norm(email);
  const at = e.lastIndexOf("@");
  return at > 0 ? e.slice(at + 1) : "";
};
export const isAccessAdmin = (email?: string | null) => !!email && ADMIN_EMAILS.includes(norm(email));

/** Domains set in code (lib/access.ts, or ALLOWED_DOMAINS in Vercel, which replaces it) plus underratedclub.com. */
export function builtInDomains(): string[] {
  const env = split(process.env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ""));
  return Array.from(new Set([...(env.length ? env : DEFAULT_ALLOWED_DOMAINS), ...EXTRA_ALLOWED_DOMAINS]));
}

/** Read-only always switches off the tools that change things. */
export function cleanPerms(p?: Partial<Perms> | null): Perms {
  const o = { ...NONE };
  for (const k of PERMS) o[k] = p?.[k] === true;
  if (o.viewOnly) o.captures = o.indexChecks = false;
  return o;
}

export function cleanSites(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ok = v.map((x) => String(x).trim()).filter((x) => x.length < 300 && /^(sc-domain:|https?:\/\/)\S+$/i.test(x));
  return Array.from(new Set(ok)).slice(0, 50);
}

function tidy(raw: Partial<AccessConfig> | null): AccessConfig {
  const users: AccessUser[] = [];
  for (const u of Array.isArray(raw?.users) ? raw!.users : []) {
    const email = norm(u?.email);
    if (!EMAIL_RE.test(email) || isAccessAdmin(email) || users.some((x) => x.email === email)) continue;
    users.push({
      email,
      perms: cleanPerms(u.perms),
      weeklySites: cleanSites(u.weeklySites),
      addedBy: String(u.addedBy || ""),
      addedAt: String(u.addedAt || ""),
      updatedBy: String(u.updatedBy || ""),
      updatedAt: String(u.updatedAt || ""),
    });
  }
  const domains: AddedDomain[] = [];
  for (const d of Array.isArray(raw?.domains) ? raw!.domains : []) {
    const domain = norm(d?.domain);
    if (domain && !domains.some((x) => x.domain === domain)) domains.push({ domain, addedBy: String(d.addedBy || ""), addedAt: String(d.addedAt || "") });
  }
  const adminSites: Record<string, string[]> = {};
  for (const e of ADMIN_EMAILS) {
    const s = cleanSites(raw?.adminSites?.[e]);
    if (s.length) adminSites[e] = s;
  }
  return {
    v: 1,
    users,
    domains,
    domainDefaults: { ...NONE },
    adminSites,
    updatedAt: String(raw?.updatedAt || ""),
    updatedBy: String(raw?.updatedBy || ""),
  };
}

/** The list built from the old settings, used once to fill Manage access. */
async function fromOldSettings(): Promise<AccessConfig> {
  const at = new Date().toISOString();
  const by = "Moved from the old settings";
  const users = new Map<string, AccessUser>();
  const add = (email: string, p: Partial<Perms>) => {
    const e = norm(email);
    if (!EMAIL_RE.test(e) || isAccessAdmin(e)) return;
    const u = users.get(e) || { email: e, perms: { ...NONE }, weeklySites: [], addedBy: by, addedAt: at, updatedBy: by, updatedAt: at };
    for (const k of PERMS) if (p[k]) u.perms[k] = true;
    users.set(e, u);
  };
  const or = (env: string | undefined, fallback: string[]) => {
    const l = split(env);
    return l.length ? l : fallback;
  };

  const old = sharedStorageReady() ? await getJson<{ email?: string }[]>(OLD_KEY).catch(() => null) : null;
  for (const g of old || []) add(String(g?.email || ""), {});
  for (const e of or(process.env.CAPTURE_EMAILS, ["asavalekar@kingstechmedia.com", "pkadu@ondot.com"])) add(e, { captures: true });
  add("sb@datademand.com", { captures: true });
  for (const e of or(process.env.VIEWER_EMAILS, ["intentimizeweb@gmail.com"])) add(e, { viewOnly: true });
  for (const e of or(process.env.WEEKLY_REPORT_EMAILS, [])) add(e, { weekly: true });
  for (const e of or(process.env.AUDIT_EMAILS, [])) add(e, { audit: true });

  const domains = builtInDomains();
  const sites = cleanSites((process.env.WEEKLY_SITES || "").split(/[,\s]+/));
  for (const u of users.values()) {
    if (!u.perms.viewOnly && domains.includes(domainOf(u.email))) u.perms.indexChecks = true; // they could before
    if (u.perms.weekly) u.weeklySites = sites;
    u.perms = cleanPerms(u.perms);
  }
  return { v: 1, users: [...users.values()], domains: [], domainDefaults: { ...NONE }, adminSites: {}, updatedAt: at, updatedBy: by };
}

let cache: { at: number; c: AccessConfig } | null = null;

/**
 * The saved list (filled from the old settings the first time). With fresh, always reads Redis and throws on errors
 * (for the Manage access screen); otherwise never throws, falling back to the last list or the built-in domains only.
 */
export async function loadAccess(fresh = false): Promise<AccessConfig> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.c;
  try {
    let c: AccessConfig;
    if (!sharedStorageReady()) c = await fromOldSettings();
    else {
      const saved = await getJson<Partial<AccessConfig>>(KEY);
      if (saved) c = tidy(saved);
      else {
        c = await fromOldSettings();
        await setJson(KEY, c);
      }
    }
    cache = { at: Date.now(), c };
    return c;
  } catch (e) {
    if (fresh) throw e;
    return cache?.c ?? tidy(null);
  }
}

export async function saveAccess(c: AccessConfig, by: string): Promise<AccessConfig> {
  const next = tidy({ ...c, updatedAt: new Date().toISOString(), updatedBy: norm(by) });
  await setJson(KEY, next);
  cache = { at: Date.now(), c: next };
  return next;
}

/** Admins, built-in or added domains, ALLOWED_EMAILS, or a person added in Manage access. Never throws. */
export async function canSignIn(email?: string | null): Promise<boolean> {
  const e = norm(email);
  if (!EMAIL_RE.test(e)) return false;
  const d = domainOf(e);
  if (isAccessAdmin(e) || builtInDomains().includes(d) || split(process.env.ALLOWED_EMAILS).includes(e)) return true;
  const c = await loadAccess();
  return c.users.some((u) => u.email === e) || c.domains.some((x) => x.domain === d);
}

/** What this person can do: admins everything; listed people exactly their ticks; everyone else no extra tools. */
export async function permsFor(email?: string | null): Promise<Perms> {
  const e = norm(email);
  if (!e) return { ...NONE };
  if (isAccessAdmin(e)) return { ...ALL };
  const c = await loadAccess();
  const u = c.users.find((x) => x.email === e);
  return u ? cleanPerms(u.perms) : { ...NONE };
}

export async function hasPerm(email: string | null | undefined, perm: Perm): Promise<boolean> {
  return (await permsFor(email))[perm];
}

/**
 * The properties in this person's weekly report ([] = the default list): what they chose in the Weekly report tab, or,
 * until they choose, what an admin picked for them earlier.
 */
export async function weeklySitesFor(email?: string | null): Promise<string[]> {
  const e = norm(email);
  if (!e) return [];
  if (sharedStorageReady()) {
    const own = await getJson<string[]>(WEEKLY_KEY(e)).catch(() => null);
    if (Array.isArray(own)) return cleanSites(own);
  }
  const c = await loadAccess();
  if (isAccessAdmin(e)) return c.adminSites[e] || [];
  return c.users.find((u) => u.email === e)?.weeklySites || [];
}

/** Saves this person's own weekly report properties ([] = the default list). */
export async function saveWeeklySites(email: string, sites: string[]): Promise<string[]> {
  const clean = cleanSites(sites);
  await setJson(WEEKLY_KEY(norm(email)), clean);
  return clean;
}
