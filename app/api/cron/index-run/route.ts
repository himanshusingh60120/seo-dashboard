// app/api/cron/index-run/route.ts
// Every 30 minutes, at :20 and :50 (vercel.json), clear of the plan job at :05 and :35. Inspects queued URLs and writes
// the results to each property's Sheet. Each run starts batches for about 4 minutes, working on up to INDEX_LANES
// properties at the same time (default 3; batches of 40 URLs, taking turns between properties): roughly 800–1,400
// URLs per run, so 48 runs a day cover 1,800 checks for each of about 20–35 properties. If "Checked today" in the
// Index checks tab keeps stopping short of the daily budget, set INDEX_LANES to 4 in Vercel.
// The last batch always finishes before Vercel's 300-second limit, so no batch is cut off halfway.
// Waits while the Sheet is being moved to the one-tab-per-property layout (that happens in the plan job).
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
      return NextResponse.json({ skipped: "Waiting for the Sheet to be reorganised (this happens in the plan job)." });
    }
    return NextResponse.json(await runChecks(Date.now() + WORK_MS));
  } catch (e) {
    return fail(e);
  }
}
