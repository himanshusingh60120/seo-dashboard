// app/api/index-stats/route.ts
// Exact Page indexing numbers (from the "Copy page indexing" bookmark or the Chrome extension), saved for everyone in
// the Google Sheet. Data saved earlier in Upstash Redis is copied over once, the first time the Sheet has none.
// Only signed-in users who can open the property in Search Console can read or change it.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { sharedStorageReady, getJson, delKey } from "@/lib/kvStore";
import { clearIdx, loadIdx, restoreIdx, saveIdx } from "@/lib/reportStore";
import { emptyIdxStore, sanitizeIdxParsed, type IdxStore } from "@/lib/indexStats";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const oldKey = (site: string) => `idx:${site}`;

async function checkAccess(req: NextRequest, site: string) {
  if (!site) throw new HttpError(400, "Missing site");
  const token = await getGoogleAccessToken(req);
  await assertSiteAccess(token, site);
  if (!serviceAccountReady()) {
    throw new HttpError(501, "The Google Sheet isn't set up, so page indexing data can only be saved in this browser. Add GOOGLE_SERVICE_ACCOUNT_JSON and INDEX_SHEET_ID in Vercel and redeploy.");
  }
}

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    let store = await loadIdx(site);
    if (!Object.keys(store.views).length && sharedStorageReady()) {
      const old = await getJson<IdxStore>(oldKey(site)).catch(() => null);
      if (old && Object.keys(old.views || {}).length) {
        await restoreIdx(site, old);
        store = await loadIdx(site, true);
      }
    }
    return NextResponse.json({ store });
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
    return NextResponse.json({ store: await saveIdx(site, parsed, email, "Dashboard (bookmark or paste)") });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    await clearIdx(site, await requireUser(req));
    if (sharedStorageReady()) await delKey(oldKey(site)).catch(() => {}); // so it isn't copied back
    return NextResponse.json({ store: emptyIdxStore() });
  } catch (e) {
    return fail(e);
  }
}
