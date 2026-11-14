// app/api/archive/route.ts
// GET ?site=…           → how far this property's saved history goes (lib/archive.ts)
// POST { site, ga4 }    → link a different GA4 property to this Search Console property for the saved history
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError, requireUser } from "@/lib/token";
import { assertSiteAccess, runReport } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { archiveStatus, linkArchive } from "@/lib/archive";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const PROBE = { dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }], metrics: [{ name: "sessions" }], limit: 1 };

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) return NextResponse.json({ configured: false });
    return NextResponse.json({ configured: true, ...(await archiveStatus(site)) });
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
    const ga4 = typeof body.ga4 === "string" ? body.ga4.trim() : "";
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) throw new HttpError(503, "The Google Sheet isn't set up yet.");
    if (!/^\d+$/.test(ga4)) throw new HttpError(400, "That isn't a GA4 property ID.");
    try {
      await runReport(token, ga4, PROBE);
    } catch {
      throw new HttpError(403, "Your Google account can't read this GA4 property.");
    }
    await linkArchive(site, ga4, email);
    return NextResponse.json({ configured: true, ...(await archiveStatus(site)) });
  } catch (e) {
    return fail(e);
  }
}
