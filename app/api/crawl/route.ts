// app/api/crawl/route.ts
// Crawl stats saved for everyone (shared storage). Only signed-in users who can open the property in Search Console
// can read or change it.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { sharedStorageReady, getJson, setJson, delKey } from "@/lib/kvStore";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Kind = "total" | "refresh" | "discovery" | "other";
type Day = { requests: number; bytes?: number; ms?: number };
type Series = { key: string; kind: Kind; label: string; days: Record<string, Day>; urls: { url: string; when: string }[] };
type Entry = { file: string; at: string; series: string; label: string; from: string; to: string; days: number; by?: string };
type Store = { series: Record<string, Series>; imports: Entry[] };

const LABEL: Record<Kind, string> = { total: "All crawl requests", refresh: "Refresh", discovery: "Discovery", other: "Other breakdown" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** About three years of days per series. */
const MAX_DAYS = 1100;
const storeKey = (site: string) => `crawl:${site}`;
const empty = (): Store => ({ series: {}, imports: [] });

async function checkAccess(req: NextRequest, site: string) {
  if (!site) throw new HttpError(400, "Missing site");
  const token = await getGoogleAccessToken(req);
  await assertSiteAccess(token, site);
  if (!sharedStorageReady()) {
    throw new HttpError(501, "Shared storage isn't set up yet, so crawl data can only be saved in this browser. Add Upstash Redis in Vercel → Storage and redeploy.");
  }
}

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    return NextResponse.json({ store: (await getJson<Store>(storeKey(site))) || empty() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const site = typeof body.site === "string" ? body.site : "";
    await checkAccess(req, site);
    const email = await requireUser(req);
    const incoming: any[] = Array.isArray(body.series) ? body.series.slice(0, 10) : [];
    if (!incoming.length) throw new HttpError(400, "Nothing to save.");

    const store = (await getJson<Store>(storeKey(site))) || empty();
    let saved = 0;
    for (const s of incoming) {
      const kind: Kind = ["total", "refresh", "discovery", "other"].includes(s?.kind) ? s.kind : "other";
      const label = kind === "other" ? String(s?.label || "Other").slice(0, 60) : LABEL[kind];
      const key = kind === "other" ? `other:${label.toLowerCase()}` : kind;
      const days: Record<string, Day> = {};
      for (const [d, v] of Object.entries<any>(s?.days || {}).slice(0, 2000)) {
        if (!DATE.test(d)) continue;
        const r = Number(v?.requests);
        if (!Number.isFinite(r) || r < 0) continue;
        const b = Number(v?.bytes), m = Number(v?.ms);
        days[d] = { requests: r, ...(Number.isFinite(b) && b >= 0 ? { bytes: b } : {}), ...(Number.isFinite(m) && m >= 0 ? { ms: m } : {}) };
      }
      const dates = Object.keys(days).sort();
      if (!dates.length) continue;
      const urls = Array.isArray(s?.urls)
        ? s.urls
            .filter((u: any) => typeof u?.url === "string" && /^https?:\/\//i.test(u.url))
            .slice(0, 1000)
            .map((u: any) => ({ url: String(u.url).slice(0, 2000), when: String(u.when || "").slice(0, 40) }))
        : [];
      const prev = store.series[key];
      const merged = { ...(prev?.days || {}), ...days };
      const keep = Object.keys(merged).sort().slice(-MAX_DAYS);
      store.series[key] = {
        key, kind, label,
        days: Object.fromEntries(keep.map((d) => [d, merged[d]])),
        urls: urls.length ? urls : prev?.urls || [],
      };
      store.imports.push({
        file: String(s?.source || "Crawl stats").slice(0, 200), at: new Date().toISOString(),
        series: key, label, from: dates[0], to: dates[dates.length - 1], days: dates.length, by: email,
      });
      saved++;
    }
    if (!saved) throw new HttpError(400, "No valid daily data to save.");
    store.imports = store.imports.slice(-200);
    await setJson(storeKey(site), store);
    return NextResponse.json({ store });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    await delKey(storeKey(site));
    return NextResponse.json({ store: empty() });
  } catch (e) {
    return fail(e);
  }
}
