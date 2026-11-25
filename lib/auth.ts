// lib/auth.ts
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { builtInDomains, canSignIn } from "./accessList";
import { logLogin } from "./loginLog";

export const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

const list = (v?: string) => (v || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Domains set in code (lib/access.ts plus underratedclub.com) or ALLOWED_DOMAINS. Domains added in Manage access are checked by hasAccess. */
export const allowedDomains = builtInDomains;

/** Built-in domains and ALLOWED_EMAILS only (exact domain match; subdomains don't count). */
export function isAllowedEmail(email?: string | null) {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return false;
  return builtInDomains().includes(e.slice(at + 1)) || list(process.env.ALLOWED_EMAILS).includes(e);
}

/** Admins, built-in or added domains, ALLOWED_EMAILS, or a person added in Manage access. Never throws. */
export async function hasAccess(email?: string | null) {
  return canSignIn(email);
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
