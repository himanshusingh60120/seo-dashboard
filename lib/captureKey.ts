// lib/captureKey.ts
// A personal "extension key" so the Chrome extension can send captures without a dashboard login.
// The key is the person's email plus a signature made with CAPTURE_SECRET (or NEXTAUTH_SECRET); nothing is stored.
// Whether that person may still send captures is checked on every request (requireCapture in lib/permissions.ts), so
// removing their "Weekly captures" tick in Manage access stops their extension at once.
// To cancel every key at once, change CAPTURE_SECRET in Vercel. Server-only.
import { createHmac, timingSafeEqual } from "crypto";
import { HttpError } from "./token";

const secret = () => process.env.CAPTURE_SECRET || process.env.NEXTAUTH_SECRET || "";
const sig = (email: string) => createHmac("sha256", secret()).update(`capture-key:v1:${email.toLowerCase()}`).digest("base64url").slice(0, 32);

export function captureKeyFor(email: string) {
  if (!secret()) throw new HttpError(500, "NEXTAUTH_SECRET isn't set.");
  return `${Buffer.from(email.toLowerCase()).toString("base64url")}.${sig(email)}`;
}

/** Returns the email the key belongs to, or throws. */
export function verifyCaptureKey(key: string | null): string {
  if (!secret()) throw new HttpError(500, "NEXTAUTH_SECRET isn't set.");
  const [a, b] = (key || "").trim().split(".");
  if (!a || !b) throw new HttpError(401, "Missing extension key. Copy it from the dashboard into the extension's settings.");
  let email = "";
  try {
    email = Buffer.from(a, "base64url").toString("utf8");
  } catch {
    /* handled below */
  }
  const want = Buffer.from(sig(email));
  const got = Buffer.from(b);
  if (!email || want.length !== got.length || !timingSafeEqual(want, got)) {
    throw new HttpError(401, "This extension key isn't valid. Copy it again from the dashboard.");
  }
  return email;
}
