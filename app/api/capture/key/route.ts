// app/api/capture/key/route.ts
// GET → the signed-in person's extension key, to paste into the Chrome extension's settings.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { captureKeyFor } from "@/lib/captureKey";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    return NextResponse.json({ email, key: captureKeyFor(email), dashboard: req.nextUrl.origin });
  } catch (e) {
    return fail(e);
  }
}
