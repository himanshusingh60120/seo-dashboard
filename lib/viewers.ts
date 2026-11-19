// lib/viewers.ts
// View-only accounts (VIEWER_EMAILS, comma-separated): they see everything their Google account can open,
// but can't run URL Inspection or change settings. Server-only.
import { HttpError } from "./token";

export function viewerEmails(): string[] {
  return (process.env.VIEWER_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const isViewer = (email?: string | null) => !!email && viewerEmails().includes(email.trim().toLowerCase());

export function assertNotViewer(email: string) {
  if (isViewer(email)) {
    throw new HttpError(403, "This is a view-only account: it can see the dashboard but can't run URL Inspection or change settings.");
  }
}
