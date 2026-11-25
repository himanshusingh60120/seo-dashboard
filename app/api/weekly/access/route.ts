// app/api/weekly/access/route.ts
// Tells the dashboard whether to show the Weekly report. Every weekly route checks the account again.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { hasPerm } from "@/lib/accessList";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    return NextResponse.json({ allowed: await hasPerm(email, "weekly") });
  } catch (e) {
    return fail(e);
  }
}
