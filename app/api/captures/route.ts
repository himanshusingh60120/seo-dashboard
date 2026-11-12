// app/api/captures/route.ts
// GET ?site=… → the weekly Search Console captures for this property: the latest update of each report, and the
// update history (who saved what, and when), from the _Updates tab of the control Sheet. canCapture says whether the
// signed-in person runs the captures (and so may see the Chrome extension section).
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, requireUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { isCaptureEmail } from "@/lib/captureAccess";
import { batchRead, controlBook } from "@/lib/sheets";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const REPORTS = ["Page indexing", "Crawl stats", "AI impressions"];
type Update = { report: string; at: string; by: string; source: string; from: string; to: string };

const s = (v: unknown) => (v == null ? "" : String(v).trim());

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    const token = await getGoogleAccessToken(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, site);
    const canCapture = isCaptureEmail(email);
    if (!serviceAccountReady()) return NextResponse.json({ configured: false, canCapture });

    const [rows] = await batchRead(controlBook(), [{ title: "_Updates", range: "A2:I" }]);

    // One entry per save. Crawl stats writes one row per series (All / Refresh / Discovery) at the same moment,
    // so rows with the same report, time and person are merged.
    const merged = new Map<string, Update>();
    for (const r of rows) {
      if (s(r[1]) !== site) continue;
      const u: Update = { report: s(r[2]), at: s(r[0]), by: s(r[3]), source: s(r[4]), from: s(r[5]), to: s(r[6]) };
      const key = `${u.report}|${u.at}|${u.by}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, u);
        continue;
      }
      if (u.from && (!prev.from || u.from < prev.from)) prev.from = u.from;
      if (u.to && (!prev.to || u.to > prev.to)) prev.to = u.to;
      if (/\(.+\)$/.test(prev.source)) prev.source = prev.source.replace(/\s*\(.+\)$/, "");
    }
    const all = Array.from(merged.values());

    // Latest update of each report (a "Deleted" entry clears the ones before it).
    const last: Record<string, Update> = {};
    for (const u of all) {
      if (u.source === "Deleted") {
        delete last[u.report];
        continue;
      }
      last[u.report] = u;
    }
    const captures = REPORTS.map((report) => last[report] || { report, at: "", by: "", source: "", from: "", to: "" });
    const history = all.slice(-60).reverse();

    return NextResponse.json({ configured: true, canCapture, captures, history });
  } catch (e) {
    return fail(e);
  }
}
