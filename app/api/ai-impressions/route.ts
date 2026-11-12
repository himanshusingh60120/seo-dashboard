// app/api/ai-impressions/route.ts
// Generative AI report data (AI Overviews + AI Mode), from the bookmark, exports or the Chrome extension, saved for
// everyone in the Google Sheet. Data saved earlier in Upstash Redis is copied over once, the first time the Sheet has none.
// Only signed-in users who can open the property in Search Console can read or change it.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser, HttpError } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { sharedStorageReady, getJson, delKey } from "@/lib/kvStore";
import { clearAi, loadAi, restoreAi, saveAi } from "@/lib/reportStore";
import { emptyAiStore, sanitizeAiParsed, type AiParsed, type AiStore } from "@/lib/aiStore";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const oldKey = (site: string) => `ai:${site}`;

async function checkAccess(req: NextRequest, site: string) {
  if (!site) throw new HttpError(400, "Missing site");
  const token = await getGoogleAccessToken(req);
  await assertSiteAccess(token, site);
  if (!serviceAccountReady()) {
    throw new HttpError(501, "The Google Sheet isn't set up, so AI data can only be saved in this browser. Add GOOGLE_SERVICE_ACCOUNT_JSON and INDEX_SHEET_ID in Vercel and redeploy.");
  }
}

export async function GET(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    let store = await loadAi(site);
    if (!Object.keys(store.days).length && sharedStorageReady()) {
      const old = await getJson<AiStore>(oldKey(site)).catch(() => null);
      if (old && Object.keys(old.days || {}).length) {
        await restoreAi(site, old);
        store = await loadAi(site, true);
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
    const items = (Array.isArray(body.imports) ? body.imports.slice(0, 10) : []).map(sanitizeAiParsed).filter(Boolean) as AiParsed[];
    if (!items.length) throw new HttpError(400, "No daily AI impressions to save.");
    return NextResponse.json({ store: await saveAi(site, items, email) });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const site = req.nextUrl.searchParams.get("site") || "";
    await checkAccess(req, site);
    await clearAi(site, await requireUser(req));
    if (sharedStorageReady()) await delKey(oldKey(site)).catch(() => {});
    return NextResponse.json({ store: emptyAiStore() });
  } catch (e) {
    return fail(e);
  }
}
