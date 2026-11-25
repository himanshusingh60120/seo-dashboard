// app/api/access/otp/route.ts
// GET → { unlockedUntil }. POST { action: "send" } emails a 6-digit code to the signed-in admin;
// { action: "verify", code } unlocks Manage access in this browser for 10 minutes; { action: "lock" } locks it again.
import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/token";
import { fail } from "@/lib/api";
import { isAccessAdmin, norm } from "@/lib/accessList";
import { clearUnlock, sendCode, setUnlock, unlockedUntil, verifyCode } from "@/lib/otp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

async function requireAdmin(req: NextRequest) {
  const email = await requireUser(req);
  if (!isAccessAdmin(email)) throw new HttpError(403, "Only the access admins can do this.");
  return norm(email);
}

export async function GET(req: NextRequest) {
  try {
    const me = await requireAdmin(req);
    return NextResponse.json({ unlockedUntil: unlockedUntil(req, me) });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const me = await requireAdmin(req);
    const b = await req.json().catch(() => ({}));
    const action = String(b?.action || "");
    if (action === "send") return NextResponse.json({ sent: true, ...(await sendCode(me)) });
    if (action === "verify") {
      const until = await verifyCode(me, String(b?.code ?? ""));
      const res = NextResponse.json({ unlockedUntil: until });
      setUnlock(res, me, until);
      return res;
    }
    if (action === "lock") {
      const res = NextResponse.json({ unlockedUntil: null });
      clearUnlock(res);
      return res;
    }
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    return fail(e);
  }
}
