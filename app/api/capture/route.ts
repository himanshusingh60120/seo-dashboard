// app/api/capture/route.ts
// POST (with the extension key) { kind: "indexing" | "crawl" | "ai", capture } → checks what the Chrome extension
// copied exactly as the dashboard checks a bookmark copy, and saves it to the property's Google Sheet only when it adds
// up. Only capture accounts (lib/captureAccess.ts) can send captures, and only for properties with daily index checks,
// on the weekly capture list, or that the service account can open.
import { NextRequest, NextResponse } from "next/server";
import { HttpError } from "@/lib/token";
import { verifyCaptureKey } from "@/lib/captureKey";
import { assertCaptureEmail } from "@/lib/captureAccess";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { readJobs, serviceAccountCanRead } from "@/lib/indexJob";
import { captureList } from "@/lib/captureList";
import { parseIdxCapture } from "@/lib/capture/parseIdx";
import { parseCapture as parseCrawlCapture } from "@/lib/capture/parseCrawl";
import { parseAiCapture } from "@/lib/capture/parseAi";
import { sanitizeIdxParsed } from "@/lib/indexStats";
import { sanitizeAiParsed } from "@/lib/aiStore";
import { saveAi, saveCrawl, saveIdx } from "@/lib/reportStore";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const email = verifyCaptureKey(req.headers.get("x-capture-key"));
    assertCaptureEmail(email);
    if (!serviceAccountReady()) throw new HttpError(503, "The dashboard's Google Sheet isn't set up yet.");
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind || "");
    const cap = body.capture;
    const site = typeof cap?.site === "string" ? cap.site : "";
    if (!site) throw new HttpError(400, "The capture doesn't say which property it came from.");
    const known = (await readJobs()).some((j) => j.site === site) || (await captureList()).includes(site);
    if (!known && !(await serviceAccountCanRead(site))) {
      throw new HttpError(
        403,
        `${site} isn't set up in the dashboard. Open it in the dashboard's Weekly captures tab and click “Capture this property now”, or start its daily index checks.`
      );
    }
    const text = JSON.stringify(cap);
    const stamp = `Chrome extension, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

    if (kind === "indexing") {
      const r = parseIdxCapture(text, site);
      if (!r.verified) return NextResponse.json({ saved: false, summary: r.summary, problem: r.problem, notes: r.notes });
      const parsed = sanitizeIdxParsed(r.parsed);
      if (!parsed) throw new HttpError(400, "No page indexing numbers to save.");
      await saveIdx(site, parsed, email, stamp);
      return NextResponse.json({ saved: true, summary: r.summary, notes: r.notes });
    }

    if (kind === "crawl") {
      const r = parseCrawlCapture(text, site);
      if (!r.verified) {
        return NextResponse.json({ saved: false, summary: r.summary, problem: "The daily numbers didn't add up to the report's totals, so nothing was saved." });
      }
      const { saved } = await saveCrawl(
        site,
        r.items.map((p) => ({ kind: p.kind, label: p.label, days: p.days, urls: p.urls, source: `${stamp} (${p.label})` })),
        email,
        stamp
      );
      return NextResponse.json({ saved: saved > 0, summary: r.summary });
    }

    if (kind === "ai") {
      const r = parseAiCapture(text, site);
      if (!r.verified) return NextResponse.json({ saved: false, summary: r.summary, problem: r.problem, notes: r.notes });
      const item = sanitizeAiParsed({ ...r.item, file: stamp });
      if (!item) throw new HttpError(400, "No daily AI impressions to save.");
      await saveAi(site, [item], email);
      return NextResponse.json({ saved: true, summary: r.summary, notes: r.notes });
    }

    throw new HttpError(400, "Unknown report.");
  } catch (e) {
    return fail(e);
  }
}
