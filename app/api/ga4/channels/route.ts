// app/api/ga4/channels/route.ts
import { NextRequest, NextResponse } from "next/server";
import { batchReports } from "@/lib/ga4-report";
import { withGoogleToken, AuthError } from "@/lib/google-token";
import { ga4Window } from "@/lib/google";
import { parseDays } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const property = req.nextUrl.searchParams.get("property") || "";
  const days = parseDays(req.nextUrl.searchParams.get("days"));
  if (!/^\d+$/.test(property)) return NextResponse.json({ error: "property required" }, { status: 400 });

  try {
    const reports = await withGoogleToken(req, async (token) => {
      // Same window as every other GA4 view: full days ending yesterday, property time zone.
      const { current } = await ga4Window(token, property, days);
      const q = (dims: string[]) => ({
        dateRanges: [current],
        limit: 10000,
        dimensions: ["sessionDefaultChannelGroup", ...dims].map((name) => ({ name })),
        metrics: ["sessions", "totalUsers", "engagedSessions", "userEngagementDuration", "keyEvents"].map((name) => ({ name })),
      });
      return batchReports(token, property, [
        q(["sessionSource", "sessionMedium"]),
        q(["landingPage"]),
        q(["country"]),
        q(["deviceCategory"]),
        q(["sessionCampaignName"]),
      ]);
    });
    return NextResponse.json({
      sources: reports[0] ?? [],
      landing: reports[1] ?? [],
      countries: reports[2] ?? [],
      devices: reports[3] ?? [],
      campaigns: reports[4] ?? [],
    });
  } catch (e: any) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: e?.message ?? String(e) }, { status });
  }
}
