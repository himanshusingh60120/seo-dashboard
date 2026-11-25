// lib/loginLog.ts
// Appends one row per sign-in attempt to a Google Sheet via an Apps Script web app.
// Never throws: a logging failure must never block sign-in.
export async function logLogin(entry: { email?: string | null; name?: string | null; result: string }) {
  const url = process.env.LOGIN_LOG_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: process.env.LOGIN_LOG_SECRET ?? "",
        time: new Date().toISOString(),
        email: entry.email ?? "",
        name: entry.name ?? "",
        result: entry.result,
      }),
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
  } catch {
    // Ignore: logging is best-effort.
  }
}
