// app/api/role/route.ts
// GET → { viewer, admin }: view-only account (lib/viewers.ts) and access admin (lib/accessList.ts).
// The dashboard uses it to show badges and the Manage access tab; the routes check again.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { isViewer } from "@/lib/viewers";
import { isAccessAdmin } from "@/lib/accessList";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    return NextResponse.json({ viewer: isViewer(email), admin: isAccessAdmin(email) });
  } catch (e) {
    return fail(e);
  }
}
