// lib/access.ts
// Company domains whose Google accounts can sign in to the dashboard.
// Shared by the server (lib/auth.ts) and the login page, so it must stay free of secrets and server-only imports.
// To change the list without a code change, set ALLOWED_DOMAINS in the environment (it replaces this list).
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  "kingsresearch.com",
  "datademand.com",
  "ondot.com",
  "kingsglobal.com",
  "kgv.ae",
  "kingstechmedia.com",
];
