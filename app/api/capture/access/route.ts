// app/api/capture/access/route.ts
// GET → { allowed }: whether the signed-in person runs the weekly Search Console captures (CAPTURE_EMAILS,
// see lib/captureAccess.ts). The dashboard shows the "Weekly captures" tab only when this is true.
// Reads nothing from Google or the Sheets, so it answers at once.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { isCaptureEmail } from "@/lib/captureAccess";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    return NextResponse.json({ allowed: isCaptureEmail(email) });
  } catch (e) {
    return fail(e);
  }
}
