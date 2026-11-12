// app/api/index-checks/route.ts
//   GET  ?site=…             → this property's daily index checks (job, per-sitemap summary, status changes) and the
//                              last weekly capture of each Search Console report (Chrome extension or bookmark).
//   POST { site, enabled }   → start (adds the property's tab to the Sheet) or pause daily index checks.
// The signed-in person must have access to the property, and so must the service account.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError, requireUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountEmail, serviceAccountReady } from "@/lib/serviceAccount";
import { propertyStatus, serviceAccountCanRead, setEnabled } from "@/lib/indexJob";
import { batchRead } from "@/lib/sheets";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const REPORTS = ["Page indexing", "Crawl stats", "AI impressions"];

/** The latest save of each report for this property, from the _Updates tab. */
async function captureStatus(site: string) {
  const [rows] = await batchRead([{ title: "_Updates", range: "A2:I" }]);
  const last: Record<string, { report: string; at: string; by: string; source: string; from: string; to: string }> = {};
  for (const r of rows) {
    if (String(r[1] ?? "") !== site) continue;
    const report = String(r[2] ?? "");
    if (String(r[4] ?? "") === "Deleted") {
      delete last[report];
      continue;
    }
    last[report] = { report, at: String(r[0] ?? ""), by: String(r[3] ?? ""), source: String(r[4] ?? ""), from: String(r[5] ?? ""), to: String(r[6] ?? "") };
  }
  return REPORTS.map((report) => last[report] || { report, at: "", by: "", source: "", from: "", to: "" });
}

async function everything(site: string) {
  const [status, captures] = await Promise.all([propertyStatus(site), captureStatus(site)]);
  return { configured: true, serviceAccount: serviceAccountEmail(), ...status, captures };
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
    return NextResponse.json(await everything(site));
  } catch (e) {
    return fail(e);
  }
}
