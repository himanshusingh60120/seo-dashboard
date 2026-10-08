import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // ⬇ Same token lookup as app/api/ga4/overview/route.ts
  const token: string = await getAccessToken(req);

  const property = req.nextUrl.searchParams.get('property')!;
  const days = Number(req.nextUrl.searchParams.get('days') ?? 28);
  const q = (dims: string[]) => ({
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    limit: 10000,
    dimensions: ['sessionDefaultChannelGroup', ...dims].map(name => ({ name })),
    metrics: ['sessions', 'totalUsers', 'engagedSessions', 'userEngagementDuration', 'keyEvents']
      .map(name => ({ name })),
  });

  try {
    const [sources, landing, countries, devices, campaigns] = await batchReports(token, property, [
      q(['sessionSource', 'sessionMedium']),
      q(['landingPage']),
      q(['country']),
      q(['deviceCategory']),
      q(['sessionCampaignName']),
    ]);
    return NextResponse.json({ sources, landing, countries, devices, campaigns });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
