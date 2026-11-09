// lib/kvStore.ts
// Shared storage on Upstash Redis (added from Vercel → Storage), used through its REST API, so no extra package is needed.
// Server-only. Reads the environment variables Vercel adds when the database is connected to the project.
const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const sharedStorageReady = () => !!(url() && token());

async function command(args: string[]): Promise<unknown> {
  const res = await fetch(url(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Shared storage error: ${data.error || res.status}`);
  return data.result;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const v = await command(["GET", key]);
  return typeof v === "string" ? (JSON.parse(v) as T) : null;
}

export async function setJson(key: string, value: unknown) {
  await command(["SET", key, JSON.stringify(value)]);
}

export async function delKey(key: string) {
  await command(["DEL", key]);
}
