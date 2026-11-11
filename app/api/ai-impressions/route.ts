// app/api/ai-impressions/route.ts
// Generative AI report data (imported from Search Console exports), saved for everyone in shared storage.
// Only signed-in users who can open the property in Search Console can read or change it.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { sharedStorageReady, getJson, setJson, delKey } from "@/lib/kvStore";
import { emptyAiStore, mergeAi, sanitizeAiParsed, type AiStore } from "@/lib/aiStore";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const storeKey = (site: string) => `ai:${site}`;

async function checkAccess(req: NextRequest, site: string) {
  if (!site) throw new HttpError(400, "Missing site");
  const token = await getGoogleAccessToken(req);
  await assertSiteAccess(token, site);
  if (!sharedStorageReady()) {
    throw new HttpError(501, "Shared storage isn't set up, so AI data can only be saved in this browser. Add Upstash Redis in Vercel → Storage and redeploy.");
  }
}

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    return NextResponse.json({ store: (await getJson<AiStore>(storeKey(site))) || emptyAiStore() });
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
    const items = (Array.isArray(body.imports) ? body.imports.slice(0, 10) : []).map(sanitizeAiParsed).filter(Boolean);
    if (!items.length) throw new HttpError(400, "No daily AI impressions to save.");
    let store = (await getJson<AiStore>(storeKey(site))) || emptyAiStore();
    for (const p of items) store = mergeAi(store, p!, email);
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
    return NextResponse.json({ store: emptyAiStore() });
  } catch (e) {
    return fail(e);
  }
}
