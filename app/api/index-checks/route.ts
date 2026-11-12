// app/api/index-checks/route.ts
//   GET  ?site=…              → this property's daily index checks: job status and per-sitemap summary from the Sheet.
//   POST { site, enabled }    → start (adds the property's tab to the Sheet) or pause daily index checks.
// The signed-in person must have access to the property, and so must the service account.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError, requireUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountEmail, serviceAccountReady } from "@/lib/serviceAccount";
import { propertyStatus, serviceAccountCanRead, setEnabled } from "@/lib/indexJob";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) return NextResponse.json({ configured: false });
    return NextResponse.json({ configured: true, serviceAccount: serviceAccountEmail(), ...(await propertyStatus(site)) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const email = await requireUser(req);
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const site = typeof body.site === "string" ? body.site : "";
    const enabled = body.enabled !== false;
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) {
      throw new HttpError(503, "Index checks aren't set up yet: add GOOGLE_SERVICE_ACCOUNT_JSON and INDEX_SHEET_ID in Vercel.");
    }
    if (enabled && !(await serviceAccountCanRead(site))) {
      throw new HttpError(
        400,
        `Add ${serviceAccountEmail()} as a user of this property in Search Console (Settings → Users and permissions), then try again.`
      );
    }
    await setEnabled(site, enabled, email);
    return NextResponse.json({ ok: true, configured: true, serviceAccount: serviceAccountEmail(), ...(await propertyStatus(site)) });
  } catch (e) {
    return fail(e);
  }
}
