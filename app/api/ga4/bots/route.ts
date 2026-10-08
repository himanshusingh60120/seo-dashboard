import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { withGoogleToken, AuthError } from '@/lib/google-token';
import { CTA_REGEX } from '@/lib/cta';

export const dynamic = 'force-dynamic';

type Row = Record<string, any>;
type Kind = 'location' | 'source' | 'tech' | 'language';

// Cities that are mostly cloud / data-centre traffic in GA4
const DATA_CENTRE_CITIES = new Set([
  'Ashburn', 'Boardman', 'Council Bluffs', 'The Dalles', 'Moses Lake',
  'Quincy', 'Prineville', 'Forest City', 'Lenoir', 'Lanzhou',
]);
// Default window sizes of headless browsers / scrapers
const HEADLESS_SCREENS = new Set(['800x600', '0x0', '(not set)']);

const METRICS = ['sessions', 'engagedSessions', 'userEngagementDuration', 'totalUsers', 'newUsers'];

function assess(r: Row, kind: Kind, label: string, minSessions: number) {
  const sessions = r.sessions || 0;
  const engRate = sessions ? r.engagedSessions / sessions : 0;
  const avgEng = sessions ? r.userEngagementDuration / sessions : 0;
  const newRate = r.totalUsers ? r.newUsers / r.totalUsers : 0;
  const reasons: string[] = [];
  let score = 0;

  if (sessions >= minSessions) {
    if (engRate < 0.1) { score += 2; reasons.push(`only ${Math.round(engRate * 100)}% engaged`); }
    else if (engRate < 0.25) { score += 1; reasons.push(`low engagement (${Math.round(engRate * 100)}%)`); }
    if (avgEng < 2) { score += 1; reasons.push(`${avgEng.toFixed(1)}s average time`); }
  }
  if (sessions >= minSessions * 2 && newRate > 0.97) { score += 1; reasons.push('almost all new users'); }
  if (kind === 'location' && DATA_CENTRE_CITIES.has(r.city)) { score += 2; reasons.push('data-centre city'); }
  if (kind === 'tech' && HEADLESS_SCREENS.has(r.screenResolution)) { score += 1; reasons.push(`screen ${r.screenResolution}`); }
  if (kind === 'language' && (!r.language || r.language === '(not set)')) { score += 1; reasons.push('no browser language'); }

  return {
    label,
    sessions,
    engRate,
    avgEng,
    score,
    level: score >= 3 ? 'High' : 'Medium',
    reasons,
  };
}

const flagged = (rows: ReturnType<typeof assess>[]) =>
  rows
    .filter(r => r.score >= 2 && r.sessions >= 3)
    .sort((a, b) => b.score - a.score || b.sessions - a.sessions)
    .slice(0, 50);

export async function GET(req: NextRequest) {
  const property = req.nextUrl.searchParams.get('property');
  const days = Number(req.nextUrl.searchParams.get('days') ?? 28);
  const scope = req.nextUrl.searchParams.get('scope') === 'cta' ? 'cta' : 'site';
  if (!property) {
    return NextResponse.json({ error: 'property required' }, { status: 400 });
  }

  const base: Row = {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    limit: 10000,
    metrics: METRICS.map(name => ({ name })),
  };
  if (scope === 'cta') {
    base.dimensionFilter = {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: CTA_REGEX } },
    };
  }
  const q = (dims: string[]) => ({ ...base, dimensions: dims.map(name => ({ name })) });

  try {
    const reports = await withGoogleToken(req, token =>
      batchReports(token, property, [
        q(['country', 'city']),
        q(['sessionSource', 'sessionMedium']),
        q(['browser', 'operatingSystem', 'screenResolution']),
        q(['language']),
        q(['dateHour']),
      ])
    );

    const locations: Row[] = reports[0] ?? [];
    const sources: Row[] = reports[1] ?? [];
    const tech: Row[] = reports[2] ?? [];
    const languages: Row[] = reports[3] ?? [];
    const hours: Row[] = reports[4] ?? [];

    const totalSessions = locations.reduce((s, r) => s + (r.sessions || 0), 0);
    const minSessions = Math.max(10, Math.round(totalSessions * 0.002));

    const locFlags = flagged(locations.map(r => assess(r, 'location', `${r.city || '(not set)'}, ${r.country || '(not set)'}`, minSessions)));
    const srcFlags = flagged(sources.map(r => assess(r, 'source', `${r.sessionSource} / ${r.sessionMedium}`, minSessions)));
    const techFlags = flagged(tech.map(r => assess(r, 'tech', `${r.browser} · ${r.operatingSystem} · ${r.screenResolution}`, minSessions)));
    const langFlags = flagged(languages.map(r => assess(r, 'language', r.language || '(not set)', minSessions)));

    // Hourly spikes: hours far above the typical hour, with little engagement
    const counts = hours.map(h => h.sessions || 0).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const spikeFloor = Math.max(30, median * 8);
    const spikes = hours
      .filter(h => h.sessions >= spikeFloor)
      .map(h => {
        const engRate = h.sessions ? h.engagedSessions / h.sessions : 0;
        const avgEng = h.sessions ? h.userEngagementDuration / h.sessions : 0;
        const d = String(h.dateHour);
        const label = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:00`;
        const reasons = [`${Math.round(h.sessions / Math.max(1, median))}× a normal hour`];
        if (engRate < 0.25) reasons.push(`only ${Math.round(engRate * 100)}% engaged`);
        return {
          label,
          sessions: h.sessions,
          engRate,
          avgEng,
          score: engRate < 0.25 ? 3 : 2,
          level: engRate < 0.25 ? 'High' : 'Medium',
          reasons,
        };
      })
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 30);

    const suspiciousSessions = locFlags
      .filter(r => r.level === 'High')
      .reduce((s, r) => s + r.sessions, 0);

    return NextResponse.json({
      scope,
      totals: {
        sessions: totalSessions,
        suspiciousSessions,
        suspiciousShare: totalSessions ? suspiciousSessions / totalSessions : 0,
        spikeHours: spikes.length,
        typicalHour: median,
      },
      locations: locFlags,
      sources: srcFlags,
      tech: techFlags,
      languages: langFlags,
      spikes,
    });
  } catch (e: any) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: e?.message ?? String(e) }, { status });
  }
}
