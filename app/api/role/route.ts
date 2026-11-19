// app/api/role/route.ts
// GET → { viewer }: whether the signed-in person is a view-only account (lib/viewers.ts).
// The dashboard uses it to show the "View-only" badge and hide buttons; the routes that change things check again.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { isViewer } from "@/lib/viewers";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    return NextResponse.json({ viewer: isViewer(email) });
  } catch (e) {
    return fail(e);
  }
}
