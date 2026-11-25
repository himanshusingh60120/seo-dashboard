// lib/otp.ts
// Email codes that protect Manage access. An admin asks for a code; the Apps Script web app (LOGIN_LOG_URL, the same one
// that logs sign-ins) emails it to their own address. Entering it unlocks changes in that browser for 10 minutes with a
// signed, http-only cookie. Codes are kept hashed in Upstash Redis: 10 minutes, 5 tries, one new code a minute. Server-only.
import { createHash, createHmac, randomInt, timingSafeEqual } from "crypto";
import type { NextRequest, NextResponse } from "next/server";
import { HttpError } from "./token";
import { delKey, getJson, setJson, sharedStorageReady } from "./kvStore";

const CODE_MINUTES = 10;
const UNLOCK_MS = 10 * 60_000;
const RESEND_MS = 60_000;
const MAX_TRIES = 5;
const COOKIE = "kr_access_unlock";
const COOKIE_PATH = "/api/access";

type Stored = { hash: string; exp: number; tries: number; sentAt: number };

const secret = () => process.env.NEXTAUTH_SECRET || "";
const lower = (s: string) => s.trim().toLowerCase();
const kvKey = (email: string) => `access:otp:${lower(email)}`;
const hashOf = (email: string, code: string) => createHash("sha256").update(`otp:v1|${secret()}|${lower(email)}|${code}`).digest("hex");
const sign = (v: string) => createHmac("sha256", secret()).update(`access-unlock:v1|${v}`).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function mail(to: string, code: string) {
  const url = process.env.LOGIN_LOG_URL;
  if (!url) throw new HttpError(503, "Codes can't be emailed: LOGIN_LOG_URL isn't set in Vercel.");
  let text = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ secret: process.env.LOGIN_LOG_SECRET ?? "", action: "otp", to, code, minutes: CODE_MINUTES }),
    });
    text = (await res.text()).trim();
  } catch {
    throw new HttpError(502, "The email service didn't answer. Try again in a minute.");
  }
  if (text !== "sent") {
    throw new HttpError(
      502,
      `The code email wasn't sent${text ? ` (the email script said: ${text.slice(0, 120)})` : ""}. Check the Apps Script was updated and deployed as a new version.`
    );
  }
}

/** Emails a new code to this admin. */
export async function sendCode(email: string) {
  if (!sharedStorageReady()) throw new HttpError(503, "Upstash Redis isn't connected, so codes can't be checked.");
  if (!secret()) throw new HttpError(500, "NEXTAUTH_SECRET isn't set.");
  const prev = await getJson<Stored>(kvKey(email)).catch(() => null);
  if (prev && Date.now() - prev.sentAt < RESEND_MS) {
    const wait = Math.ceil((RESEND_MS - (Date.now() - prev.sentAt)) / 1000);
    throw new HttpError(429, `A code was sent less than a minute ago. Check your inbox (and spam), or ask again in ${wait} seconds.`);
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const sentAt = Date.now();
  const rec: Stored = { hash: hashOf(email, code), exp: sentAt + CODE_MINUTES * 60_000, tries: 0, sentAt };
  await setJson(kvKey(email), rec);
  try {
    await mail(email, code);
  } catch (e) {
    await delKey(kvKey(email)).catch(() => {});
    throw e;
  }
  return { sentAt, expiresAt: rec.exp };
}

/** Checks a code; returns when the unlock ends. */
export async function verifyCode(email: string, raw: string): Promise<number> {
  const code = raw.replace(/\D/g, "");
  if (code.length !== 6) throw new HttpError(400, "Enter the 6-digit code from the email.");
  const rec = await getJson<Stored>(kvKey(email));
  if (!rec || Date.now() > rec.exp) {
    if (rec) await delKey(kvKey(email)).catch(() => {});
    throw new HttpError(400, "This code has expired or was already used. Ask for a new one.");
  }
  if (rec.tries >= MAX_TRIES) throw new HttpError(429, "Too many wrong codes. Ask for a new one.");
  if (!same(hashOf(email, code), rec.hash)) {
    const left = MAX_TRIES - rec.tries - 1;
    await setJson(kvKey(email), { ...rec, tries: rec.tries + 1 });
    throw new HttpError(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new one.");
  }
  await delKey(kvKey(email));
  return Date.now() + UNLOCK_MS;
}

/** When this browser's unlock ends for this admin, or null when it's locked. */
export function unlockedUntil(req: NextRequest, email: string): number | null {
  if (!secret()) return null;
  const [who, until, sig] = (req.cookies.get(COOKIE)?.value || "").split(".");
  if (!who || !until || !sig || !same(sign(`${who}.${until}`), sig)) return null;
  if (Buffer.from(who, "base64url").toString("utf8") !== lower(email)) return null;
  const t = Number(until);
  return Number.isFinite(t) && t > Date.now() ? t : null;
}

export function requireUnlocked(req: NextRequest, email: string) {
  if (!unlockedUntil(req, email)) {
    throw new HttpError(401, "Confirm with the code from your email first (it unlocks changes for 10 minutes).");
  }
}

export function setUnlock(res: NextResponse, email: string, until: number) {
  const who = Buffer.from(lower(email)).toString("base64url");
  res.cookies.set(COOKIE, `${who}.${until}.${sign(`${who}.${until}`)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: COOKIE_PATH,
    expires: new Date(until),
  });
}

export function clearUnlock(res: NextResponse) {
  res.cookies.set(COOKIE, "", { httpOnly: true, path: COOKIE_PATH, maxAge: 0 });
}
