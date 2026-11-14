// app/api/compare/route.ts
// GET ?site=…&a=2026-10,2026-09&b=2025-10 → month-by-month comparison from the saved history (lib/compare.ts).
// Without a and b it returns only the timeline (which months are saved), for the month picker.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { assertSiteAccess } from "@/lib/google";
import { serviceAccountReady } from "@/lib/serviceAccount";
import { layoutReady } from "@/lib/sheetLayout";
import { MONTH, compareData } from "@/lib/compare";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const months = (v: string | null) => (v || "").split(",").map((x) => x.trim()).filter((x) => MONTH.test(x)).slice(0, 48);

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const p = req.nextUrl.searchParams;
    const site = p.get("site") || "";
    await assertSiteAccess(token, site);
    if (!serviceAccountReady()) return NextResponse.json({ error: "The Google Sheet isn't set up yet." }, { status: 501 });
    if (!(await layoutReady())) return NextResponse.json({ error: "The Sheets are being reorganised; try again in a few minutes." }, { status: 503 });
    return NextResponse.json(await compareData(site, months(p.get("a")), months(p.get("b")), token));
  } catch (e) {
    return fail(e);
  }
}
