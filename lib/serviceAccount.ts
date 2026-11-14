// lib/serviceAccount.ts
// Signs in as the service account (a "robot" Google account) for jobs that run while nobody is logged in:
// Search Console (URL Inspection, Search Analytics, sitemaps), GA4 (read only), the Google Sheets used as the database,
// and Google Drive (to create each property's Sheet in the shared drive).
//
// Optional read-only helpers: Google allows each account 60 Sheets reads a minute. Put one or more extra service account
// key files in GOOGLE_SHEETS_READER_JSON (one key file, or a JSON array of key files) and lib/sheets.ts spreads its reads
// over them, so each adds another 60 a minute. They only need Viewer access to the "SEO Dashboard" shared drive.
//
// Server-only. Needs GOOGLE_SERVICE_ACCOUNT_JSON (the whole key file) and INDEX_SHEET_ID in the environment.
import { createSign } from "crypto";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/analytics.readonly",
];
const READER_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

type Key = { client_email: string; private_key: string };
const tokens = new Map<string, { token: string; exp: number }>();

function parseKey(v: unknown, name: string): Key {
  const k = (v && typeof v === "object" ? v : {}) as Partial<Key>;
  if (!k.client_email || !k.private_key) throw new Error(`${name} is missing client_email or private_key.`);
  return { client_email: k.client_email, private_key: k.private_key.replace(/\\n/g, "\n") };
}

function key(): Key {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't set.");
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON. Paste the whole key file.");
  }
  return parseKey(v, "GOOGLE_SERVICE_ACCOUNT_JSON");
}

let readers: Key[] | null = null;
/** Extra read-only accounts from GOOGLE_SHEETS_READER_JSON (none when it isn't set or can't be read). */
function readerKeys(): Key[] {
  if (readers) return readers;
  const raw = process.env.GOOGLE_SHEETS_READER_JSON;
  readers = [];
  if (!raw) return readers;
  try {
    const v = JSON.parse(raw);
    const list = Array.isArray(v) ? v : [v];
    readers = list.map((x, i) => parseKey(x, `GOOGLE_SHEETS_READER_JSON key ${i + 1}`));
  } catch (e) {
    console.warn(`[serviceAccount] GOOGLE_SHEETS_READER_JSON ignored: ${e instanceof Error ? e.message : "not valid JSON"}`);
    readers = [];
  }
  return readers;
}

export const serviceAccountReady = () => !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !!process.env.INDEX_SHEET_ID;

export function serviceAccountEmail() {
  try {
    return key().client_email;
  } catch {
    return "";
  }
}

/** How many accounts can read the Sheets: the main service account plus any read-only helpers. */
export const readerCount = () => 1 + readerKeys().length;

/** Email addresses of the read-only helpers (for status screens). */
export const readerEmails = () => readerKeys().map((k) => k.client_email);

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** An access token for one account and set of scopes, reused until shortly before it expires. */
async function tokenFor(k: Key, scopes: string[]): Promise<string> {
  const cacheKey = `${k.client_email} ${scopes.join(" ")}`;
  const hit = tokens.get(cacheKey);
  if (hit && Date.now() < hit.exp - 120_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.` +
    b64(JSON.stringify({ iss: k.client_email, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(unsigned).sign(k.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Service account sign-in failed (${k.client_email}): ${data.error_description || data.error || res.status}`);
  }
  tokens.set(cacheKey, { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

/** An access token for the main service account. */
export async function serviceAccountToken(): Promise<string> {
  return tokenFor(key(), SCOPES);
}

/** A token for reading Sheets: 0 is the main service account, 1 and up are the read-only helpers. */
export async function sheetsReaderToken(i: number): Promise<string> {
  const k = i > 0 ? readerKeys()[i - 1] : undefined;
  return k ? tokenFor(k, READER_SCOPES) : serviceAccountToken();
}
