// lib/auth.ts
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { DEFAULT_ALLOWED_DOMAINS } from "./access";
import { isAccessAdmin, isGranted } from "./accessList";

export const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

const list = (v?: string) => (v || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Domains that are always allowed, on top of DEFAULT_ALLOWED_DOMAINS or ALLOWED_DOMAINS. */
const EXTRA_ALLOWED_DOMAINS = ["underratedclub.com"];

/**
 * Domains whose Google accounts may sign in. ALLOWED_DOMAINS (comma-separated) replaces the built-in list
 * when set; EXTRA_ALLOWED_DOMAINS are always added either way.
 */
export function allowedDomains(): string[] {
  const fromEnv = list(process.env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ""));
  const base = fromEnv.length ? fromEnv : [...DEFAULT_ALLOWED_DOMAINS];
  return Array.from(new Set([...base, ...EXTRA_ALLOWED_DOMAINS]));
}

/**
 * Deny by default. An account is allowed when its domain is one of the allowed domains (exact match:
 * subdomains such as mail.kingsresearch.com don't count) or the full address is listed in ALLOWED_EMAILS.
 */
export function isAllowedEmail(email?: string | null) {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return false;
  return allowedDomains().includes(e.slice(at + 1)) || list(process.env.ALLOWED_EMAILS).includes(e);
}

/** Domains + ALLOWED_EMAILS, the access admins, or an address an admin added in "Manage access". */
export async function hasAccess(email?: string | null) {
  if (!email) return false;
  return isAllowedEmail(email) || isAccessAdmin(email) || (await isGranted(email));
}

/** The AI audit is limited to these accounts (default hsingh@kingsresearch.com). */
export function isAuditEmail(email?: string | null) {
  const audit = list(process.env.AUDIT_EMAILS || "hsingh@kingsresearch.com");
  return isAllowedEmail(email) && audit.includes(String(email).toLowerCase());
}

/**
 * Appends one row per sign-in attempt (allowed or blocked) to the login-log Google Sheet,
 * via the Apps Script web app in LOGIN_LOG_URL. Never throws: a logging failure must never block sign-in.
 */
async function logLogin(entry: { email?: string | null; name?: string | null; result: string }) {
  const url = process.env.LOGIN_LOG_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: process.env.LOGIN_LOG_SECRET ?? "",
        time: new Date().toISOString(),
        email: entry.email ?? "",
        name: entry.name ?? "",
        result: entry.result,
      }),
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
  } catch {
    // Ignore: logging is best-effort.
  }
}

export async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `Token refresh failed (${res.status})`);
  return {
    accessToken: String(data.access_token),
    expiresAt: Date.now() + (Number(data.expires_in) || 3500) * 1000,
    refreshToken: data.refresh_token as string | undefined,
  };
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: { params: { scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent" } },
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      // Only accept addresses Google has verified.
      const verified = (profile as { email_verified?: boolean } | undefined)?.email_verified !== false;
      // Company domains, ALLOWED_EMAILS, access admins, or someone an admin added in "Manage access".
      const allowed = verified && (await hasAccess(user.email));
      await logLogin({
        email: user.email,
        name: user.name,
        result: !verified ? "Blocked – email not verified" : allowed ? "Allowed" : "Blocked – no access",
      });
      return allowed;
    },
    // Tokens live only in the encrypted session cookie. Refreshed here so the cookie stays current.
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token ?? token.refreshToken;
        token.expiresAt = (account.expires_at ?? Math.floor(Date.now() / 1000) + 3500) * 1000;
        return token;
      }
      if (token.accessToken && Date.now() < (Number(token.expiresAt) || 0) - 5 * 60_000) return token;
      if (!token.refreshToken) return token;
      try {
        const r = await refreshGoogleToken(String(token.refreshToken));
        token.accessToken = r.accessToken;
        token.expiresAt = r.expiresAt;
        if (r.refreshToken) token.refreshToken = r.refreshToken;
        delete token.refreshError;
      } catch (e) {
        token.refreshError = e instanceof Error ? e.message : "refresh failed";
      }
      return token;
    },
    async session({ session }) {
      return session;
    },
  },
};
