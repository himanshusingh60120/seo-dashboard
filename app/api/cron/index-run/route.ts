// app/api/cron/index-run/route.ts
// Every 30 minutes, at :20 and :50 (vercel.json), clear of the hourly plan job at :05. Inspects queued URLs for every
// property and writes the results to the Sheet. Each run starts batches for about 4 minutes (batches of 40 URLs,
// shared between properties in turns), roughly 300–450 URLs per run. 48 runs a day cover 1,800 checks for each of
// up to about 8 properties; with more than that, run every 20 minutes instead ("15,35,55 * * * *").
// The last batch always finishes before Vercel's 300-second limit, so no batch is cut off halfway.
// Waits while the Sheet is being moved to the one-tab-per-property layout (that happens in the hourly plan job).
import { NextRequest, NextResponse } from "next/server";
import { assertCron } from "@/lib/cron";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { layoutReady } from "@/lib/sheetLayout";
import { runChecks } from "@/lib/indexJob";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Vercel stops the function after this many seconds. */
export const maxDuration = 300;
/** runChecks starts no new batch after (this − 15 s), i.e. after about 235 s; a batch takes 20–35 s, so it ends by about 270 s. */
const WORK_MS = 250_000;

export async function GET(req: NextRequest) {
  try {
    assertCron(req);
    if (!serviceAccountReady()) return NextResponse.json({ skipped: "GOOGLE_SERVICE_ACCOUNT_JSON or INDEX_SHEET_ID isn't set." });
    if (!(await layoutReady())) {
      return NextResponse.json({ skipped: "Waiting for the Sheet to be reorganised (this happens in the hourly plan job)." });
    }
    return NextResponse.json(await runChecks(Date.now() + WORK_MS));
  } catch (e) {
    return fail(e);
  }
}
