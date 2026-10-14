// lib/google-token.ts
// Used by the GA4 bots/CTA/channels routes. Now shares lib/token.ts, so the allowlist is re-checked on every call.
import type { NextRequest } from "next/server";
import { getGoogleAccessToken, HttpError } from "./token";

export class AuthError extends HttpError {
  constructor(message: string) {
    super(401, message);
  }
}

const isAuthFailure = (e: unknown) => /\b401\b|UNAUTHENTICATED|invalid authentication/i.test(String((e as any)?.message ?? ""));

export async function withGoogleToken<T>(req: NextRequest, run: (token: string) => Promise<T>): Promise<T> {
  const get = async (forceRefresh = false) => {
    try {
      return await getGoogleAccessToken(req, { forceRefresh });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new AuthError(e.message);
      throw e;
    }
  };
  const token = await get();
  try {
    return await run(token);
  } catch (e) {
    if (!isAuthFailure(e)) throw e;
    return run(await get(true));
  }
}
