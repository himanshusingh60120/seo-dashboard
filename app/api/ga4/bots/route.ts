// app/api/ga4/bots/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { withGoogleToken, AuthError } from '@/lib/google-token';
import { CTA_REGEX } from '@/lib/cta';
import { ga4Window } from '@/lib/google';
import { parseDays } from '@/lib/dates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Row = Record<string, any>;
type Kind = 'location' | 'source' | 'tech' | 'language';
type Level = 'Suspect bot' | 'High' | 'Medium';

/** Segments whose sessions average less engagement time than this (seconds) are labelled "Suspect bot". */
const SUSPECT_BOT_SECONDS = 0.2;
/** Ignore tiny segments: one or two quick bounces aren't a pattern. */
const MIN_SESSIONS = 3;
const RANK: Record<Level, number> = { 'Suspect bot': 0, High: 1, Medium: 2 };

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
  // userEngagementDuration is in seconds; this is the average per session
  const avgEng = sessions ? r.userEngagementDuration / sessions : 0;
  const newRate = r.totalUsers ? r.newUsers / r.totalUsers : 0;
  const reasons: string[] = [];
  let score = 0;

  const suspect = sessions >= MIN_SESSIONS && avgEng < SUSPECT_BOT_SECONDS;
  if (suspect) reasons.push(`${avgEng.toFixed(2)}s average engagement per session (under ${SUSPECT_BOT_SECONDS}s)`);

  if (sessions >= minSessions) {
    if (engRate < 0.1) { score += 2; reasons.push(`only ${Math.round(engRate * 100)}% engaged`); }
    else if (engRate < 0.25) { score += 1; reasons.push(`low engagement (${Math.round(engRate * 100)}%)`); }
  }
  if (sessions >= minSessions * 2 && newRate > 0.97) { score += 1; reasons.push('almost all new users'); }
  if (kind === 'location' && DATA_CENTRE_CITIES.has(r.city)) { score += 2; reasons.push('data-centre city'); }
  if (kind === 'tech' && HEADLESS_SCREENS.has(r.screenResolution)) { score += 1; reasons.push(`screen ${r.screenResolution}`); }
  if (kind === 'language' && (!r.language || r.language === '(not set)')) { score += 1; reasons.push('no browser language'); }

  const level: Level = suspect ? 'Suspect bot' : score >= 3 ? 'High' : 'Medium';
  return { label, sessions, engRate, avgEng, score, suspect, level, reasons };
}

type Assessed = ReturnType<typeof assess>;
const isFlagged = (r: Assessed) => r.sessions >= MIN_SESSIONS && (r.suspect || r.score >= 2);

const flagged = (rows: Assessed[]) =>
  rows
    .filter(isFlagged)
    .sort((a, b) => RANK[a.level] - RANK[b.level] || b.score - a.score || b.sessions - a.sessions)
    .slice(0, 50);

export async function GET(req: NextRequest) {
  const property = req.nextUrl.searchParams.get('property');
  const days = parseDays(req.nextUrl.searchParams.get('days'));
  const scope = req.nextUrl.searchParams.get('scope') === 'cta' ? 'cta' : 'site';

  if (!property || !/^\d+$/.test(property)) {
    return NextResponse.json({ error: 'property required' }, { status: 400 });
  }

  const base: Row = {
    // Filled in once the token is available: full days ending yesterday, property time zone
    dateRanges: [] as { startDate: string; endDate: string }[],
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
    const reports = await withGoogleToken(req, async token => {
      // Same window as every other GA4 view: full days ending yesterday, property time zone.
      base.dateRanges = [(await ga4Window(token, property, days)).current];
      return batchReports(token, property, [
        q(['country', 'city']),
        q(['sessionSource', 'sessionMedium']),
        q(['browser', 'operatingSystem', 'screenResolution']),
        q(['language']),
        q(['dateHour']),
      ]);
    });

    const locations: Row[] = reports[0] ?? [];
    const sources: Row[] = reports[1] ?? [];
    const tech: Row[] = reports[2] ?? [];
    const languages: Row[] = reports[3] ?? [];
    const hours: Row[] = reports[4] ?? [];

    const totalSessions = locations.reduce((s, r) => s + (r.sessions || 0), 0);
    const minSessions = Math.max(10, Math.round(totalSessions * 0.002));

    const locAll = locations.map(r => assess(r, 'location', `${r.city || '(not set)'}, ${r.country || '(not set)'}`, minSessions));
    const locFlags = flagged(locAll);
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
        const suspect = avgEng < SUSPECT_BOT_SECONDS;
        const d = String(h.dateHour);
        const label = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:00`;
        const reasons = [`${Math.round(h.sessions / Math.max(1, median))}× a normal hour`];
        if (suspect) reasons.unshift(`${avgEng.toFixed(2)}s average engagement per session (under ${SUSPECT_BOT_SECONDS}s)`);
        if (engRate < 0.25) reasons.push(`only ${Math.round(engRate * 100)}% engaged`);
        const level: Level = suspect ? 'Suspect bot' : engRate < 0.25 ? 'High' : 'Medium';
        return { label, sessions: h.sessions, engRate, avgEng, score: engRate < 0.25 ? 3 : 2, suspect, level, reasons };
      })
      .sort((a, b) => RANK[a.level] - RANK[b.level] || b.sessions - a.sessions)
      .slice(0, 30);

    // Locations split all sessions without overlap, so these sums don't double count.
    const suspectBotSessions = locAll.filter(r => r.suspect).reduce((s, r) => s + r.sessions, 0);
    const suspiciousSessions = locAll
      .filter(r => isFlagged(r) && (r.level === 'Suspect bot' || r.level === 'High'))
      .reduce((s, r) => s + r.sessions, 0);

    return NextResponse.json({
      scope,
      window: base.dateRanges[0],
      threshold: SUSPECT_BOT_SECONDS,
      totals: {
        sessions: totalSessions,
        suspectBotSessions,
        suspectBotShare: totalSessions ? suspectBotSessions / totalSessions : 0,
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
