// lib/weeklyExcel.ts
"use client";
// Excel download of the Weekly report: one workbook with a Summary sheet and one sheet per property. Built in the
// browser from the report already on screen, so it makes no extra Google calls. exceljs is loaded only when the button
// is clicked, so the dashboard doesn't get heavier.
import type { Cell, Workbook, Worksheet } from "exceljs";
import type { PropertyWeek, SourceGroup, Split, Mover, Status, WeekInfo, WeeklySite } from "./weekly";

type Result = { loading?: boolean; data?: PropertyWeek; error?: string };
type Num = { n: number | null; f: string };
type Val = string | number | null | undefined | { status: Status } | Num;

const STATUS_STYLE: Record<Status, { label: string; bg: string; fg: string; tab: string }> = {
  good: { label: "Good", bg: "FFE6F4EA", fg: "FF137333", tab: "FF34A853" },
  watch: { label: "Watch", bg: "FFFEF7E0", fg: "FFB06000", tab: "FFFBBC04" },
  problem: { label: "Problem", bg: "FFFCE8E6", fg: "FFC5221F", tab: "FFEA4335" },
  none: { label: "No data", bg: "FFF1F3F4", fg: "FF5F6368", tab: "FFBDC1C6" },
  pending: { label: "Coming next", bg: "FFF1F3F4", fg: "FF5F6368", tab: "FFBDC1C6" },
};
const F = {
  int: "#,##0",
  dec: "0.0",
  pct: "0.0%",
  pct2: "0.00%",
  chg: "+0%;-0%;0%",
  diff: "+#,##0;-#,##0;0",
  pts: "+0.00%;-0.00%;0.00%",
  places: "+0.0;-0.0;0.0",
};
const DARK = "FF1A3A6B";
const LIGHT = "FFE8EEF7";
const RULE = "FFE1E6EB";
const MUTED = "FF5F6368";
const DAY_NOTE = { final: "Final", provisional: "Provisional", partial: "Still running", future: "Not yet" } as const;
const RANK: Record<Status, number> = { pending: -1, none: -1, good: 0, watch: 1, problem: 2 };

const solid = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
const N = (n: number | null | undefined, f: string): Num => ({ n: n == null || !Number.isFinite(n) ? null : n, f });
const st = (s?: Status): Val => (s ? { status: s } : "");
const isStatus = (v: Val): v is { status: Status } => !!v && typeof v === "object" && "status" in v;
const isNum = (v: Val): v is Num => !!v && typeof v === "object" && "f" in v;
/** Change as a fraction (0.12 = +12%), "new" when there was nothing before, empty when both are zero. */
const change = (now: number, base: number): Val => (base ? N((now - base) / base, F.chg) : now ? "new" : "");
const placesBetter = (now: number, base: number): Val => (now && base ? N(base - now, F.places) : "");
const rate = (part: number, whole: number) => (whole ? part / whole : null);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const dayName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const worst = (areas: { status: Status }[]): Status | undefined => {
  const list = areas.filter((a) => a.status !== "pending" && a.status !== "none");
  return list.length ? list.reduce<Status>((w, a) => (RANK[a.status] > RANK[w] ? a.status : w), "good") : undefined;
};
const areaStatus = (d: PropertyWeek | undefined, id: string) => d?.areas.find((a) => a.id === id)?.status;

function put(c: Cell, v: Val, fmt?: string) {
  if (isStatus(v)) {
    const s = STATUS_STYLE[v.status];
    c.value = s.label;
    c.fill = solid(s.bg);
    c.font = { bold: true, color: { argb: s.fg } };
  } else if (isNum(v)) {
    c.value = v.n;
    c.numFmt = v.f;
  } else if (typeof v === "number") {
    c.value = Number.isFinite(v) ? v : null;
    c.numFmt = fmt || F.int;
  } else if (typeof v === "string" && /^https?:\/\//i.test(v)) {
    c.value = { text: v, hyperlink: v };
    c.font = { color: { argb: "FF1A73E8" }, underline: true };
  } else {
    c.value = v ?? "";
  }
}

/** Writes a sheet top to bottom: titles, label/value lines, coloured section bars and tables. */
function writer(ws: Worksheet, width: number) {
  let row = 1;
  const w = {
    title(text: string) {
      const r = ws.getRow(row++);
      r.getCell(1).value = text;
      r.getCell(1).font = { bold: true, size: 15, color: { argb: DARK } };
      r.height = 24;
    },
    note(text: string) {
      const c = ws.getRow(row++).getCell(1);
      c.value = text;
      c.font = { italic: true, color: { argb: MUTED } };
    },
    line(text: string) {
      ws.getRow(row++).getCell(1).value = text;
    },
    kv(label: string, value: Val, fmt?: string) {
      const r = ws.getRow(row++);
      r.getCell(1).value = label;
      r.getCell(1).font = { bold: true };
      put(r.getCell(2), value, fmt);
    },
    section(text: string) {
      row++;
      const r = ws.getRow(row++);
      for (let i = 1; i <= width; i++) r.getCell(i).fill = solid(DARK);
      r.getCell(1).value = text;
      r.getCell(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
      r.height = 20;
    },
    /** Returns the header row number. */
    table(headers: string[], rows: Val[][], fmts: (string | undefined)[] = [], empty = "None this week."): number {
      const headerRow = row;
      const h = ws.getRow(row++);
      headers.forEach((t, i) => {
        const c = h.getCell(i + 1);
        c.value = t;
        c.font = { bold: true };
        c.fill = solid(LIGHT);
        c.alignment = { wrapText: true, vertical: "middle" };
        c.border = { bottom: { style: "thin", color: { argb: "FFB9C3CF" } } };
      });
      if (!rows.length) {
        w.note(empty);
        return headerRow;
      }
      for (const vals of rows) {
        const r = ws.getRow(row++);
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1);
          put(c, v, fmts[i]);
          c.border = { bottom: { style: "hair", color: { argb: RULE } } };
          c.alignment = { vertical: "top" };
        });
      }
      return headerRow;
    },
  };
  return w;
}

/** Excel sheet names: up to 31 characters, none of []:*?/\, and unique within the workbook. */
function sheetName(raw: string, used: Set<string>) {
  const base = raw.replace(/[\[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

const comparedText = (wk: WeekInfo) =>
  wk.partial
    ? `Monday to ${dayName(addDays(wk.start, wk.compareDays - 1))} (Sunday is still running in Pacific time), compared with the same days of last week and of the 4 weeks before`
    : "The full week, compared with last week and with the average of the 4 weeks before";

/* ---------------- Summary sheet ---------------- */

function addSummary(wb: Workbook, wk: WeekInfo, sites: WeeklySite[], results: Record<string, Result>, rules: string[]) {
  const ws = wb.addWorksheet("Summary", { properties: { tabColor: { argb: DARK } } });
  const headers = [
    "Property", "Overall", "Search", "Indexing", "404s", "Crawling", "Sitemaps", "Traffic", "Traffic quality", "AI visits",
    "Clicks", "Clicks vs last week", "Clicks vs 4-week avg", "Impressions", "Impressions vs last week",
    "Avg position", "Position: places better", "Sessions", "Sessions vs last week",
    "Engaged sessions (compared days)", "Engaged vs last week", "Engaged vs 4-week avg",
    "AI visits (compared days)", "AI visits vs last week", "Key events", "Key events vs last week",
    "Search Console property", "GA4 property",
  ];
  ws.columns = headers.map((_, i) => ({ width: i === 0 ? 24 : i >= headers.length - 2 ? 40 : 14 }));
  const w = writer(ws, headers.length);
  w.title("Weekly report · Data Demand properties");
  w.kv("Week", `${wk.start} to ${wk.end} (Monday to Sunday, Pacific time)`);
  w.kv("Compared", comparedText(wk));
  w.kv("Generated", new Date().toLocaleString("en-GB"));
  w.section("Portfolio");
  const rows: Val[][] = sites.map((s) => {
    const r = results[s.siteUrl];
    const d = r?.data;
    const g = d?.gsc;
    const a = d?.ga;
    if (!d) return [s.host, r?.error ? `Couldn't load: ${r.error}` : "Not loaded"];
    return [
      s.host,
      st(worst(d.areas)),
      st(areaStatus(d, "search")),
      st(areaStatus(d, "indexing")),
      st(areaStatus(d, "errors")),
      st(areaStatus(d, "crawl")),
      st(areaStatus(d, "sitemaps")),
      st(areaStatus(d, "traffic")),
      st(areaStatus(d, "quality")),
      st(areaStatus(d, "ai")),
      g ? g.week.clicks : "",
      g ? change(g.cmp.clicks, g.prev.clicks) : "",
      g ? change(g.cmp.clicks, g.avg4.clicks) : "",
      g ? g.week.impressions : "",
      g ? change(g.cmp.impressions, g.prev.impressions) : "",
      g ? N(g.week.position, F.dec) : "",
      g ? placesBetter(g.cmp.position, g.prev.position) : "",
      a ? a.week.sessions : "",
      a ? change(a.cmp.sessions, a.prev.sessions) : "",
      a ? a.cmp.engaged : "",
      a ? change(a.cmp.engaged, a.prev.engaged) : "",
      a ? change(a.cmp.engaged, a.avg4.engaged) : "",
      a ? a.ai.sessions : "",
      a ? change(a.ai.sessions, a.ai.prevSessions) : "",
      a ? a.week.keyEvents : "",
      a ? change(a.cmp.keyEvents, a.prev.keyEvents) : "",
      s.siteUrl,
      d.ga4Name || s.ga4Name || "None paired",
    ];
  });
  const headerRow = w.table(headers, rows);
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];
  w.note("Clicks, impressions, sessions and key events are whole-week totals; engaged sessions and AI visits cover the compared days. Changes compare the same days of each week.");
  w.section("How the statuses are decided");
  rules.forEach((x) => w.line(x));
}

/* ---------------- One sheet per property ---------------- */

function addProperty(wb: Workbook, name: string, site: WeeklySite, r: Result | undefined, wk: WeekInfo) {
  const d = r?.data;
  const overall = d ? worst(d.areas) : undefined;
  const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: overall ? STATUS_STYLE[overall].tab : STATUS_STYLE.pending.tab } } });
  ws.columns = [{ width: 64 }, ...Array.from({ length: 8 }, () => ({ width: 17 }))];
  const w = writer(ws, 9);

  w.title(site.host);
  w.kv("Search Console property", site.siteUrl);
  w.kv("GA4 property", d?.ga4Name || site.ga4Name || "None paired");
  w.kv("Week", `${(d?.week || wk).start} to ${(d?.week || wk).end} (Monday to Sunday, Pacific time)`);
  if (!d) {
    w.note(r?.error ? `Couldn't load this property: ${r.error}` : "This property wasn't loaded.");
    return;
  }
  const g = d.gsc;
  const a = d.ga;
  const k = d.week;
  w.kv("Compared", comparedText(k));
  if (g) w.kv("Search Console final through", g.finalThrough);
  if (a) w.kv("GA4 time zone", a.timeZone);
  w.kv("Generated", new Date().toLocaleString("en-GB"));

  w.section("Status by area");
  w.table(["Area", "Status", "Note"], d.areas.map((x) => [x.label, st(x.status), x.note]));

  w.section("Summary");
  d.summary.forEach((s) => w.line(`• ${s}`));
  if (d.gscError) w.line(`Search Console couldn't be read: ${d.gscError}`);
  if (d.gaError) w.line(`GA4: ${d.gaError}`);
  if (d.healthError) w.line(`Saved captures couldn't be read: ${d.healthError}`);

  /* ---- Search performance ---- */
  if (g) {
    w.section("Search performance (Search Console)");
    w.table(
      ["Metric", "Whole week", "Compared days", "Same days last week", "Change", "4-week average", "Change vs 4-week average"],
      [
        ["Clicks", g.week.clicks, g.cmp.clicks, g.prev.clicks, change(g.cmp.clicks, g.prev.clicks), N(g.avg4.clicks, F.int), change(g.cmp.clicks, g.avg4.clicks)],
        ["Impressions", g.week.impressions, g.cmp.impressions, g.prev.impressions, change(g.cmp.impressions, g.prev.impressions), N(g.avg4.impressions, F.int), change(g.cmp.impressions, g.avg4.impressions)],
        ["CTR (change in percentage points)", N(g.week.ctr, F.pct2), N(g.cmp.ctr, F.pct2), N(g.prev.ctr, F.pct2), N(g.cmp.ctr - g.prev.ctr, F.pts), N(g.avg4.ctr, F.pct2), N(g.cmp.ctr - g.avg4.ctr, F.pts)],
        ["Average position (change = places better)", N(g.week.position, F.dec), N(g.cmp.position, F.dec), N(g.prev.position, F.dec), placesBetter(g.cmp.position, g.prev.position), N(g.avg4.position, F.dec), placesBetter(g.cmp.position, g.avg4.position)],
        ["Pages with clicks", "", g.pages.withClicks, g.pages.prevWithClicks, change(g.pages.withClicks, g.pages.prevWithClicks), "", ""],
        ["Queries with clicks", "", g.queries.withClicks, g.queries.prevWithClicks, change(g.queries.withClicks, g.queries.prevWithClicks), "", ""],
      ]
    );
  }

  /* ---- Day by day ---- */
  if (g || a) {
    w.section("Day by day");
    const gaDays = new Map((a?.days || []).map((x) => [x.date, x]));
    const dates = g ? g.days.map((x) => x.date) : (a?.days || []).map((x) => x.date);
    const gDays = new Map((g?.days || []).map((x) => [x.date, x]));
    w.table(
      ["Date", "Day", "Clicks", "Impressions", "CTR", "Position", "Search Console data", "GA4 sessions", "GA4 data"],
      dates.map((date) => {
        const x = gDays.get(date);
        const y = gaDays.get(date);
        return [
          date,
          dayName(date),
          x ? x.clicks : "",
          x ? x.impressions : "",
          x ? N(x.ctr, F.pct2) : "",
          x && x.position ? N(x.position, F.dec) : "",
          x ? DAY_NOTE[x.state] : "",
          y ? y.sessions : "",
          y ? DAY_NOTE[y.state] : "",
        ];
      })
    );
    w.note("Provisional: Google can still adjust the day. Still running: the day isn't over in that time zone yet.");
  }

  /* ---- Pages and queries ---- */
  if (g) {
    const moverRows = (list: Mover[]): Val[][] =>
      list.map((m) => [m.key, m.clicks, m.prevClicks, N(m.change, F.diff), N(m.position, F.dec), N(m.prevPosition, F.dec)]);
    const moverHead = (label: string) => [label, "Clicks", "Clicks last week", "Change", "Position", "Position last week"];
    w.section("Pages gaining clicks");
    w.table(moverHead("Page"), moverRows(g.pages.gainers), [], "No page gained clicks.");
    w.section("Pages losing clicks");
    w.table(moverHead("Page"), moverRows(g.pages.losers), [], "No page lost clicks.");
    w.section("Queries gaining clicks");
    w.table(moverHead("Query"), moverRows(g.queries.gainers), [], "No query gained clicks.");
    w.section("Queries losing clicks");
    w.table(moverHead("Query"), moverRows(g.queries.losers), [], "No query lost clicks.");

    w.section(`New queries this week (${g.queries.newCount.toLocaleString("en-US")} in total, top ${g.queries.newTop.length} shown)`);
    w.table(
      ["Query", "Impressions", "Clicks", "Position"],
      g.queries.newTop.map((q) => [q.query, q.impressions, q.clicks, N(q.position, F.dec)]),
      [],
      "No new queries."
    );

    const b = g.queries.branded;
    w.section("Branded search");
    w.kv(`Clicks on queries containing “${b.term}”`, b.clicks);
    w.kv("Last week", b.prevClicks);
    w.kv("Change", change(b.clicks, b.prevClicks));
    w.kv("Share of clicks from named queries", N(b.share, F.pct));
    w.kv("Share last week", N(b.prevShare, F.pct));

    const splitRows = (list: Split[], upper = false): Val[][] =>
      list.map((x) => [upper ? x.name.toUpperCase() : x.name, x.clicks, x.prevClicks, change(x.clicks, x.prevClicks), x.impressions]);
    w.section("Devices");
    w.table(["Device", "Clicks", "Clicks last week", "Change", "Impressions"], splitRows(g.devices));
    w.section("Top countries");
    w.table(["Country", "Clicks", "Clicks last week", "Change", "Impressions"], splitRows(g.countries, true));

    w.section("Sitemaps");
    if (g.sitemaps) {
      w.table(
        ["Sitemap", "Submitted URLs", "Errors", "Warnings", "Last read by Google", "Pending", "Sitemap index", "Status"],
        g.sitemaps.map((m) => {
          const stale = !m.lastDownloaded || daysBetween(m.lastDownloaded.slice(0, 10), k.today) > 14;
          const status: Status = m.errors ? "problem" : m.warnings || m.isPending || stale ? "watch" : "good";
          return [m.path, m.submitted, m.errors, m.warnings, m.lastDownloaded ? m.lastDownloaded.slice(0, 10) : "never", m.isPending ? "yes" : "", m.isIndex ? "yes" : "", st(status)];
        }),
        [],
        "No sitemap is submitted for this property."
      );
    } else {
      w.note("Couldn't read the sitemaps.");
    }
  }

  /* ---- Indexing, 404s and crawling (saved captures and daily index checks) ---- */
  const h = d.health;
  w.section("Indexing (Google's Page indexing report and the daily index checks)");
  if (!h) {
    w.note(d.healthError ? `Couldn't read the saved captures: ${d.healthError}` : "No saved captures.");
  } else {
    const c = h.index.capture;
    if (c) {
      w.kv("Google's Page indexing report", c.view);
      w.kv(`Indexed on ${c.date}`, c.indexed);
      w.kv(`Not indexed on ${c.date}`, c.notIndexed);
      if (c.baseDate && c.baseIndexed != null) {
        w.kv(`Indexed on ${c.baseDate}`, c.baseIndexed);
        w.kv("Change in indexed pages", change(c.indexed, c.baseIndexed));
      }
    } else {
      w.note(h.problems.idx ? `Couldn't read the Page indexing captures: ${h.problems.idx}` : "No Page indexing capture for this week.");
    }
    const ck = h.index.checks;
    if (ck) {
      w.kv("Daily index checks", ck.enabled ? "Running" : "Paused");
      w.kv("Dropped from Google's index this week", ck.dropped);
      w.kv("Newly indexed this week", ck.newlyIndexed);
      w.kv("Stopped getting impressions this week", ck.impressionsStopped);
      w.kv("Back in search this week", ck.backInSearch);
      w.section("Index changes found by the daily checks");
      w.table(
        ["Page", "Found on", "Change", "Before", "After"],
        ck.changes.map((x) => [x.url, x.date, x.change, x.before, x.after]),
        [],
        "No page was dropped from or newly added to the index this week."
      );
    } else {
      w.note(h.problems.checks ? `Couldn't read the daily index checks: ${h.problems.checks}` : "Daily index checks aren't running for this property.");
    }

    w.section("404s and errors");
    const rs = h.errors.reasons;
    if (rs) {
      w.kv("Google's report, as of", rs.asOf);
      w.kv("Not found (404)", rs.notFound);
      w.kv("Soft 404", rs.soft404);
      w.kv("Server error (5xx)", rs.server);
      if (rs.prevAsOf) {
        w.kv("Previous capture", rs.prevAsOf);
        w.kv("404 + soft 404: change", change(rs.notFound + rs.soft404, (rs.prevNotFound || 0) + (rs.prevSoft404 || 0)));
        w.kv("Server errors at the previous capture", rs.prevServer ?? "");
      }
      w.section("Why pages aren't indexed (Google's report)");
      w.table(
        ["Reason", "Pages", "Previous capture", "Change"],
        rs.list.map((x) => [x.reason, x.pages, x.prevPages ?? "", x.prevPages == null ? "" : change(x.pages, x.prevPages)])
      );
    } else {
      w.note("No “Why pages aren't indexed” capture for this week.");
    }
    const l = h.errors.links;
    if (l) {
      w.section(`404 URLs found by the daily checks (${l.total.toLocaleString("en-US")} in total${l.rows.length < l.total ? `, ${l.rows.length} shown` : ""})`);
      w.kv("Still listed in a sitemap", l.inSitemap);
      w.kv("Got search impressions this week", l.withImpressions);
      w.table(
        ["URL", "Google's state", "Still in a sitemap", "Impressions this week", "Linked from", "Last checked"],
        l.rows.map((x) => [x.url, x.state, x.inSitemap ? "yes" : "", x.impressions, x.linkedFrom, x.checked]),
        [],
        "No URL returns 404."
      );
    }

    w.section("Crawling (Crawl stats captures)");
    const cr = h.crawl;
    if (cr) {
      w.kv("Days of this week captured", cr.covered);
      w.kv("Latest day saved", cr.latestSaved);
      w.table(
        ["Date", "Day", "Crawl requests", "Same day last week", "Change", "Response time (ms)", "Last week (ms)"],
        cr.days.map((x) => [
          x.date,
          dayName(x.date),
          x.requests ?? "not captured",
          x.prevRequests ?? "",
          x.requests != null && x.prevRequests != null ? change(x.requests, x.prevRequests) : "",
          x.ms != null ? N(x.ms, F.int) : "",
          x.prevMs != null ? N(x.prevMs, F.int) : "",
        ])
      );
    } else {
      w.note(h.problems.crawl ? `Couldn't read the Crawl stats captures: ${h.problems.crawl}` : "No Crawl stats capture for this property.");
    }
  }

  /* ---- GA4 ---- */
  if (a) {
    w.section("Traffic outcome (GA4)");
    const er = (t: { engaged: number; sessions: number }) => rate(t.engaged, t.sessions);
    const erNow = er(a.cmp);
    const erPrev = er(a.prev);
    w.table(
      ["Metric", "Whole week", "Compared days", "Same days last week", "Change", "4-week average", "Change vs 4-week average"],
      [
        ["Sessions", a.week.sessions, a.cmp.sessions, a.prev.sessions, change(a.cmp.sessions, a.prev.sessions), N(a.avg4.sessions, F.int), change(a.cmp.sessions, a.avg4.sessions)],
        ["Users", "", a.cmp.users, a.prev.users, change(a.cmp.users, a.prev.users), "", ""],
        ["New users", "", a.cmp.newUsers, a.prev.newUsers, change(a.cmp.newUsers, a.prev.newUsers), "", ""],
        ["Engaged sessions", "", a.cmp.engaged, a.prev.engaged, change(a.cmp.engaged, a.prev.engaged), N(a.avg4.engaged, F.int), change(a.cmp.engaged, a.avg4.engaged)],
        [
          "Engagement rate (change in percentage points)", "", N(erNow, F.pct), N(erPrev, F.pct),
          erNow != null && erPrev != null ? N(erNow - erPrev, F.pts) : "", "", "",
        ],
        ["Key events", a.week.keyEvents, a.cmp.keyEvents, a.prev.keyEvents, change(a.cmp.keyEvents, a.prev.keyEvents), N(a.avg4.keyEvents, F.int), change(a.cmp.keyEvents, a.avg4.keyEvents)],
        ["Page views", a.week.views, a.cmp.views, a.prev.views, change(a.cmp.views, a.prev.views), "", ""],
      ]
    );

    w.section("Channels (compared days)");
    w.table(
      ["Channel", "Sessions", "Sessions last week", "Change", "Engaged sessions", "Engagement rate", "Key events"],
      a.channels.map((c) => [c.name, c.sessions, c.prevSessions, change(c.sessions, c.prevSessions), c.engaged, N(rate(c.engaged, c.sessions), F.pct), c.keyEvents])
    );

    w.section("Top landing pages (compared days)");
    w.table(
      ["Landing page", "Sessions", "Sessions last week", "Change"],
      a.landing.map((l) => [l.page, l.sessions, l.prevSessions ?? "", l.prevSessions == null ? "" : change(l.sessions, l.prevSessions)])
    );

    const groupRows = (list: SourceGroup[]): Val[][] =>
      list.map((x) => [x.name, x.sessions, x.prevSessions, change(x.sessions, x.prevSessions), N(rate(x.engaged, x.sessions), F.pct), x.keyEvents]);
    const groupHead = (label: string) => [label, "Sessions", "Sessions last week", "Change", "Engagement rate", "Key events"];

    w.section("AI assistants (compared days)");
    w.kv("Visits from AI assistants", a.ai.sessions);
    w.kv("Last week", a.ai.prevSessions);
    w.kv("Change", change(a.ai.sessions, a.ai.prevSessions));
    w.kv("Engagement rate", N(rate(a.ai.engaged, a.ai.sessions), F.pct));
    w.kv("Key events from AI visits", a.ai.keyEvents);
    w.kv("AI share of sessions", N(rate(a.ai.sessions, a.cmp.sessions), F.pct2));
    w.table(groupHead("AI assistant"), groupRows(a.ai.tools), [], "No visits from AI assistants this week.");

    w.section("Pages AI assistants sent visitors to");
    w.table(["Landing page", "Sessions", "Key events"], a.ai.landing.map((l) => [l.page, l.sessions, l.keyEvents]), [], "No visits from AI assistants this week.");

    w.section("Social networks (compared days)");
    w.kv("Visits from social media", a.social.sessions);
    w.kv("Last week", a.social.prevSessions);
    w.kv("Change", change(a.social.sessions, a.social.prevSessions));
    w.table(groupHead("Network"), groupRows(a.socialNetworks), [], "No visits from social media this week.");

    w.section("Top referring sites (compared days)");
    w.table(groupHead("Site"), groupRows(a.referrals), [], "No referral visits this week.");

    w.section("Traffic quality (compared days)");
    const q = d.areas.find((x) => x.id === "quality");
    if (q) {
      w.kv("Status", st(q.status));
      w.kv("Note", q.note);
    }
    w.kv("Sessions vs last week", change(a.cmp.sessions, a.prev.sessions));
    w.kv("Engaged sessions vs last week", change(a.cmp.engaged, a.prev.engaged));
    w.kv("Visits from spam-looking referrers", a.spamReferrals.sessions);
    w.kv("Last week", a.spamReferrals.prevSessions);
    w.table(groupHead("Spam-looking referrer"), groupRows(a.spamReferrals.sites), [], "No visits from spam-looking referrers this week.");
  }
}

/* ---------------- Download ---------------- */

export async function downloadWeeklyExcel(o: { week: WeekInfo; sites: WeeklySite[]; results: Record<string, Result>; rules: string[] }) {
  const mod: any = await import("exceljs");
  const ExcelJS = mod.default ?? mod;
  const wb: Workbook = new ExcelJS.Workbook();
  wb.creator = "Search & traffic dashboard";
  wb.created = new Date();

  addSummary(wb, o.week, o.sites, o.results, o.rules);
  const used = new Set<string>(["summary"]);
  for (const s of o.sites) addProperty(wb, sheetName(s.host, used), s, o.results[s.siteUrl], o.week);

  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `weekly-report-${o.week.start}-to-${o.week.end}${o.week.partial ? "-partial" : ""}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
