// app/api/audit/investigate/route.ts
// Site investigation, step 1 (server): the quick checks in lib/investigate.ts. Audit account only, like every audit route.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireAuditUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { investigate } from "@/lib/investigate";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    await requireAuditUser(req);
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const siteUrl = String(body.siteUrl || "");
    await assertSiteAccess(token, siteUrl);
    const ga4 = /^\d+$/.test(String(body.ga4 || "")) ? String(body.ga4) : "";
    return NextResponse.json(await investigate({ token, site: siteUrl, ga4Hint: ga4 }));
  } catch (e) {
    return fail(e);
  }
}
