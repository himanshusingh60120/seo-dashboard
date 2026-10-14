// app/api/audit/access/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { isAuditEmail } from "@/lib/auth";
import { llmConfig } from "@/lib/llm";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Tells the dashboard whether to show the audit tab. Every audit route checks the account again. */
export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    if (!isAuditEmail(email)) return NextResponse.json({ allowed: false });
    const c = llmConfig();
    return NextResponse.json({
      allowed: true,
      gpt: c.gpt,
      jev: c.jev,
      gptModel: c.gptModel,
      jevModel: c.jevModel,
      maxGroups: Math.max(1, Math.min(40, Number(process.env.AUDIT_MAX_AI_GROUPS) || 15)),
    });
  } catch (e) {
    return fail(e);
  }
}
