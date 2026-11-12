// app/api/captures/route.ts
//   GET  ?site=…   → the weekly Search Console captures for this property: the latest update of each report, the update
//                    history (who saved what, and when) from the control Sheet's _Updates tab, and whether the property
//                    is in the weekly captures. canCapture says whether the signed-in person runs the captures.
//   POST { site }  → adds the property to the weekly captures (capture accounts only, and only if the person can open
//                    the property in Search Console). The page then asks the Chrome extension to capture it right away.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken, HttpError, requireUser } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { assertCaptureEmail, isCaptureEmail } from "@/lib/captureAccess";
import { addToCaptureList, captureList } from "@/lib/captureList";
import { readJobs } from "@/lib/indexJob";
import { batchRead, controlBook } from "@/lib/sheets";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const REPORTS = ["Page indexing", "Crawl stats", "AI impressions"];
type Update = { report: string; at: string; by: string; source: string; from: string; to: string };

const s = (v: unknown) => (v == null ? "" : String(v).trim());

/** Whether the extension captures this property every week, and why. */
async function weeklyFor(site: string) {
  const [jobs, list] = await Promise.all([readJobs(), captureList()]);
  const checks = jobs.some((j) => j.site === site && j.enabled);
  const listed = list.includes(site);
  return {
    weekly: checks || listed,
    why: checks ? "daily index checks are on" : listed ? "added to the weekly captures" : "",
  };
}

async function updatesFor(site: string) {
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
  return { captures, history };
}

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    const token = await getGoogleAccessToken(req);
    const site = req.nextUrl.searchParams.get("site") || "";
    await assertSiteAccess(token, site);
    const canCapture = isCaptureEmail(email);
    if (!serviceAccountReady()) return NextResponse.json({ configured: false, canCapture });
    const [updates, weekly] = await Promise.all([updatesFor(site), weeklyFor(site)]);
    return NextResponse.json({ configured: true, canCapture, ...updates, ...weekly });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const email = await requireUser(req);
    assertCaptureEmail(email);
    const token = await getGoogleAccessToken(req);
    const body = await req.json().catch(() => ({}));
    const site = typeof body.site === "string" ? body.site : "";
    await assertSiteAccess(token, site); // the person must be able to open this property in Search Console
    if (!serviceAccountReady()) throw new HttpError(503, "The dashboard's Google Sheet isn't set up yet.");
    const added = await addToCaptureList(site, email);
    return NextResponse.json({ ok: true, added, ...(await weeklyFor(site)) });
  } catch (e) {
    return fail(e);
  }
}
