// app/api/access/route.ts
// Manage who can sign in. Access admins only (lib/accessList.ts).
// GET → { grants, domains }   POST { email } → add   DELETE ?email= → remove
import { NextRequest, NextResponse } from "next/server";
import { requireUser, HttpError } from "@/lib/token";
import { fail } from "@/lib/api";
import { allowedDomains, isAllowedEmail } from "@/lib/auth";
import { isAccessAdmin, listGranted, grantAccess, revokeAccess } from "@/lib/accessList";
import { sharedStorageReady } from "@/lib/kvStore";

export const dynamic = "force-dynamic";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdmin(req: NextRequest) {
  const email = await requireUser(req);
  if (!isAccessAdmin(email)) throw new HttpError(403, "Only access admins can manage who signs in.");
  if (!sharedStorageReady()) throw new HttpError(503, "Upstash Redis isn't connected, so added emails can't be saved.");
  return email;
}

function cleanEmail(raw: unknown) {
  const e = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL.test(e)) throw new HttpError(400, "Enter a full email address, e.g. name@company.com");
  return e;
}

const reply = async (grants: unknown) => NextResponse.json({ grants, domains: allowedDomains() });

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    return reply(await listGranted(true));
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const by = await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    const email = cleanEmail(body?.email);
    if (isAllowedEmail(email)) throw new HttpError(400, `${email} can already sign in (company domain or ALLOWED_EMAILS).`);
    return reply(await grantAccess(email, by));
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin(req);
    return reply(await revokeAccess(cleanEmail(req.nextUrl.searchParams.get("email"))));
  } catch (e) {
    return fail(e);
  }
}
