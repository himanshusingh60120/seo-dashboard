import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { batchReports } from '@/lib/ga4-report';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Google access token from the encrypted NextAuth session cookie
  const jwt: any = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const token: string | undefined = jwt?.accessToken ?? jwt?.access_token;
  if (!token) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

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
    const reports = await batchReports(token, property, [
      q(['sessionSource', 'sessionMedium']),
      q(['landingPage']),
      q(['country']),
      q(['deviceCategory']),
      q(['sessionCampaignName']),
    ]);

    return NextResponse.json({
      sources: reports[0] ?? [],
      landing: reports[1] ?? [],
      countries: reports[2] ?? [],
      devices: reports[3] ?? [],
      campaigns: reports[4] ?? [],
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
