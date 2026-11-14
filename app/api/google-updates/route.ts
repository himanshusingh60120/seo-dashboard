// app/api/google-updates/route.ts
// GET → { updates }: Google's confirmed ranking updates (core, spam…), for shading the charts. See lib/googleUpdates.ts.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { googleUpdates } from "@/lib/googleUpdates";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const updates = await googleUpdates();
    return NextResponse.json({ updates }, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (e) {
    return fail(e);
  }
}
