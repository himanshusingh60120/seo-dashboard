import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

export class AuthError extends Error {}

async function readTokens(req: NextRequest) {
  const jwt: any = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!jwt) throw new AuthError('Not signed in');
  return {
    accessToken: (jwt.accessToken ?? jwt.access_token ?? jwt.account?.access_token) as string | undefined,
    refreshToken: (jwt.refreshToken ?? jwt.refresh_token ?? jwt.account?.refresh_token) as string | undefined,
  };
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    cache: 'no-store',
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new AuthError(
      `Couldn't renew Google sign-in (${json.error_description || json.error || res.status}). Sign out and sign in again.`
    );
  }
  return json.access_token as string;
}

/**
 * Runs `run` with a Google access token. If Google rejects the token as expired (401),
 * it gets a fresh one using the refresh token and tries once more.
 */
export async function withGoogleToken<T>(req: NextRequest, run: (token: string) => Promise<T>): Promise<T> {
  const { accessToken, refreshToken } = await readTokens(req);

  if (accessToken) {
    try {
      return await run(accessToken);
    } catch (e: any) {
      const expired = /GA4 401/.test(String(e?.message ?? ''));
      if (!expired || !refreshToken) {
        if (expired) throw new AuthError('Google sign-in expired. Sign out and sign in again.');
        throw e;
      }
    }
  }

  if (!refreshToken) throw new AuthError('Google sign-in expired. Sign out and sign in again.');
  return run(await refreshAccessToken(refreshToken));
}
