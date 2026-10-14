// lib/auth.ts
import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

export const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
].join(" ");

const list = (v?: string) => (v || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Deny by default: an empty ALLOWED_EMAILS lets nobody in. */
export function isAllowedEmail(email?: string | null) {
  return !!email && list(process.env.ALLOWED_EMAILS).includes(email.toLowerCase());
}

/** The AI audit is limited to these accounts (default hsingh@kingsresearch.com). */
export function isAuditEmail(email?: string | null) {
  const audit = list(process.env.AUDIT_EMAILS || "hsingh@kingsresearch.com");
  return isAllowedEmail(email) && audit.includes(String(email).toLowerCase());
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
    async signIn({ user }) {
      return isAllowedEmail(user.email);
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
