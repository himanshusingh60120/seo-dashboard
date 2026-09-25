import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { isAllowedEmail } from "./auth";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function refresh(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(401, "Your Google session expired. Sign out and sign in again.");
  return data.access_token as string;
}

/** Returns a valid Google access token for the signed-in user, refreshing it when needed. */
export async function getGoogleAccessToken(req: NextRequest): Promise<string> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token || !isAllowedEmail(token.email)) throw new HttpError(401, "Not signed in.");
  const expiresAt = (token.expiresAt as number) || 0;
  if (token.accessToken && Date.now() < expiresAt - 60_000) return token.accessToken as string;
  if (!token.refreshToken) throw new HttpError(401, "No refresh token. Sign out and sign in again.");
  return refresh(token.refreshToken as string);
}
