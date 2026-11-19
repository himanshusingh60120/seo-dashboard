// lib/viewers.ts
// View-only accounts: they see everything their Google account can open in the dashboard, but can't run URL
// Inspection, start or pause index checks, or change saved-history settings. The server enforces this on every route
// that changes something or uses Google's quota; the dashboard also hides those buttons.
// VIEWER_EMAILS (comma-separated) replaces the default list. A viewer outside the company domains also needs to be in
// ALLOWED_EMAILS to sign in at all. Server-only.
import { HttpError } from "./token";

const DEFAULT_VIEWER_EMAILS = ["intentimizeweb@gmail.com"];

export function viewerEmails(): string[] {
  const raw = process.env.VIEWER_EMAILS;
  return (raw ? raw.split(",") : DEFAULT_VIEWER_EMAILS).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const isViewer = (email?: string | null) => !!email && viewerEmails().includes(email.trim().toLowerCase());

export function assertNotViewer(email: string) {
  if (isViewer(email)) {
    throw new HttpError(403, "This is a view-only account: it can see the dashboard but can't run URL Inspection or change settings.");
  }
}
