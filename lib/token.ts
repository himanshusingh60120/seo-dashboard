// lib/token.ts
import { createHash } from "crypto";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { isAllowedEmail, isAuditEmail, refreshGoogleToken } from "./auth";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Access tokens refreshed on the server, cached per refresh token while the instance is warm. */
const refreshed = new Map<string, { token: string; exp: number }>();
const keyOf = (s: string) => createHash("sha256").update(s).digest("hex");

async function readSession(req: NextRequest): Promise<Record<string, any>> {
  const jwt = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!jwt) throw new HttpError(401, "Not signed in.");
  if (!isAllowedEmail(jwt.email)) throw new HttpError(403, "This Google account isn't allowed to use this dashboard.");
  return jwt as Record<string, any>;
}

export async function getGoogleAccessToken(req: NextRequest, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const s = await readSession(req);
  if (!opts.forceRefresh && s.accessToken && Date.now() < (Number(s.expiresAt) || 0) - 60_000) return String(s.accessToken);
  if (!s.refreshToken) throw new HttpError(401, "Google sign-in expired. Sign out and sign in again.");
  const k = keyOf(String(s.refreshToken));
  const hit = refreshed.get(k);
  if (!opts.forceRefresh && hit && Date.now() < hit.exp - 60_000) return hit.token;
  try {
    const r = await refreshGoogleToken(String(s.refreshToken));
    if (refreshed.size > 500) refreshed.clear();
    refreshed.set(k, { token: r.accessToken, exp: r.expiresAt });
    return r.accessToken;
  } catch {
    throw new HttpError(401, "Google sign-in expired. Sign out and sign in again.");
  }
}

export async function requireUser(req: NextRequest): Promise<string> {
  return String((await readSession(req)).email);
}

export async function requireAuditUser(req: NextRequest): Promise<string> {
  const email = await requireUser(req);
  if (!isAuditEmail(email)) throw new HttpError(403, "The GSC audit is only available to the audit account.");
  return email;
}
