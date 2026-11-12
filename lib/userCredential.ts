// lib/userCredential.ts
// Lets the daily index checks run with a person's own Google sign-in when the service account hasn't been added to a
// property (only property owners can add it). The person's Google refresh token is encrypted (AES-256-GCM, key from
// TOKEN_SECRET or NEXTAUTH_SECRET) and kept in Upstash Redis — never in the Google Sheet. Server-only.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { HttpError } from "./token";
import { isAllowedEmail, refreshGoogleToken } from "./auth";
import { delKey, getJson, setJson, sharedStorageReady } from "./kvStore";

type Sealed = { iv: string; tag: string; data: string; savedAt: string };

const secret = () => process.env.TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
const keyBytes = () => createHash("sha256").update(`gsc-cred:v1:${secret()}`).digest();
const kvKey = (email: string) => `gsc-cred:${email.toLowerCase()}`;
const cache = new Map<string, { token: string; exp: number }>();

function seal(text: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), savedAt: new Date().toISOString() };
}

function unseal(s: Sealed): string {
  const d = createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
}

export const userCredentialsReady = () => sharedStorageReady() && !!secret();

/** Saves the signed-in person's Google sign-in so background jobs can use it. Returns their email. */
export async function saveUserCredential(req: NextRequest): Promise<string> {
  if (!userCredentialsReady()) {
    throw new HttpError(503, "Saving a Google sign-in for daily checks needs Upstash Redis (KV_REST_API_URL and KV_REST_API_TOKEN) in Vercel.");
  }
  const jwt = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const email = String(jwt?.email || "");
  if (!jwt || !email || !isAllowedEmail(email)) throw new HttpError(401, "Not signed in.");
  const refresh = String((jwt as Record<string, unknown>).refreshToken || "");
  if (!refresh) {
    throw new HttpError(400, "Your Google sign-in can't be used for daily checks yet. Sign out of the dashboard, sign in again, and click once more.");
  }
  try {
    await refreshGoogleToken(refresh);
  } catch {
    throw new HttpError(400, "Google didn't accept your sign-in for background use. Sign out of the dashboard, sign in again, and click once more.");
  }
  await setJson(kvKey(email), seal(refresh));
  cache.delete(email.toLowerCase());
  return email;
}

/** An access token for jobs that run as this person. Throws a message that says how to fix it. */
export async function userAccessToken(email: string): Promise<string> {
  const k = email.toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() < hit.exp - 120_000) return hit.token;
  const fix = `${email}, or anyone else who can open this property in Search Console, should open the Index checks tab and click “Use my Google sign-in”.`;
  const stored = sharedStorageReady() ? await getJson<Sealed>(kvKey(email)).catch(() => null) : null;
  if (!stored) throw new Error(`No saved Google sign-in for ${email}. ${fix}`);
  let refresh = "";
  try {
    refresh = unseal(stored);
  } catch {
    throw new Error(`The saved Google sign-in for ${email} can't be read (the server secret changed). ${fix}`);
  }
  try {
    const r = await refreshGoogleToken(refresh);
    cache.set(k, { token: r.accessToken, exp: r.expiresAt });
    return r.accessToken;
  } catch {
    throw new Error(`${email}'s Google sign-in has expired or was removed. ${fix}`);
  }
}

export async function forgetUserCredential(email: string) {
  cache.delete(email.toLowerCase());
  if (sharedStorageReady()) await delKey(kvKey(email)).catch(() => {});
}
