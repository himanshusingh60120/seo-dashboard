// lib/sharedBudget.ts
// A per-minute allowance shared by every copy of the app that Vercel is running at the same moment.
//
// lib/sheets.ts paces its requests, but each server only counts its own. Vercel runs several at once (the scheduled
// index checks, people's screens, the saved-history updates), and Google counts all their requests together against one
// limit per account. This keeps one shared count in Upstash Redis (the same store as Manage access), so together they
// stay under it.
//
// The count is a sliding window: requests in the current minute, plus the share of the previous minute that still falls
// inside the last 60 seconds. If Redis isn't set up, or doesn't answer within 1.5 seconds, requests go ahead (the
// per-server pacing and the retries in lib/sheets.ts still apply) and Redis is skipped for a minute, so a Redis problem
// can never stop the dashboard. Server-only.

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const WINDOW_MS = 60_000;
const REDIS_TIMEOUT_MS = 1_500;
/** After Redis fails, it's skipped for this long so requests don't each wait for it. */
const SKIP_AFTER_FAILURE_MS = 60_000;
/** Keys outlive their minute long enough to be read as "the previous minute". */
const KEY_TTL_S = 150;

let skipUntil = 0;

export const sharedBudgetOn = () => !!REDIS_URL && !!REDIS_TOKEN;

type Arg = string | number;

/** Runs Redis commands in one request. null when Redis isn't set up or didn't answer. */
async function redis(commands: Arg[][]): Promise<unknown[] | null> {
  if (!sharedBudgetOn() || Date.now() < skipUntil) return null;
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      cache: "no-store",
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Redis answered ${res.status}`);
    const out: unknown = await res.json();
    if (!Array.isArray(out)) throw new Error("Redis answered in an unexpected format");
    return out.map((x: any) => (x && x.error ? null : x?.result ?? null));
  } catch (e) {
    skipUntil = Date.now() + SKIP_AFTER_FAILURE_MS;
    console.warn(`[budget] Redis didn't answer, so for the next minute only per-server pacing applies: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const slotOf = (t: number) => Math.floor(t / WINDOW_MS);
const slotKey = (key: string, slot: number) => `dash:budget:${key}:${slot}`;

/**
 * Takes one request from the shared allowance for `key` (for example "sheets:write:0").
 * Returns true to go ahead, false when the last 60 seconds' allowance is used up (the caller waits and asks again).
 * Always true when Redis is unavailable. With force, the request is counted and always allowed.
 */
export async function takeShared(key: string, perMinute: number, force = false): Promise<boolean> {
  const now = Date.now();
  const slot = slotOf(now);
  const cur = slotKey(key, slot);
  const r = await redis([["INCR", cur], ["EXPIRE", cur, KEY_TTL_S], ["GET", slotKey(key, slot - 1)]]);
  if (!r || force) return true;
  const mine = Number(r[0]);
  if (!Number.isFinite(mine)) return true;
  const before = Number(r[2]) || 0;
  const elapsed = (now % WINDOW_MS) / WINDOW_MS;
  if (mine + before * (1 - elapsed) <= perMinute) return true;
  await redis([["DECR", cur]]); // not sent after all: give the place back
  return false;
}

/** After Google says "too many requests": marks this minute as used up for every server. */
export async function fillShared(key: string, perMinute: number) {
  const cur = slotKey(key, slotOf(Date.now()));
  await redis([["SET", cur, perMinute + 1, "EX", KEY_TTL_S]]);
}

/** Counts an event per day (kept 8 days), e.g. noteShared("sheets-refused:write"). */
export async function noteShared(name: string) {
  const k = `dash:count:${name}:${new Date().toISOString().slice(0, 10)}`;
  await redis([["INCR", k], ["EXPIRE", k, 8 * 86_400]]);
}

/** How many times an event was counted on a day (UTC date, YYYY-MM-DD); 0 when unknown. */
export async function sharedCount(name: string, day = new Date().toISOString().slice(0, 10)): Promise<number> {
  const r = await redis([["GET", `dash:count:${name}:${day}`]]);
  return Number(r?.[0]) || 0;
}
