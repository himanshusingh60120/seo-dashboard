// lib/captureAccess.ts
// Who runs the weekly Search Console captures: only these accounts can download the Chrome extension, get a key and
// send captures. Everyone else only sees who updated the data and when.
// CAPTURE_EMAILS (comma-separated) replaces the default list.
import { HttpError } from "./token";

const DEFAULT_CAPTURE_EMAILS = ["hsingh@kingsresearch.com", "asavalekar@kingstechmedia.com", "pkadu@ondot.com"];

export function captureEmails(): string[] {
  const raw = process.env.CAPTURE_EMAILS;
  return (raw ? raw.split(",") : DEFAULT_CAPTURE_EMAILS).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const isCaptureEmail = (email?: string | null) => !!email && captureEmails().includes(email.trim().toLowerCase());

export function assertCaptureEmail(email: string) {
  if (!isCaptureEmail(email)) {
    throw new HttpError(403, "Only the team members who run the weekly Search Console captures can do this.");
  }
}
