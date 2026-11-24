// lib/accessList.ts
// Who can manage sign-in access, and the extra addresses they've added from the "Manage access" tab.
// Stored in Upstash Redis (lib/kvStore.ts). Nothing stored here can make someone an admin.
// ACCESS_ADMIN_EMAILS (comma-separated) replaces the default admin list. Server-only.
import { getJson, setJson, sharedStorageReady } from "./kvStore";

const DEFAULT_ADMIN_EMAILS = ["hsingh@kingsresearch.com", "himanshusingh60120@gmail.com"];
const KEY = "access:granted";
const CACHE_MS = 30_000; // a removed person loses access within 30 seconds

export type Grant = { email: string; addedBy: string; addedAt: string };

const norm = (s?: string | null) => String(s ?? "").trim().toLowerCase();

export function accessAdmins(): string[] {
  const raw = process.env.ACCESS_ADMIN_EMAILS;
  return (raw ? raw.split(",") : DEFAULT_ADMIN_EMAILS).map(norm).filter(Boolean);
}

export const isAccessAdmin = (email?: string | null) => !!email && accessAdmins().includes(norm(email));

let cache: { at: number; list: Grant[] } | null = null;

export async function listGranted(fresh = false): Promise<Grant[]> {
  if (!sharedStorageReady()) return [];
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  const list = (await getJson<Grant[]>(KEY)) ?? [];
  cache = { at: Date.now(), list };
  return list;
}

/** Never throws: if Redis is down, domain users still get in and granted users are refused. */
export async function isGranted(email?: string | null) {
  const e = norm(email);
  if (!e) return false;
  try {
    return (await listGranted()).some((g) => g.email === e);
  } catch {
    return false;
  }
}

export async function grantAccess(email: string, by: string) {
  const e = norm(email);
  const list = await listGranted(true);
  if (!list.some((g) => g.email === e)) list.push({ email: e, addedBy: norm(by), addedAt: new Date().toISOString() });
  await setJson(KEY, list);
  cache = { at: Date.now(), list };
  return list;
}

export async function revokeAccess(email: string) {
  const e = norm(email);
  const list = (await listGranted(true)).filter((g) => g.email !== e);
  await setJson(KEY, list);
  cache = { at: Date.now(), list };
  return list;
}
