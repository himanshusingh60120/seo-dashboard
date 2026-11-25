// app/api/capture/access/route.ts
// GET → { allowed }: whether the signed-in person runs the weekly Search Console captures ("Weekly captures" in
// Manage access). The dashboard shows the "Weekly captures" tab only when this is true.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { canCapture } from "@/lib/permissions";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    return NextResponse.json({ allowed: await canCapture(email) });
  } catch (e) {
    return fail(e);
  }
}
