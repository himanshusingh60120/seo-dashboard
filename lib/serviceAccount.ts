// lib/serviceAccount.ts
// Signs in as the service account (a "robot" Google account) for jobs that run while nobody is logged in:
// Search Console (URL Inspection, Search Analytics, sitemaps), the Google Sheets used as the database, and Google
// Drive (to create each property's Sheet in the shared drive).
// Server-only. Needs GOOGLE_SERVICE_ACCOUNT_JSON (the whole key file) and INDEX_SHEET_ID in the environment.
import { createSign } from "crypto";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

type Key = { client_email: string; private_key: string };
let cached: { token: string; exp: number } | null = null;

function key(): Key {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't set.");
  let k: Partial<Key>;
  try {
    k = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON. Paste the whole key file.");
  }
  if (!k.client_email || !k.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
  return { client_email: k.client_email, private_key: k.private_key.replace(/\\n/g, "\n") };
}

export const serviceAccountReady = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !!process.env.INDEX_SHEET_ID;

export function serviceAccountEmail() {
  try {
    return key().client_email;
  } catch {
    return "";
  }
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** An access token for the service account, reused until shortly before it expires. */
export async function serviceAccountToken(): Promise<string> {
  if (cached && Date.now() < cached.exp - 120_000) return cached.token;
  const k = key();
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    b64(JSON.stringify({ iss: k.client_email, scope: SCOPES.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(unsigned).sign(k.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Service account sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}
