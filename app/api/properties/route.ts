import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/token";
import { listSites, listGa4Properties, listWebStreamHosts, normalizeHost } from "@/lib/google";
import { fail, pool } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const token = await getGoogleAccessToken(req);
    const [sites, props] = await Promise.all([
      listSites(token),
      listGa4Properties(token).catch(() => []),
    ]);
    const ga4 = await pool(props, 8, async (p) => ({ ...p, hosts: await listWebStreamHosts(token, p.id) }));

    const gsc = sites
      .map((s) => {
        const host = normalizeHost(s.siteUrl);
        // Match on host, or on a subdomain of a domain property
        const match = ga4.find((p) => p.hosts.some((h) => h === host || h.endsWith(`.${host}`)));
        return { siteUrl: s.siteUrl, host, permission: s.permissionLevel, ga4Id: match?.id || null };
      })
      .sort((a, b) => a.host.localeCompare(b.host));

    return NextResponse.json({ gsc, ga4 });
  } catch (e) {
    return fail(e);
  }
}
