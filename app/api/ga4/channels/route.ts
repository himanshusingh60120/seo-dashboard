import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { withGoogleToken, AuthError } from '@/lib/google-token';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const property = req.nextUrl.searchParams.get('property');
  const days = Number(req.nextUrl.searchParams.get('days') ?? 28);
  if (!property) {
    return NextResponse.json({ error: 'property required' }, { status: 400 });
  }

  const q = (dims: string[]) => ({
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    limit: 10000,
    dimensions: ['sessionDefaultChannelGroup', ...dims].map(name => ({ name })),
    metrics: [
      'sessions',
      'totalUsers',
      'engagedSessions',
      'userEngagementDuration',
      'keyEvents',
    ].map(name => ({ name })),
  });

  try {
    const reports = await withGoogleToken(req, token =>
      batchReports(token, property, [
        q(['sessionSource', 'sessionMedium']),
        q(['landingPage']),
        q(['country']),
        q(['deviceCategory']),
        q(['sessionCampaignName']),
      ])
    );

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
