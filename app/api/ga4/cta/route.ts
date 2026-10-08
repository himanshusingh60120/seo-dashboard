import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { CTA_REGEX, ctaOf, reportIdOf, slugOf } from '@/lib/cta';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // ⬇ Use the SAME access-token lookup as app/api/ga4/overview/route.ts
  const token: string = await getAccessToken(req);

  const property = req.nextUrl.searchParams.get('property');
  const days = Number(req.nextUrl.searchParams.get('days') ?? 28);
  if (!property) return NextResponse.json({ error: 'property required' }, { status: 400 });

  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'today' }];
  const dimensionFilter = {
    filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: CTA_REGEX } },
  };
  const q = (dims: string[]) => ({
    dateRanges, dimensionFilter, limit: 10000,
    dimensions: dims.map(name => ({ name })),
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
  });

  try {
    const [[pages, channels, sources, regions], [referrers, devices, cities]] = await Promise.all([
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
    ]);

    // report id -> readable slug (license pages only carry the id)
    const slugById = new Map<string, string>();
    for (const r of pages) {
      const id = reportIdOf(r.pagePathPlusQueryString);
      const slug = slugOf(r.pagePathPlusQueryString.split('?')[0]);
      if (id && slug) slugById.set(id, slug);
    }

    const tag = (rows: any[], pathKey = 'pagePath') =>
      rows.map(({ [pathKey]: p, ...rest }) => ({ cta: ctaOf(p.split('?')[0]), ...rest, path: p }))
          .filter(r => r.cta);

    const shortRef = (ref: string) => {
      if (!ref) return '(none / direct)';
      try {
        const u = new URL(ref);
        return u.hostname.endsWith('kingsresearch.com') ? u.pathname : u.hostname;
      } catch { return ref; }
    };

    return NextResponse.json({
      pages: tag(pages, 'pagePathPlusQueryString').map(r => {
        const id = reportIdOf(r.path);
        return { ...r, report: id ? slugById.get(id) ?? `report #${id}` : '(no report)' };
      }),
      channels: tag(channels),
      sources: tag(sources),
      regions: tag(regions),
      referrers: tag(referrers).map(r => ({ ...r, pageReferrer: shortRef(r.pageReferrer) })),
      devices: tag(devices),
      cities: tag(cities),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
