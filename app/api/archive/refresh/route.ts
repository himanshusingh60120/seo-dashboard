// app/api/archive/refresh/route.ts
// POST { site, ga4 } → brings this property's saved history up to date (lib/archive.ts), using the signed-in person's
// own Google access. The dashboard calls it when a property is opened. The first open of the day does the work; later
// opens return at once. Answers { done: false } when it ran out of time, so the dashboard asks again.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { layoutReady } from "@/lib/sheetLayout";
import { refreshArchive } from "@/lib/archive";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const email = await requireUser(req);
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const site = typeof body.site === "string" ? body.site : "";
    const ga4 = typeof body.ga4 === "string" && /^\d+$/.test(body.ga4) ? body.ga4 : "";
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) return NextResponse.json({ done: true, message: "The Google Sheet isn't set up." });
    if (!(await layoutReady())) return NextResponse.json({ done: true, message: "The Sheets are being reorganised; try later." });
    return NextResponse.json(await refreshArchive({ site, ga4, by: email, token, deadline: Date.now() + 40_000 }));
  } catch (e) {
    return fail(e);
  }
}
