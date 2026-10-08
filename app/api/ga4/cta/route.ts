import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { withGoogleToken, AuthError } from '@/lib/google-token';
import { CTAS, CTA_REGEX, ctaOf, reportIdOf, slugOf } from '@/lib/cta';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;

// Exact GA4 filters per CTA, used for the headline totals (immune to "(other)" grouping)
const CTA_FILTERS: Record<string, { matchType: string; value: string }> = {
  license: { matchType: 'BEGINS_WITH', value: '/license-variant' },
  sample: { matchType: 'BEGINS_WITH', value: '/request-sample/' },
  expert: { matchType: 'BEGINS_WITH', value: '/talk-to-expert/' },
  custom: { matchType: 'BEGINS_WITH', value: '/customization/' },
  connect: { matchType: 'FULL_REGEXP', value: '/connect/?' },
};

export async function GET(req: NextRequest) {
  const property = req.nextUrl.searchParams.get('property');
  const days = Number(req.nextUrl.searchParams.get('days') ?? 28);
  if (!property) {
    return NextResponse.json({ error: 'property required' }, { status: 400 });
  }

  // Full days ending yesterday, the same as GA4's "Last N days"
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];
  const metrics = [{ name: 'screenPageViews' }, { name: 'totalUsers' }];
  const ctaFilter = {
    filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: CTA_REGEX } },
  };

  const q = (dims: string[]) => ({
    dateRanges,
    dimensionFilter: ctaFilter,
    limit: 10000,
    dimensions: dims.map(name => ({ name })),
    metrics,
  });

  const totalQ = (key: string) => ({
    dateRanges,
    metrics,
    dimensionFilter: { filter: { fieldName: 'pagePath', stringFilter: CTA_FILTERS[key] } },
  });

  // Any page whose URL mentions a CTA word, to catch URLs that don't match the expected pattern
  const nearMissQ = {
    dateRanges,
    limit: 1000,
    dimensions: [{ name: 'pagePath' }],
    metrics,
    dimensionFilter: {
      filter: {
        fieldName: 'pagePath',
        stringFilter: {
          matchType: 'PARTIAL_REGEXP',
          value: 'license-variant|request-sample|talk-to-expert|customization|connect',
        },
      },
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
  };

  try {
    const [batchA, batchB, batchC] = await withGoogleToken(req, token =>
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
          nearMissQ,
        ]),
        batchReports(token, property, CTAS.map(c => totalQ(c.key))),
      ])
    );

    const pages: Row[] = batchA[0] ?? [];
    const channels: Row[] = batchA[1] ?? [];
    const sources: Row[] = batchA[2] ?? [];
    const regions: Row[] = batchA[3] ?? [];
    const referrers: Row[] = batchB[0] ?? [];
    const devices: Row[] = batchB[1] ?? [];
    const cities: Row[] = batchB[2] ?? [];
    const nearMissRows: Row[] = batchB[3] ?? [];

    // Exact headline totals per CTA
    const totals: Record<string, { views: number; users: number }> = {};
    CTAS.forEach((c, i) => {
      const row = (batchC[i] ?? [])[0];
      totals[c.key] = { views: row?.screenPageViews ?? 0, users: row?.totalUsers ?? 0 };
    });

    // Views GA4 grouped into "(other)" (too many distinct URLs) — breakdowns can't attribute these
    const otherViews = pages
      .filter(r => r.pagePathPlusQueryString === '(other)')
      .reduce((s, r) => s + (r.screenPageViews || 0), 0);

    // URLs that mention a CTA word but aren't counted as a CTA
    const nearMisses = nearMissRows
      .filter(r => r.pagePath !== '(other)' && !ctaOf(String(r.pagePath)))
      .slice(0, 25)
      .map(r => ({ path: r.pagePath, views: r.screenPageViews, users: r.totalUsers }));

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
      totals,
      otherViews,
      nearMisses,
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
