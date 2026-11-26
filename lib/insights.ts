// lib/insights.ts
// The Overview summary: "The W's" (what's going well), "Lowkey concerning" (what needs attention) and "Next moves"
// (suggestions only). No AI: every pointer comes from a fixed rule over numbers the dashboard has already loaded, so it
// changes with the period picked in the top bar. Noise guards keep small numbers from turning into big percentages.
// Each pointer has two wordings carrying the same numbers: Kings vibe (a light, office-safe opener) and Classic.
// Each next move says where to study it in the dashboard and carries the exact rows behind it as a CSV.
import type { GscData, Ga4Data, QueryRow } from "./types";

export type Tone = "kings" | "classic";
export type Text = Record<Tone, string>;
/** Dashboard tabs a next move can open (the tab ids in components/Dashboard.tsx). */
export type StudyTab = "overview" | "rankings" | "queries" | "audience" | "indexing" | "checks" | "cta";
export type Study = { tab: StudyTab; find: string[]; where: string };
export type Csv = { name: string; rows: Record<string, unknown>[] };
export type Pointer = { id: string; weight: number; text: Text };
export type Move = Pointer & { study?: Study; csv?: Csv };
export type Summary = { good: Pointer[]; bad: Pointer[]; moves: Move[]; notes: string[] };

/** The parts of /api/ga4/social this summary uses. */
export type SocialInput = {
  totals: {
    current: { sessions: number; engaged: number; keyEvents: number };
    previous: { sessions: number; engaged: number; keyEvents: number };
  };
  siteSessions: { current: number; previous: number };
  networks: { name: string; sessions: number; prevSessions: number; engaged: number; keyEvents: number }[];
  pages: { network: string; page: string; sessions: number; engaged: number; keyEvents: number }[];
};

type Group = { name: string; sessions: number; prevSessions: number; engaged: number; keyEvents: number };
type Totals = { sessions: number; engaged: number; keyEvents: number };
/** The parts of /api/ga4/signals this summary uses: key events, AI assistants, spam referrers. */
export type SignalsInput = {
  site: { current: Totals; previous: Totals };
  ai: {
    current: Totals;
    previous: { sessions: number };
    tools: Group[];
    pages: { page: string; sessions: number; engaged: number; keyEvents: number }[];
  };
  referrals: { current: number; previous: number };
  spam: { current: number; previous: number; sites: Group[] };
  keyEventPages: { page: string; keyEvents: number; sessions: number }[];
};

/** Google's Page indexing counts per day (All known pages), from the weekly captures. */
export type IdxDays = Record<string, { indexed: number; notIndexed: number }>;

export type InsightInput = {
  site: string;
  days: number;
  gsc: GscData;
  ga: Ga4Data | null;
  social: SocialInput | null;
  signals: SignalsInput | null;
  idxDays: IdxDays | null;
};

/* ---------------- Helpers ---------------- */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const ch = (cur: number, prev: number) => (prev ? (cur - prev) / prev : cur ? 1 : 0);
const sp = (x: number) => `${x >= 0 ? "+" : "-"}${Math.abs(Math.round(x * 100))}%`;
const rate = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const p1 = (x: number) => x.toFixed(1);
const r1 = (x: number | null | undefined) => (x == null ? "" : Math.round(x * 10) / 10);
const cap = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const path = (u: string) => u.replace(/^https?:\/\/[^/]+/, "") || "/";
const sum = <T,>(list: T[], f: (t: T) => number) => list.reduce((t, x) => t + f(x), 0);
const byWeight = <T extends { weight: number }>(list: T[]) => [...list].sort((a, b) => b.weight - a.weight);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
function hash(s: string) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Worth mentioning: big enough in percent, in absolute terms, and beyond normal day-to-day noise. */
function moved(cur: number, prev: number, minPct: number, minAbs: number) {
  const d = Math.abs(cur - prev);
  if (d < minAbs || d < 2 * Math.sqrt(Math.max(prev, cur, 1))) return false;
  return prev ? d / prev >= minPct : true;
}

/* ---------------- The rules ---------------- */

export function buildSummary(x: InsightInput): Summary {
  const { gsc, ga, social, signals, site } = x;
  const seed = `${site}|${gsc.range.startDate}|${gsc.range.endDate}`;
  const good: Pointer[] = [];
  const bad: Pointer[] = [];
  const moves: Move[] = [];
  const notes: string[] = [];

  /** Kings vibe = a short opener + the same sentence; the opener is fixed per site and period, so refreshing doesn't reshuffle it. */
  const say = (id: string, leads: string[], body: string): Text => ({
    kings: `${leads[hash(seed + id) % leads.length]}: ${body}`,
    classic: cap(body),
  });
  const plain = (t: string): Text => ({ kings: t, classic: t });
  const add = (list: Pointer[], id: string, weight: number, text: Text) => list.push({ id, weight, text });

  const host = site.replace(/^sc-domain:/, "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "").split(".")[0] || "site";
  const csvName = (what: string) => `${host}-${what}-${gsc.range.startDate}-to-${gsc.range.endDate}.csv`;

  const c = gsc.totals.current;
  const p = gsc.totals.previous;
  const comparable = !(gsc as GscData & { previousIncomplete?: boolean }).previousIncomplete;
  if (!comparable) {
    notes.push("The comparison period starts before Search Console's 16-month limit, so search changes are left out. Use Compare months for older periods.");
  }

  /* ---- Search totals ---- */
  let imprCovered = false;
  let ctrCovered = false;
  if (comparable && moved(c.clicks, p.clicks, 0.1, 20)) {
    const up = c.clicks > p.clicks;
    let body = `clicks ${up ? "rose" : "fell"} ${sp(ch(c.clicks, p.clicks))} to ${n0(c.clicks)} (from ${n0(p.clicks)})`;
    if (!up) {
      const iCh = ch(c.impressions, p.impressions);
      if (iCh <= -0.1) {
        body += `; fewer people saw the site (impressions ${sp(iCh)})`;
        imprCovered = true;
      } else if (c.ctr < p.ctr * 0.9) {
        body += `; people see the site but click less (CTR ${rate(p.ctr, 2)} → ${rate(c.ctr, 2)}${iCh > 0.02 ? `, impressions ${sp(iCh)}` : ""})`;
        imprCovered = ctrCovered = true;
      } else if (c.position - p.position >= 1) {
        body += `; the site ranks lower (average position ${p1(p.position)} → ${p1(c.position)})`;
      }
    }
    add(up ? good : bad, "clicks", Math.abs(c.clicks - p.clicks), say("clicks", up ? ["Clicks are on a roll", "Big W on clicks"] : ["Clicks took an L", "Lowkey, clicks dipped"], `${body}.`));
  }

  if (comparable && !imprCovered && moved(c.impressions, p.impressions, 0.1, 200)) {
    const up = c.impressions > p.impressions;
    const body = `impressions ${up ? "rose" : "fell"} ${sp(ch(c.impressions, p.impressions))} to ${n0(c.impressions)}, so ${up ? "more" : "fewer"} people saw the site in Google`;
    add(up ? good : bad, "impressions", Math.abs(c.impressions - p.impressions) / 20, say("impressions", up ? ["More eyes on us, no cap", "Visibility glow-up"] : ["Visibility went quiet", "Lowkey, fewer eyes on us"], `${body}.`));
  }

  if (comparable && !ctrCovered && c.impressions >= 500 && p.ctr > 0 && Math.abs(c.ctr - p.ctr) / p.ctr >= 0.15) {
    const up = c.ctr > p.ctr;
    const body = `click-through rate ${up ? "rose" : "fell"} from ${rate(p.ctr, 2)} to ${rate(c.ctr, 2)}`;
    add(up ? good : bad, "ctr", Math.abs(c.ctr - p.ctr) * c.impressions, say("ctr", up ? ["Snippets are serving", "People are clicking more"] : ["Fewer clicks per view", "Snippets look a bit mid"], `${body}.`));
  }

  if (comparable && c.impressions >= 500 && p.position > 0 && Math.abs(c.position - p.position) >= 1) {
    const better = c.position < p.position;
    const d = Math.abs(c.position - p.position);
    const body = `average position ${better ? "improved" : "slipped"} ${d.toFixed(1)} places to ${p1(c.position)}`;
    add(better ? good : bad, "position", d * 40, say("position", better ? ["Rankings had a glow-up", "Rankings understood the assignment"] : ["Rankings are lowkey slipping", "Rankings took an L"], `${body}.`));
  }

  /* ---- Your own name in search ---- */
  const brand = gsc.queries.brand || "";
  const seen = new Map<string, QueryRow>();
  for (const q of [...gsc.queries.byImpressions, ...gsc.queries.byClicks]) seen.set(q.key, q);
  const brandQs = brand.length >= 3 ? Array.from(seen.values()).filter((q) => q.key.toLowerCase().replace(/\s+/g, "").includes(brand)) : [];
  const topBrand = [...brandQs].sort((a, b) => b.impressions - a.impressions)[0];
  if (comparable && topBrand && topBrand.prevPosition != null && topBrand.impressions >= 20) {
    const was = topBrand.prevPosition;
    const now = topBrand.position;
    const brandCsv: Csv = {
      name: csvName("brand-queries"),
      rows: [...brandQs]
        .sort((a, b) => b.impressions - a.impressions)
        .map((q) => ({ query: q.key, clicks: q.clicks, impressions: q.impressions, ctr: rate(q.ctr, 2), position: r1(q.position), previous_position: r1(q.prevPosition) })),
    };
    if (was <= 3 && now - was >= 2) {
      add(bad, "brand", 400 + topBrand.impressions, say("brand", ["Our own name slipped", "Sus: the brand search dropped"], `“${topBrand.key}”, our own name, went from position ${p1(was)} to ${p1(now)} in Google.`));
      moves.push({
        id: "brand",
        weight: 400 + topBrand.impressions,
        text: plain(`Check the homepage title, recent site changes and anything that could block the homepage, given the drop for “${topBrand.key}”.`),
        study: { tab: "queries", find: ["query summary"], where: "Queries → Query summary (branded queries)" },
        csv: brandCsv,
      });
    } else if (was > 3 && now <= 3) {
      add(good, "brand", 200, say("brand", ["Brand is back, no cap", "Our name is front row again"], `“${topBrand.key}” is back in Google's top 3 (position ${p1(was)} → ${p1(now)}).`));
    }
  }

  /* ---- Rankings ---- */
  if (comparable && gsc.losers.length >= 5) {
    const top = gsc.losers[0];
    const lost = sum(gsc.losers, (r) => Math.max(0, r.prevClicks - r.clicks));
    add(bad, "losers", lost + gsc.losers.length, say("losers", ["Some pages took an L", "A few pages are lowkey slipping"],
      `${n0(gsc.losers.length)} pages dropped 5 or more places in Google (biggest: ${path(top.key)}, ${top.prevPosition != null ? p1(top.prevPosition) : "?"} → ${p1(top.position)}).`));
    moves.push({
      id: "losers",
      weight: lost + gsc.losers.length,
      text: plain("Look at the pages that dropped most: compare their titles, content and internal links with how they were before."),
      study: { tab: "rankings", find: ["lost", "dropped"], where: "Rankings → pages that lost rankings" },
      csv: {
        name: csvName("pages-dropped"),
        rows: gsc.losers.map((r) => ({
          page: r.key, clicks: r.clicks, previous_clicks: r.prevClicks, impressions: r.impressions,
          position: r1(r.position), previous_position: r1(r.prevPosition), places_dropped: r.change,
        })),
      },
    });
  }

  if (comparable && gsc.vanished.length >= 5) {
    const lost = sum(gsc.vanished, (r) => r.prevClicks);
    add(bad, "vanished", lost + gsc.vanished.length, say("vanished", ["Some pages ghosted us", "A few pages went missing"],
      `${n0(gsc.vanished.length)} pages that had impressions before don't show in Google at all now.`));
    moves.push({
      id: "vanished",
      weight: lost + gsc.vanished.length,
      text: plain("Check whether the pages that disappeared are still indexed: use “Look up a page” in the top bar, or the Index checks tab."),
      study: { tab: "rankings", find: ["no longer", "stopped"], where: "Rankings → pages no longer showing" },
      csv: {
        name: csvName("pages-no-longer-showing"),
        rows: gsc.vanished.map((r) => ({ page: r.key, previous_clicks: r.prevClicks, previous_impressions: r.prevImpressions, previous_position: r1(r.prevPosition) })),
      },
    });
  }

  const top10 = gsc.bucketPages.top10;
  const entered = comparable ? top10.filter((r) => r.prevPosition == null || r.prevPosition > 10) : [];
  if (entered.length >= 5) {
    const best = [...entered].sort((a, b) => b.clicks - a.clicks)[0];
    add(good, "top10", sum(entered, (r) => r.clicks) + entered.length, say("top10", ["Top 10 glow-up", "New faces in the top 10, no cap"],
      `${n0(entered.length)} pages are now in Google's top 10 that weren't before (most clicks: ${path(best.key)}, ${n0(best.clicks)}).`));
  }

  const slipping = comparable
    ? top10.filter((r) => r.position <= 5 && r.prevClicks >= 5 && r.clicks <= r.prevClicks * 0.7 && r.prevPosition != null && Math.abs(r.position - r.prevPosition) < 2)
    : [];
  if (slipping.length >= 3) {
    const sorted = [...slipping].sort((a, b) => b.prevClicks - b.clicks - (a.prevClicks - a.clicks));
    const ex = sorted[0];
    moves.push({
      id: "slipping",
      weight: sum(slipping, (r) => r.prevClicks - r.clicks),
      text: plain(`Refresh titles and descriptions on ${n0(slipping.length)} pages that lost clicks while still ranking 1-5 (for example ${path(ex.key)} at position ${p1(ex.position)}: ${n0(ex.prevClicks)} → ${n0(ex.clicks)} clicks).`),
      study: { tab: "rankings", find: ["1–10", "1-10", "top 10"], where: "Rankings → pages in positions 1–10" },
      csv: {
        name: csvName("pages-losing-clicks-at-top-positions"),
        rows: sorted.map((r) => ({
          page: r.key, clicks: r.clicks, previous_clicks: r.prevClicks, clicks_lost: r.prevClicks - r.clicks,
          impressions: r.impressions, ctr: rate(r.ctr, 2), position: r1(r.position), previous_position: r1(r.prevPosition),
        })),
      },
    });
  }

  /* ---- Queries ---- */
  const q = gsc.queries;
  if (comparable && q.newCount >= 50 && q.newCount > q.lostCount * 1.2) {
    add(good, "newQueries", q.newCount / 5, say("newQueries", ["Fresh demand, no cap", "New queries are pulling up"],
      `${n0(q.newCount)} new queries brought impressions (${n0(q.lostCount)} dropped out).`));
  } else if (comparable && q.lostCount >= 50 && q.lostCount > q.newCount * 1.2) {
    add(bad, "lostQueries", q.lostCount / 5, say("lostQueries", ["Some queries ghosted us", "Lowkey losing queries"],
      `${n0(q.lostCount)} queries stopped bringing impressions (${n0(q.newCount)} new ones came in).`));
  }
  if (comparable) {
    const up = q.rising.length;
    const down = q.falling.length;
    const fmt = (n: number) => (n >= 50 ? "50+" : String(n));
    if (up >= 10 && up >= down * 1.5) {
      add(good, "movers", up * 2, say("movers", ["Queries are on a roll", "More queries climbing, no cap"], `more queries climbed than fell in Google (${fmt(up)} up, ${fmt(down)} down).`));
    } else if (down >= 10 && down >= up * 1.5) {
      add(bad, "movers", down * 2, say("movers", ["Queries are lowkey sliding", "More queries slipping"], `more queries fell than climbed in Google (${fmt(down)} down, ${fmt(up)} up).`));
    }
  }

  const opp = q.opportunities;
  if (opp.length >= 5) {
    const top = opp[0];
    moves.push({
      id: "opportunities",
      weight: sum(opp, (r) => r.impressions) / 50,
      text: plain(`Strengthen the pages for ${n0(opp.length)} queries at positions 4-20 with real demand, the closest wins (biggest: “${top.key}”, ${n0(top.impressions)} impressions at position ${p1(top.position)}).`),
      study: { tab: "queries", find: ["query lists"], where: "Queries → Query lists (close to page one)" },
      csv: {
        name: csvName("queries-close-to-page-one"),
        rows: opp.map((r) => ({ query: r.key, impressions: r.impressions, clicks: r.clicks, ctr: rate(r.ctr, 2), position: r1(r.position), previous_position: r1(r.prevPosition) })),
      },
    });
  }

  /* ---- GA4: real readers vs automated visits ---- */
  const g = ga?.totals;
  if (g && g.previous.sessions > 0) {
    const s0 = g.current.sessions;
    const s1 = g.previous.sessions;
    const er0 = g.current.engagementRate;
    const er1 = g.previous.engagementRate;
    const e0 = s0 * er0;
    const e1 = s1 * er1;
    const sP = ch(s0, s1);
    const eP = ch(e0, e1);
    const surge = sP >= 0.5 && s0 - s1 >= 1000 && eP < 0.1;
    if (surge) {
      add(bad, "surge", (s0 - s1) / 10, say("surge", ["Traffic looks sus", "Sus traffic alert"],
        `sessions ${sp(sP)} but engaged sessions ${sp(eP)}, so most of the extra visits look automated.`));
      moves.push({
        id: "surge",
        weight: (s0 - s1) / 10,
        text: plain("Judge traffic on engaged sessions for now, and find where the extra visits came from in Channel drill-down: look for rows with many sessions and almost no engagement."),
        study: { tab: "audience", find: ["channel drill"], where: "Traffic & geography → Channel drill-down" },
        csv: ga && ga.landingPages.length
          ? {
              name: csvName("landing-pages-engagement"),
              rows: ga.landingPages.map((r) => ({ landing_page: r.page, sessions: r.sessions, users: r.users, engagement_rate: rate(r.engagementRate) })),
            }
          : undefined,
      });
    } else if (moved(e0, e1, 0.1, 50)) {
      const up = e0 > e1;
      add(up ? good : bad, "engaged", Math.abs(e0 - e1) / 5, say("engaged", up ? ["Real readers showed up", "Engagement is on a roll"] : ["Engagement took an L", "Lowkey, fewer real readers"],
        `engaged sessions ${up ? "rose" : "fell"} ${sp(eP)} to ${n0(e0)}.`));
    }
    if (!surge && s0 >= 200 && er1 > 0 && er0 <= er1 * (2 / 3)) {
      add(bad, "engagementRate", ((er1 - er0) * s0) / 5, say("engagementRate", ["Engagement looks a bit mid", "Engagement rate dipped"],
        `engagement rate fell from ${rate(er1)} to ${rate(er0)}.`));
    }
  }

  /* ---- Key events, AI assistants and spam referrers (GA4, /api/ga4/signals) ---- */
  if (signals) {
    const k0 = signals.site.current.keyEvents;
    const k1 = signals.site.previous.keyEvents;
    const ss0 = signals.site.current.sessions;
    const ss1 = signals.site.previous.sessions;
    const keFell = moved(k0, k1, 0.15, 5) && k0 < k1;
    if (k0 || k1) {
      if (moved(k0, k1, 0.15, 5)) {
        const up = k0 > k1;
        let body = `key events ${up ? "rose" : "fell"} ${sp(ch(k0, k1))} to ${n0(k0)}`;
        if (!up && ss1 && ss0 > ss1 * 1.1) body += `, even though sessions rose ${sp(ch(ss0, ss1))}`;
        add(up ? good : bad, "keyEvents", Math.abs(k0 - k1) * 10, say("keyEvents", up ? ["Conversions are on a roll", "Key events understood the assignment"] : ["Key events took an L", "Lowkey, fewer key events"], `${body}.`));
      } else if (k0 > 0) {
        add(good, "keyEvents", k0 * 2, say("keyEvents", ["Conversions holding steady", "Key events check-in"],
          `${n0(k0)} key events (${k1 ? `${sp(ch(k0, k1))} vs before` : "none before"}).`));
      }
    }
    if (signals.keyEventPages.length) {
      const top = signals.keyEventPages[0];
      moves.push({
        id: "keyEventPages",
        weight: k0 * 3 + 1,
        text: plain(
          keFell
            ? `Check the pages that bring key events for broken forms or changed calls to action, starting with ${path(top.page)} (${n0(top.keyEvents)} key events this period).`
            : `Send more readers to what converts: ${path(top.page)} led to the most key events (${n0(top.keyEvents)}).`
        ),
        study: { tab: "cta", find: ["cta clicks"], where: "CTAs → CTA clicks" },
        csv: {
          name: csvName("key-event-landing-pages"),
          rows: signals.keyEventPages.map((r) => ({
            landing_page: r.page, key_events: r.keyEvents, sessions: r.sessions,
            key_events_per_100_sessions: r.sessions ? Math.round((r.keyEvents / r.sessions) * 1000) / 10 : "",
          })),
        },
      });
    }

    const a0 = signals.ai.current.sessions;
    const a1 = signals.ai.previous.sessions;
    if (a0 || a1) {
      const big = moved(a0, a1, 0.15, 10);
      const rose = big && a0 > a1;
      const fell = big && a0 < a1;
      const topTool = signals.ai.tools.find((t) => t.sessions > 0);
      const body = `AI assistants sent ${n0(a0)} visits (${a1 ? `${sp(ch(a0, a1))} vs before` : "none before"})${topTool ? `, most from ${topTool.name}` : ""}.`;
      add(fell ? bad : good, "ai", big ? Math.abs(a0 - a1) * 2 + 5 : 5 + a0 / 10,
        say("ai", fell ? ["AI visits went quiet", "Lowkey, fewer AI visits"] : rose ? ["AI is sending readers, no cap", "AI assistants are serving"] : ["AI vibe check", "AI visits check-in"], body));

      const aER = a0 ? signals.ai.current.engaged / a0 : 0;
      const sER = ss0 ? signals.site.current.engaged / ss0 : 0;
      if (a0 >= 20 && sER > 0 && aER >= sER * 1.5 && aER - sER >= 0.1) {
        add(good, "aiQuality", 20, {
          kings: `AI visitors came to read: ${rate(aER)} engaged, vs ${rate(sER)} site-wide.`,
          classic: `Visitors from AI assistants engage more: ${rate(aER)} engaged, vs ${rate(sER)} site-wide.`,
        });
      }
      if (signals.ai.current.keyEvents > 0) {
        add(good, "aiKeyEvents", signals.ai.current.keyEvents * 5, say("aiKeyEvents", ["AI traffic is converting, no cap", "AI visits are pulling their weight"],
          `visits from AI assistants led to ${n0(signals.ai.current.keyEvents)} key events.`));
      }
      if (a0 >= 10 && signals.ai.pages.length) {
        const tp = signals.ai.pages[0];
        moves.push({
          id: "aiPages",
          weight: a0 / 2,
          text: plain(`Keep the pages AI assistants send people to accurate and up to date, starting with ${path(tp.page)} (${n0(tp.sessions)} visits from AI).`),
          study: { tab: "overview", find: ["pages they landed on"], where: "Overview → Visits from AI assistants → Pages they landed on" },
          csv: {
            name: csvName("ai-assistant-landing-pages"),
            rows: signals.ai.pages.map((r) => ({
              landing_page: r.page, sessions: r.sessions, engaged_sessions: r.engaged,
              engagement_rate: r.sessions ? rate(r.engaged / r.sessions) : "", key_events: r.keyEvents,
            })),
          },
        });
      }
    }

    if (signals.spam.current >= 20) {
      const names = signals.spam.sites.slice(0, 3).map((s) => s.name).join(", ");
      const share = signals.referrals.current ? `, ${rate(signals.spam.current / signals.referrals.current, 0)} of all referral visits` : "";
      add(bad, "spam", signals.spam.current / 2, say("spam", ["Not real fans", "Sus referrers spotted"],
        `${n0(signals.spam.current)} referral visits came from spam-looking sites (${names})${share}.`));
      moves.push({
        id: "spam",
        weight: signals.spam.current / 2,
        text: plain("Leave spam referrers out when you judge traffic: they add sessions without real readers, so engaged sessions are the safer measure."),
        study: { tab: "audience", find: ["channel drill"], where: "Traffic & geography → Channel drill-down (Referral)" },
        csv: {
          name: csvName("spam-referrers"),
          rows: signals.spam.sites.map((r) => ({
            referrer: r.name, sessions: r.sessions, previous_sessions: r.prevSessions, engaged_sessions: r.engaged,
            engagement_rate: r.sessions ? rate(r.engaged / r.sessions) : "",
          })),
        },
      });
    }
  }

  /* ---- Social media ---- */
  if (social) {
    const sc = social.totals.current;
    const sv = social.totals.previous;
    const share = social.siteSessions.current ? sc.sessions / social.siteSessions.current : 0;
    if (sc.sessions > 0 || sv.sessions > 0) {
      const big = moved(sc.sessions, sv.sessions, 0.15, 20);
      const rose = big && sc.sessions > sv.sessions;
      const fell = big && sc.sessions < sv.sessions;
      const body = `social media sent ${n0(sc.sessions)} visits (${sv.sessions ? `${sp(ch(sc.sessions, sv.sessions))} vs before` : "none before"}), ${rate(share)} of all sessions.`;
      add(fell ? bad : good, "social", big ? Math.abs(sc.sessions - sv.sessions) / 2 + 5 : 5,
        say("social", fell ? ["Social went quiet", "Lowkey, social dipped"] : rose ? ["Social is serving", "Socials understood the assignment"] : ["Social vibe check", "Social check-in"], body));
    }

    const nets = social.networks.filter((n) => n.sessions + n.prevSessions >= 10);
    const gain = (n: { sessions: number; prevSessions: number }) => n.sessions - n.prevSessions;
    const riser = nets.filter((n) => n.sessions > n.prevSessions && moved(n.sessions, n.prevSessions, 0.2, 10)).sort((a, b) => gain(b) - gain(a))[0];
    const faller = nets.filter((n) => n.sessions < n.prevSessions && moved(n.sessions, n.prevSessions, 0.2, 10)).sort((a, b) => gain(a) - gain(b))[0];
    if (riser) {
      add(good, `riser-${riser.name}`, gain(riser) + 5, {
        kings: `${riser.name} understood the assignment: ${n0(riser.sessions)} visits (${sp(ch(riser.sessions, riser.prevSessions))}).`,
        classic: `${riser.name} sent ${n0(riser.sessions)} visits (${sp(ch(riser.sessions, riser.prevSessions))}).`,
      });
    }
    if (faller) {
      add(bad, `faller-${faller.name}`, -gain(faller) + 5, {
        kings: `${faller.name} went quiet: ${n0(faller.sessions)} visits (${sp(ch(faller.sessions, faller.prevSessions))}).`,
        classic: `${faller.name} sent ${n0(faller.sessions)} visits (${sp(ch(faller.sessions, faller.prevSessions))}).`,
      });
    }

    const socER = sc.sessions ? sc.engaged / sc.sessions : 0;
    const siteER = ga?.totals.current.engagementRate ?? 0;
    if (sc.sessions >= 30 && siteER > 0 && socER >= siteER * 1.5 && socER - siteER >= 0.1) {
      add(good, "socialQuality", 30, {
        kings: `Social visitors are the real ones: ${rate(socER)} engaged, vs ${rate(siteER)} site-wide.`,
        classic: `Social visitors engage more: ${rate(socER)} engaged, vs ${rate(siteER)} site-wide.`,
      });
    }
    if (sc.keyEvents > 0) {
      add(good, "socialKeyEvents", sc.keyEvents * 5, say("socialKeyEvents", ["Social is converting, no cap", "Social is pulling its weight"], `social visits led to ${n0(sc.keyEvents)} key events.`));
    }

    const topPage = [...social.pages].sort((a, b) => b.sessions - a.sessions)[0];
    if (sc.sessions >= 20 && topPage) {
      moves.push({
        id: "socialPages",
        weight: sc.sessions / 4,
        text: plain(`Share more like ${path(topPage.page)}: it got the most social visits (${n0(topPage.sessions)}, from ${topPage.network}).`),
        study: { tab: "audience", find: ["landing pages ·"], where: "Traffic & geography → Social media → Landing pages" },
        csv: {
          name: csvName("social-landing-pages"),
          rows: [...social.pages]
            .sort((a, b) => b.sessions - a.sessions)
            .map((r) => ({
              network: r.network, landing_page: r.page, sessions: r.sessions, engaged_sessions: r.engaged,
              engagement_rate: r.sessions ? rate(r.engaged / r.sessions) : "", key_events: r.keyEvents,
            })),
        },
      });
    }
  }

  /* ---- Indexing (Google's Page indexing report, from the weekly captures) ---- */
  if (x.idxDays) {
    const dates = Object.keys(x.idxDays).filter((d) => DATE.test(d)).sort();
    const last = dates[dates.length - 1];
    if (last) {
      const target = addDays(last, -x.days);
      let base = "";
      for (const d of dates) {
        if (d > target) break;
        base = d;
      }
      if (!base && dates[0] < last) base = dates[0];
      if (base) {
        const a = x.idxDays[last].indexed;
        const b = x.idxDays[base].indexed;
        if (b && Math.abs(a - b) >= 20 && Math.abs(a - b) / b >= 0.03) {
          const up = a > b;
          add(up ? good : bad, "indexed", Math.abs(a - b) / 2, say("indexed", up ? ["Indexing glow-up", "Google is indexing more, no cap"] : ["Indexing took an L", "Lowkey, fewer pages indexed"],
            `Google's indexed pages ${up ? "rose" : "fell"} ${sp(ch(a, b))} to ${n0(a)} (${base} → ${last}).`));
          if (!up) {
            moves.push({
              id: "indexed",
              weight: Math.abs(a - b) / 2,
              text: plain("Find the pages that dropped out of the index in Index checks, and check Google's reasons in the Indexing tab."),
              study: { tab: "checks", find: ["status changes"], where: "Index checks → Status changes found" },
            });
          }
        }
      }
    }
  }

  return { good: byWeight(good), bad: byWeight(bad), moves: byWeight(moves), notes };
}
