import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { withGoogleToken, AuthError } from '@/lib/google-token';
import { CTA_REGEX, ctaOf, reportIdOf, slugOf } from '@/lib/cta';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

export async function GET(req: NextRequest) {
  const property = req.nextUrl.searchParams.get('property');
  const days = Number(req.nextUrl.searchParams.get('days') ?? 28);
  if (!property) {
    return NextResponse.json({ error: 'property required' }, { status: 400 });
  }

  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'today' }];
  const dimensionFilter = {
    filter: {
      fieldName: 'pagePath',
      stringFilter: { matchType: 'FULL_REGEXP', value: CTA_REGEX },
    },
  };
  const q = (dims: string[]) => ({
    dateRanges,
    dimensionFilter,
    limit: 10000,
    dimensions: dims.map(name => ({ name })),
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
  });

  try {
    const [batchA, batchB] = await withGoogleToken(req, token =>
      Promise.all([
        batchReports(token, property, [
          q(['pagePathPlusQueryString']),
          q(['pagePath', 'sessionDefaultChannelGroup']),
          q(['pagePath', 'sessionSource', 'sessionMedium']),
          q(['pagePath', 'country', 'region']),
        ]),
        batchReports(token, property, [
          q(['pagePath', 'pageReferrer']),
          q(['pagePath', 'deviceCategory']),
          q(['pagePath', 'country', 'city']),
        ]),
      ])
    );

    const pages: Row[] = batchA[0] ?? [];
    const channels: Row[] = batchA[1] ?? [];
    const sources: Row[] = batchA[2] ?? [];
    const regions: Row[] = batchA[3] ?? [];
    const referrers: Row[] = batchB[0] ?? [];
    const devices: Row[] = batchB[1] ?? [];
    const cities: Row[] = batchB[2] ?? [];

    // report id -> readable slug (license pages only carry ?id=)
    const slugById = new Map<string, string>();
    for (const r of pages) {
      const full = String(r.pagePathPlusQueryString ?? '');
      const id = reportIdOf(full);
      const slug = slugOf(full.split('?')[0]);
      if (id && slug) slugById.set(id, slug);
    }

    // Tag each row with its CTA and drop rows that don't belong to a CTA
    const tag = (rows: Row[], pathKey: string = 'pagePath'): Row[] =>
      rows
        .map((r: Row) => {
          const path = String(r[pathKey] ?? '');
          const rest: Row = { ...r };
          delete rest[pathKey];
          return { cta: ctaOf(path.split('?')[0]), ...rest, path };
        })
        .filter((r: Row) => r.cta);

    const shortRef = (ref: string): string => {
      if (!ref) return '(none / direct)';
      try {
        const u = new URL(ref);
        return u.hostname.endsWith('kingsresearch.com') ? u.pathname || '/' : u.hostname;
      } catch {
        return ref;
      }
    };

    return NextResponse.json({
      pages: tag(pages, 'pagePathPlusQueryString').map((r: Row) => {
        const id = reportIdOf(String(r.path));
        return {
          ...r,
          report: id ? slugById.get(id) ?? `report #${id}` : '(no report)',
        };
      }),
      channels: tag(channels),
      sources: tag(sources),
      regions: tag(regions),
      referrers: tag(referrers).map((r: Row) => ({
        ...r,
        pageReferrer: shortRef(String(r.pageReferrer ?? '')),
      })),
      devices: tag(devices),
      cities: tag(cities),
    });
  } catch (e: any) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: e?.message ?? String(e) }, { status });
  }
}
