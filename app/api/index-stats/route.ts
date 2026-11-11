// app/api/index-stats/route.ts
// Exact Page indexing numbers (copied from Search Console by the bookmark), saved for everyone in shared storage.
// Only signed-in users who can open the property in Search Console can read or change them.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { sharedStorageReady, getJson, setJson, delKey } from "@/lib/kvStore";
import { emptyIdxStore, mergeIdx, sanitizeIdxParsed, type IdxStore } from "@/lib/indexStats";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const storeKey = (site: string) => `idx:${site}`;

async function checkAccess(req: NextRequest, site: string) {
  if (!site) throw new HttpError(400, "Missing site");
  const token = await getGoogleAccessToken(req);
  await assertSiteAccess(token, site);
  if (!sharedStorageReady()) {
    throw new HttpError(501, "Shared storage isn't set up, so page indexing data can only be saved in this browser. Add Upstash Redis in Vercel → Storage and redeploy.");
  }
}

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    return NextResponse.json({ store: (await getJson<IdxStore>(storeKey(site))) || emptyIdxStore() });
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
    const parsed = sanitizeIdxParsed(body.parsed);
    if (!parsed) throw new HttpError(400, "No page indexing numbers to save.");
    const store = mergeIdx((await getJson<IdxStore>(storeKey(site))) || emptyIdxStore(), parsed, email);
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
    return NextResponse.json({ store: emptyIdxStore() });
  } catch (e) {
    return fail(e);
  }
}
