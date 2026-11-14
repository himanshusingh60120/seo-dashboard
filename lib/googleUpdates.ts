// lib/googleUpdates.ts
// Google's confirmed ranking updates (core, spam and similar), for marking charts. Read from Google's own Search Status
// Dashboard JSON feed (https://status.search.google.com/incidents.json), which lists about the last year. Every update
// seen is also kept in the control Sheet's hidden _GoogleUpdates tab, so older ones stay available after they leave the
// feed; a few from before the feed are built in. The feed is read at most every 6 hours. Server-only.
import { controlBook, ensureTab, readRange, writeRange } from "./sheets";

export type GoogleUpdate = {
  id: string;
  name: string;
  kind: "core" | "spam" | "other";
  /** First day, in Google's time zone (US Pacific), YYYY-MM-DD. */
  start: string;
  /** Last day, or "" while it's still rolling out. */
  end: string;
  url: string;
};

const FEED = "https://status.search.google.com/incidents.json";
const BASE = "https://status.search.google.com/";
const TAB = "_GoogleUpdates";
const HEADERS = ["Id", "Name", "Kind", "Start (Pacific)", "End (Pacific)", "Link", "Saved at"];
const CACHE_MS = 6 * 3_600_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** From before the feed's year (dates from Google's Search Status Dashboard). */
const BUILT_IN: GoogleUpdate[] = [
  { id: "builtin-2025-03-core", name: "March 2025 core update", kind: "core", start: "2025-03-13", end: "2025-03-27", url: `${BASE}summary` },
  { id: "builtin-2025-06-core", name: "June 2025 core update", kind: "core", start: "2025-06-30", end: "2025-07-17", url: `${BASE}summary` },
  { id: "builtin-2025-08-spam", name: "August 2025 spam update", kind: "spam", start: "2025-08-26", end: "2025-09-22", url: `${BASE}summary` },
];

const pacificDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso));
const kindOf = (name: string): GoogleUpdate["kind"] => (/core/i.test(name) ? "core" : /spam/i.test(name) ? "spam" : "other");
const keyOf = (u: GoogleUpdate) => u.name.trim().toLowerCase();

/** Ranking updates from Google's feed (Discover-only updates are left out: they don't affect web search). */
async function fromFeed(): Promise<GoogleUpdate[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch(FEED, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`Google's update feed answered ${r.status}`);
    const list: unknown = await r.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((x: any) => x && x.service_name === "Ranking" && typeof x.begin === "string" && !/discover/i.test(String(x.external_desc || "")))
      .map((x: any) => {
        const name = String(x.external_desc || "Google ranking update").slice(0, 120);
        return {
          id: String(x.id),
          name,
          kind: kindOf(name),
          start: pacificDay(x.begin),
          end: typeof x.end === "string" && x.end ? pacificDay(x.end) : "",
          url: BASE + String(x.uri || "summary"),
        };
      });
  } finally {
    clearTimeout(timer);
  }
}

async function fromSheet(): Promise<GoogleUpdate[]> {
  const book = controlBook();
  await ensureTab(book, TAB, HEADERS);
  const rows = await readRange(book, TAB, "A2:F");
  return rows
    .filter((r) => r[0] && DATE.test(String(r[3])))
    .map((r) => {
      const kind = String(r[2]);
      return {
        id: String(r[0]),
        name: String(r[1] || ""),
        kind: (kind === "core" || kind === "spam" ? kind : "other") as GoogleUpdate["kind"],
        start: String(r[3]),
        end: DATE.test(String(r[4])) ? String(r[4]) : "",
        url: String(r[5] || `${BASE}summary`),
      };
    });
}

async function saveAll(list: GoogleUpdate[]) {
  const now = new Date().toISOString();
  await writeRange(controlBook(), TAB, `A2:G${list.length + 1}`, list.map((u) => [u.id, u.name, u.kind, u.start, u.end, u.url, now]));
}

let memo: { at: number; list: GoogleUpdate[] } | null = null;
let running: Promise<GoogleUpdate[]> | null = null;

/** Every known update, oldest first. */
export function googleUpdates(): Promise<GoogleUpdate[]> {
  if (memo && Date.now() - memo.at < CACHE_MS) return Promise.resolve(memo.list);
  if (running) return running;
  running = (async () => {
    const [feed, saved] = await Promise.all([fromFeed().catch(() => null), fromSheet().catch(() => [] as GoogleUpdate[])]);
    const by = new Map<string, GoogleUpdate>();
    for (const u of BUILT_IN) by.set(keyOf(u), u);
    for (const u of saved) by.set(keyOf(u), u);
    for (const u of feed || []) by.set(keyOf(u), u);
    const list = [...by.values()].sort((a, b) => a.start.localeCompare(b.start));
    // Save when something is new, or an update that was rolling out now has its end date.
    const savedBy = new Map(saved.map((u) => [keyOf(u), u]));
    const changed = list.length !== saved.length || list.some((u) => savedBy.get(keyOf(u))?.end !== u.end);
    if (feed && changed) await saveAll(list).catch(() => {});
    memo = { at: Date.now(), list };
    return list;
  })().finally(() => {
    running = null;
  });
  return running;
}
