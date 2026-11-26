// lib/sharedBudget.ts
// A per-minute allowance shared by every copy of the app that Vercel is running at the same moment.
//
// lib/sheets.ts paces its requests, but each server only counts its own. Vercel runs several at once (the scheduled
// index checks, people's screens, the saved-history updates), and Google counts all their requests together against one
// limit per account. This keeps one shared count in Upstash Redis (the same store as Manage access), so together they
// stay under it.
//
// Kept cheap on Redis commands (Upstash's free plan allows 500,000 a month, and Manage access uses the same database):
//   - a server that has sent fewer than QUIET requests for an account in the last minute (someone opening a screen)
//     doesn't ask Redis at all; HEADROOM places a minute are left free for those requests;
//   - a busy server (the scheduled jobs) takes LEASE places with one Redis request and uses them up locally;
//   - after Redis says the minute is full, the server waits BLOCK_MS before asking again.
// The count is a sliding window: places taken in the current minute, plus the share of the previous minute that still
// falls inside the last 60 seconds. If Redis isn't set up, or doesn't answer within 1.5 seconds, requests go ahead (the
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
/** Requests a server may send per minute per account before it starts counting them in Redis. */
const QUIET = 5;
/** Places kept free each minute for quiet servers, which aren't counted in Redis. */
const HEADROOM = 5;
/** Places a busy server takes from Redis at a time. */
const LEASE = 5;
/** After Redis says the minute is full, wait this long before asking again. */
const BLOCK_MS = 3_000;

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

/** This server's own view of one account: what it sent lately and the places it still holds this minute. */
type Local = { sent: number[]; slot: number; left: number; blockedUntil: number; leasing: Promise<void> | null };
const local = new Map<string, Local>();

function stateOf(key: string): Local {
  let st = local.get(key);
  if (!st) {
    st = { sent: [], slot: -1, left: 0, blockedUntil: 0, leasing: null };
    local.set(key, st);
  }
  const now = Date.now();
  st.sent = st.sent.filter((t) => now - t < WINDOW_MS);
  return st;
}

const use = (st: Local) => {
  st.sent.push(Date.now());
  return true;
};

/** Takes up to LEASE places from Redis for this minute. Sets st.left, or st.blockedUntil when the minute is full. */
async function lease(st: Local, key: string, slot: number, perMinute: number) {
  const now = Date.now();
  const cur = slotKey(key, slot);
  const limit = Math.max(1, perMinute - HEADROOM);
  const r = await redis([["INCRBY", cur, LEASE], ["EXPIRE", cur, KEY_TTL_S], ["GET", slotKey(key, slot - 1)]]);
  if (!r) return; // Redis unavailable: skipUntil is now set, so requests go ahead on per-server pacing
  const total = Number(r[0]);
  if (!Number.isFinite(total)) {
    st.slot = slot;
    st.left = LEASE;
    return;
  }
  const before = Number(r[2]) || 0;
  const elapsed = (now % WINDOW_MS) / WINDOW_MS;
  const usedElsewhere = total - LEASE + before * (1 - elapsed);
  const granted = Math.max(0, Math.min(LEASE, Math.floor(limit - usedElsewhere)));
  if (granted < LEASE) await redis([["DECRBY", cur, LEASE - granted]]); // give back what can't be used
  if (granted) {
    st.slot = slot;
    st.left = granted;
  } else {
    st.blockedUntil = Date.now() + BLOCK_MS;
  }
}

/**
 * Asks for one request's place in the shared allowance for `key` (for example "sheets:write:0").
 * Returns true to go ahead, false when the last 60 seconds' allowance is used up (the caller waits and asks again).
 * Always true when Redis is unavailable. With force, the request always goes ahead.
 */
export async function takeShared(key: string, perMinute: number, force = false): Promise<boolean> {
  for (;;) {
    const st = stateOf(key);
    const now = Date.now();
    const slot = slotOf(now);
    if (st.slot !== slot) {
      st.slot = slot;
      st.left = 0; // places are only good for the minute they were taken in
    }
    if (force || st.sent.length < QUIET || !sharedBudgetOn() || now < skipUntil) return use(st);
    if (st.left > 0) {
      st.left--;
      return use(st);
    }
    if (now < st.blockedUntil) return false;
    if (st.leasing) {
      await st.leasing; // another request on this server is already asking Redis
      continue;
    }
    st.leasing = lease(st, key, slot, perMinute).finally(() => {
      st.leasing = null;
    });
    await st.leasing;
  }
}

/** After Google says "too many requests": marks this minute as used up for every server. */
export async function fillShared(key: string, perMinute: number) {
  const st = stateOf(key);
  st.left = 0;
  st.blockedUntil = Date.now() + BLOCK_MS;
  await redis([["SET", slotKey(key, slotOf(Date.now())), perMinute + 1, "EX", KEY_TTL_S]]);
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
