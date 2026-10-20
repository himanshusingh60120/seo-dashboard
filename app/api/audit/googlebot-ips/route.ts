// app/api/audit/googlebot-ips/route.ts
// Google's published IP ranges for its crawlers, used to separate real Googlebot hits from fakes.
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/token";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";

const LISTS = [
  "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
  "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
];

export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const prefixes: string[] = [];
    let creationTime = "";
    for (const url of LISTS) {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
      const data = (await res.json()) as { creationTime?: string; prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] };
      if (!creationTime && data.creationTime) creationTime = data.creationTime;
      (data.prefixes || []).forEach((p) => {
        const c = p.ipv4Prefix || p.ipv6Prefix;
        if (c) prefixes.push(c);
      });
    }
    return NextResponse.json({ prefixes, creationTime, lists: LISTS });
  } catch (e) {
    return fail(e);
  }
}
