// app/api/index-checks/route.ts
//   GET  ?site=…                        → this property's daily index checks (job, per-sitemap summary, status changes)
//                                          plus Google's own latest count from the Page indexing report.
//   POST { site, enabled, useMine? }     → start or pause daily checks. Anyone who can open the property in Search
//                                          Console can start them. If the service account hasn't been added to the
//                                          property, the checks run with the starter's own Google sign-in (saved
//                                          encrypted in Upstash Redis). useMine: switch an existing job to your sign-in.
// One row in _Jobs and one tab per property, whoever starts it, so nothing is checked twice.
// The weekly Search Console captures are served by /api/captures.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError, requireUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountEmail, serviceAccountReady } from "@/lib/serviceAccount";
import { SA_LABEL, propertyStatus, serviceAccountCanRead, setEnabled } from "@/lib/indexJob";
import { saveUserCredential } from "@/lib/userCredential";
import { loadIdx } from "@/lib/reportStore";
import { latestIdxDay } from "@/lib/indexStats";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/** Google's own latest numbers (All known pages) from the Page indexing report saved by the weekly capture. */
async function googleReport(site: string) {
  try {
    const store = await loadIdx(site);
    const L = latestIdxDay(store.views.ALL_URLS);
    if (!L) return null;
    const last = store.imports[store.imports.length - 1];
    return { indexed: L.indexed, notIndexed: L.notIndexed, date: L.date, savedAt: last?.at || "", by: last?.by || "" };
  } catch {
    return null;
  }
}

async function everything(site: string) {
  const [status, saCanRead, report] = await Promise.all([
    propertyStatus(site),
    serviceAccountCanRead(site).catch(() => false),
    googleReport(site),
  ]);
  return { configured: true, serviceAccount: serviceAccountEmail(), saCanRead, report, ...status };
}

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) return NextResponse.json({ configured: false });
    return NextResponse.json(await everything(site));
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
    await assertSiteAccess(token, site); // the person must be able to open this property in Search Console
    if (!serviceAccountReady()) {
      throw new HttpError(503, "Index checks aren't set up yet: add GOOGLE_SERVICE_ACCOUNT_JSON and INDEX_SHEET_ID in Vercel.");
    }
    if (!enabled) {
      await setEnabled(site, false, email);
      return NextResponse.json(await everything(site));
    }
    const saOk = await serviceAccountCanRead(site).catch(() => false);
    let runAs = SA_LABEL;
    if (!saOk || body.useMine === true) runAs = await saveUserCredential(req);
    await setEnabled(site, true, email, runAs);
    return NextResponse.json(await everything(site));
  } catch (e) {
    return fail(e);
  }
}
