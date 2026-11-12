// app/api/capture/targets/route.ts
// GET (with the extension key) → the properties the Chrome extension should capture: every property enabled in _Jobs.
import { NextRequest, NextResponse } from "next/server";
import { verifyCaptureKey } from "@/lib/captureKey";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { readJobs } from "@/lib/indexJob";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    verifyCaptureKey(req.headers.get("x-capture-key"));
    if (!serviceAccountReady()) return NextResponse.json({ sites: [], note: "The dashboard's Google Sheet isn't set up yet." });
    const sites = (await readJobs()).filter((j) => j.enabled).map((j) => j.site);
    return NextResponse.json({ sites });
  } catch (e) {
    return fail(e);
  }
}
