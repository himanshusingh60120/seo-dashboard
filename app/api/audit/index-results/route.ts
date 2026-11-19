// app/api/audit/index-results/route.ts
// Site investigation: Google's index status for every tracked URL, as saved by the daily index checks.
// Reads the property's Sheet only; never calls URL Inspection. Audit account only, like every audit route.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError, requireAuditUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { readIndexPage } from "@/lib/indexSheet";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    await requireAuditUser(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    if (!site) throw new HttpError(400, "Missing site");
    const token = await getGoogleAccessToken(req);
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) return NextResponse.json({ configured: false, rows: [], next: 0, done: true, job: null });
    const offset = Math.max(0, Math.floor(Number(req.nextUrl.searchParams.get("offset")) || 0));
    return NextResponse.json(await readIndexPage(site, offset));
  } catch (e) {
    return fail(e);
  }
}
