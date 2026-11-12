// app/api/cron/index-run/route.ts
// Every 10 minutes (vercel.json). Inspects queued URLs for every property and writes the results to the Sheet.
import { NextRequest, NextResponse } from "next/server";
import { assertCron } from "@/lib/cron";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { runChecks } from "@/lib/indexJob";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    assertCron(req);
    if (!serviceAccountReady()) return NextResponse.json({ skipped: "GOOGLE_SERVICE_ACCOUNT_JSON or INDEX_SHEET_ID isn't set." });
    return NextResponse.json(await runChecks(Date.now() + 50_000));
  } catch (e) {
    return fail(e);
  }
}
