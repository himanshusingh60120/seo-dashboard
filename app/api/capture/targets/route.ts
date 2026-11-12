// app/api/capture/targets/route.ts
// GET (with the extension key) → the properties the Chrome extension should capture: every property with daily index
// checks turned on, plus every property on the weekly capture list (_Captures). Only capture accounts are answered.
import { NextRequest, NextResponse } from "next/server";
import { verifyCaptureKey } from "@/lib/captureKey";
import { assertCaptureEmail } from "@/lib/captureAccess";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { readJobs } from "@/lib/indexJob";
import { captureList } from "@/lib/captureList";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    assertCaptureEmail(verifyCaptureKey(req.headers.get("x-capture-key")));
    if (!serviceAccountReady()) return NextResponse.json({ sites: [], note: "The dashboard's Google Sheet isn't set up yet." });
    const [jobs, list] = await Promise.all([readJobs(), captureList()]);
    const sites = Array.from(new Set([...jobs.filter((j) => j.enabled).map((j) => j.site), ...list]));
    return NextResponse.json({ sites });
  } catch (e) {
    return fail(e);
  }
}
