// app/api/ga4/bots/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { batchReports } from '@/lib/ga4-report';
import { withGoogleToken, AuthError } from '@/lib/google-token';
import { CTA_REGEX } from '@/lib/cta';
import { ga4Window } from '@/lib/google';
import { parseDays } from '@/lib/dates';

export const dynamic = 'force-dynamic';
// Long periods (up to 16 months) mean many hourly rows, so allow more than 60 seconds.
export const maxDuration = 120;

type Row = Record<string, any>;
type Kind = 'location' | 'source' | 'tech' | 'language';
type Level = 'Suspect bot' | 'High' | 'Medium';

/** Segments whose sessions average less engagement time than this (seconds) are labelled "Suspect bot". */
const SUSPECT_BOT_SECONDS = 0.1;
/** Ignore tiny segments: one or two quick bounces aren't a pattern. */
const MIN_SESSIONS = 3;
/** Pages listed per box. */
const MAX_PAGES = 500;
/** Rows per report. Hourly reports need more: 16 months is about 11,700 hours. */
const ROW_LIMIT = 10000;
const HOUR_LIMIT = 25000;
const HOUR_PAGE_LIMIT = 50000;
const RANK: Record<Level, number> = { 'Suspect bot': 0, High: 1, Medium: 2 };

// Cities that are mostly cloud / data-centre traffic in GA4
const DATA_CENTRE_CITIES = new Set([
  'Ashburn', 'Boardman', 'Council Bluffs', 'The Dalles', 'Moses Lake',
  'Quincy', 'Prineville', 'Forest City', 'Lenoir', 'Lanzhou',
]);

// Default window sizes of headless browsers / scrapers
const HEADLESS_SCREENS = new Set(['800x600', '0x0', '(not set)']);

const METRICS = ['sessions', 'engagedSessions', 'userEngagementDuration', 'totalUsers', 'newUsers'];

const locLabel = (r: Row) => `${r.city || '(not set)'}, ${r.country || '(not set)'}`;
const hourLabel = (v: unknown) => {
  const d = String(v);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:00`;
};

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

/** Landing pages of the sessions that pass `keep`, with where those sessions came from. */
function pageList(rows: Row[], keep: (r: Row) => boolean, whereOf: (r: Row) => string) {
  const m = new Map<string, { sessions: number; engaged: number; duration: number; where: Map<string, number> }>();
  for (const r of rows) {
    if (!keep(r)) continue;
    const page = r.landingPage || '(not set)';
    let a = m.get(page);
    if (!a) {
      a = { sessions: 0, engaged: 0, duration: 0, where: new Map() };
      m.set(page, a);
    }
    const s = r.sessions || 0;
    a.sessions += s;
    a.engaged += r.engagedSessions || 0;
    a.duration += r.userEngagementDuration || 0;
    const w = whereOf(r);
    a.where.set(w, (a.where.get(w) || 0) + s);
  }
  return Array.from(m.entries())
    .map(([page, a]) => ({
      page,
      sessions: a.sessions,
      engRate: a.sessions ? a.engaged / a.sessions : 0,
      avgEng: a.sessions ? a.duration / a.sessions : 0,
      from: Array.from(a.where.entries())
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([w, n]) => `${w} (${n.toLocaleString()})`)
        .join('; '),
    }))
    .filter((p) => p.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, MAX_PAGES);
}

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
    limit: ROW_LIMIT,
    metrics: METRICS.map(name => ({ name })),
  };
  if (scope === 'cta') {
    base.dimensionFilter = {
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'FULL_REGEXP', value: CTA_REGEX } },
    };
  }

  const q = (dims: string[], limit = ROW_LIMIT) => ({ ...base, limit, dimensions: dims.map(name => ({ name })) });

  try {
    const reports = await withGoogleToken(req, async token => {
      // Same window as every other GA4 view: full days ending yesterday, property time zone.
      base.dateRanges = [(await ga4Window(token, property, days)).current];
      // GA4 allows 5 reports per batch, so the landing-page breakdowns go in a second batch.
      const [main, pages] = await Promise.all([
        batchReports(token, property, [
          q(['country', 'city']),
          q(['sessionSource', 'sessionMedium']),
          q(['browser', 'operatingSystem', 'screenResolution']),
          q(['language']),
          q(['dateHour'], HOUR_LIMIT),
        ]),
        batchReports(token, property, [
          q(['country', 'city', 'landingPage']),
          q(['dateHour', 'landingPage'], HOUR_PAGE_LIMIT),
        ]),
      ]);
      return [...main, ...pages];
    });

    const locations: Row[] = reports[0] ?? [];
    const sources: Row[] = reports[1] ?? [];
    const tech: Row[] = reports[2] ?? [];
    const languages: Row[] = reports[3] ?? [];
    const hours: Row[] = reports[4] ?? [];
    const locPages: Row[] = reports[5] ?? [];
    const hourPages: Row[] = reports[6] ?? [];

    const totalSessions = locations.reduce((s, r) => s + (r.sessions || 0), 0);
    const minSessions = Math.max(10, Math.round(totalSessions * 0.002));

    const locAll = locations.map(r => assess(r, 'location', locLabel(r), minSessions));
    const locFlags = flagged(locAll);
    const srcFlags = flagged(sources.map(r => assess(r, 'source', `${r.sessionSource} / ${r.sessionMedium}`, minSessions)));
    const techFlags = flagged(tech.map(r => assess(r, 'tech', `${r.browser} · ${r.operatingSystem} · ${r.screenResolution}`, minSessions)));
    const langFlags = flagged(languages.map(r => assess(r, 'language', r.language || '(not set)', minSessions)));

    // Hourly spikes: hours far above the typical hour, with little engagement
    const counts = hours.map(h => h.sessions || 0).sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const spikeFloor = Math.max(30, median * 8);
    const spikeRows = hours
      .filter(h => h.sessions >= spikeFloor)
      .map(h => {
        const engRate = h.sessions ? h.engagedSessions / h.sessions : 0;
        const avgEng = h.sessions ? h.userEngagementDuration / h.sessions : 0;
        const suspect = avgEng < SUSPECT_BOT_SECONDS;
        const reasons = [`${Math.round(h.sessions / Math.max(1, median))}× a normal hour`];
        if (suspect) reasons.unshift(`${avgEng.toFixed(2)}s average engagement per session (under ${SUSPECT_BOT_SECONDS}s)`);
        if (engRate < 0.25) reasons.push(`only ${Math.round(engRate * 100)}% engaged`);
        const level: Level = suspect ? 'Suspect bot' : engRate < 0.25 ? 'High' : 'Medium';
        return {
          raw: String(h.dateHour),
          row: { label: hourLabel(h.dateHour), sessions: h.sessions, engRate, avgEng, score: engRate < 0.25 ? 3 : 2, suspect, level, reasons },
        };
      })
      .sort((a, b) => RANK[a.row.level] - RANK[b.row.level] || b.row.sessions - a.row.sessions)
      .slice(0, 30);
    const spikes = spikeRows.map(s => s.row);

    // Locations split all sessions without overlap, so these sums don't double count.
    const suspectLoc = new Set(locAll.filter(r => r.suspect).map(r => r.label));
    const likelyLoc = new Set(locAll.filter(r => isFlagged(r) && (r.level === 'Suspect bot' || r.level === 'High')).map(r => r.label));
    const spikeHours = new Set(spikeRows.map(s => s.raw));
    const suspectBotSessions = locAll.filter(r => suspectLoc.has(r.label)).reduce((s, r) => s + r.sessions, 0);
    const suspiciousSessions = locAll.filter(r => likelyLoc.has(r.label)).reduce((s, r) => s + r.sessions, 0);

    // Landing pages behind each box
    const pages = {
      all: pageList(locPages, () => true, locLabel),
      suspect: pageList(locPages, r => suspectLoc.has(locLabel(r)), locLabel),
      likely: pageList(locPages, r => likelyLoc.has(locLabel(r)), locLabel),
      spikes: pageList(hourPages, r => spikeHours.has(String(r.dateHour)), r => hourLabel(r.dateHour)),
    };

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
      pages,
      pagesCapped: locPages.length >= ROW_LIMIT || hourPages.length >= HOUR_PAGE_LIMIT,
    });
  } catch (e: any) {
    const status = e instanceof AuthError ? 401 : 500;
    return NextResponse.json({ error: e?.message ?? String(e) }, { status });
  }
}
