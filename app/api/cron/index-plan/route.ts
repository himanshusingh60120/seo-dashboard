// app/api/cron/index-plan/route.ts
// Hourly (vercel.json). First moves the Sheet to the one-tab-per-property layout if that hasn't happened yet, then
// plans each enabled property's checks once per Pacific day, after Google's quota resets.
// Properties not reached in this call are planned in the next hour.
import { NextRequest, NextResponse } from "next/server";
import { assertCron } from "@/lib/cron";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { migrateIfNeeded } from "@/lib/sheetMigrate";
import { layoutReady } from "@/lib/sheetLayout";
import { failJob, planProperty, readJobs, today } from "@/lib/indexJob";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    assertCron(req);
    if (!serviceAccountReady()) return NextResponse.json({ skipped: "GOOGLE_SERVICE_ACCOUNT_JSON or INDEX_SHEET_ID isn't set." });
    const started = Date.now();
    const layout = await migrateIfNeeded();
    if (!(await layoutReady())) return NextResponse.json({ skipped: layout || "The Sheet is being reorganised." });

    const day = today();
    const jobs = (await readJobs()).filter(
      (j) => j.enabled && j.planDay !== day && !(j.planStatus === "planning" && Date.now() - Date.parse(j.plannedAt) < 15 * 60_000)
    );
    const planned: { site: string; result: string }[] = [];
    for (const j of jobs) {
      if (Date.now() - started > 180_000) break; // leave room to finish inside the 300-second limit
      try {
        planned.push({ site: j.site, result: await planProperty(j, day) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error";
        await failJob(j, msg);
        planned.push({ site: j.site, result: `failed: ${msg}` });
      }
    }
    return NextResponse.json({ layout, day, planned, waiting: jobs.length - planned.length });
  } catch (e) {
    return fail(e);
  }
}
