// app/api/role/route.ts
// GET → { viewer, admin, captures, indexChecks, audit, weekly } for the signed-in person (lib/accessList.ts).
// The dashboard uses it to show badges, tabs and buttons; every route checks again.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { isAccessAdmin, permsFor } from "@/lib/accessList";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    const p = await permsFor(email);
    return NextResponse.json({ ...p, viewer: p.viewOnly, admin: isAccessAdmin(email) });
  } catch (e) {
    return fail(e);
  }
}
