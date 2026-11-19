// app/api/weekly/route.ts
// Which week the report covers and which properties are in it. Each property's numbers come from /api/weekly/property.
import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { WEEKLY_RULES, requireWeeklyUser, weekInfo, weeklySites } from "@/lib/weekly";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    await requireWeeklyUser(req);
    const token = await getGoogleAccessToken(req);
    const week = weekInfo(req.nextUrl.searchParams.get("week"));
    const s = await weeklySites(token);
    return NextResponse.json({ week, ...s, rules: WEEKLY_RULES });
  } catch (e) {
    return fail(e);
  }
}
