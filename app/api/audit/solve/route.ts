// app/api/audit/solve/route.ts
// Audit step (server): one issue group → GPT fix, double-checked by code and Jev (see lib/audit/solve.ts).
// One group per request keeps each call inside Vercel's 60-second limit.
import { NextRequest, NextResponse } from "next/server";
import { requireAuditUser } from "@/lib/token";
import { CATALOG, type IssueGroup } from "@/lib/audit/catalog";
import { solveGroup } from "@/lib/audit/solve";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    await requireAuditUser(req);
    const body = await req.json().catch(() => ({}));
    const g = body.group as IssueGroup | undefined;
    if (!g || !Object.prototype.hasOwnProperty.call(CATALOG, g.type)) {
      return NextResponse.json({ error: "Unknown issue type" }, { status: 400 });
    }
    const c = CATALOG[g.type];
    // Title, severity and category always come from the catalog, never from the request.
    const group: IssueGroup = {
      type: g.type,
      title: c.title,
      severity: c.severity,
      category: c.category,
      count: Math.max(0, Number(g.count) || 0),
      urls: (Array.isArray(g.urls) ? g.urls : []).slice(0, 300).map(String),
      evidence: (Array.isArray(g.evidence) ? g.evidence : []).slice(0, 15),
      metrics: g.metrics && typeof g.metrics === "object" ? g.metrics : {},
      source: String(g.source || ""),
      fingerprint: String(g.fingerprint || g.type).slice(0, 80),
    };
    return NextResponse.json(await solveGroup(String(body.siteUrl || ""), group));
  } catch (e) {
    return fail(e);
  }
}
