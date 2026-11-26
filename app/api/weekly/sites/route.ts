// app/api/weekly/sites/route.ts
// The Weekly report's "Choose properties", for anyone with the Weekly report permission.
// GET  → every Search Console property this person's own Google account can open, and the ones in their report now
//        ([] = the default list).
// POST { sites } → saves their choice; only properties their account can open are kept. [] = back to the default list.
import { NextRequest, NextResponse } from "next/server";
import { HttpError, getGoogleAccessToken } from "@/lib/token";
import { fail } from "@/lib/api";
import { listSites } from "@/lib/google";
import { requireWeeklyUser } from "@/lib/weekly";
import { saveWeeklySites } from "@/lib/accessList";
import { sharedStorageReady } from "@/lib/kvStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Most properties one report can cover (each one loads separately). */
const MAX = 50;

async function propertiesFor(req: NextRequest): Promise<string[]> {
  const token = await getGoogleAccessToken(req);
  const list = await listSites(token);
  return Array.from(new Set(list.map((x) => x.siteUrl))).sort();
}

export async function GET(req: NextRequest) {
  try {
    const { sites } = await requireWeeklyUser(req);
    const all = await propertiesFor(req);
    return NextResponse.json({ all, chosen: sites, max: MAX });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await requireWeeklyUser(req);
    if (!sharedStorageReady()) throw new HttpError(503, "Upstash Redis isn't connected, so your choice can't be saved.");
    const b = await req.json().catch(() => ({}));
    const want: string[] = Array.isArray(b?.sites) ? b.sites.map((x: unknown) => String(x)) : [];
    const canOpen = new Set(await propertiesFor(req));
    const keep = Array.from(new Set(want.filter((s) => canOpen.has(s))));
    if (keep.length > MAX) throw new HttpError(400, `Pick up to ${MAX} properties.`);
    const chosen = await saveWeeklySites(email, keep);
    return NextResponse.json({ chosen });
  } catch (e) {
    return fail(e);
  }
}
