// lib/indexedPages.ts
// Shared by the /api/gsc/indexed-pages route and the IndexedRanking component.
import type { Sources } from "./provenance";

/** Periods offered. 480 days ≈ the 16 months Search Console keeps. */
export const INDEXED_PAGE_DAYS = [7, 28, 90, 180, 365, 480] as const;
export const DEFAULT_INDEXED_PAGE_DAYS = 90;
export const daysLabel = (d: number) => (d === 480 ? "16 months" : `${d} days`);

export const BANDS = ["1–3", "4–10", "11–20", "21–30", "31+"] as const;
export type Band = (typeof BANDS)[number];

/** Band from the average position, rounded the way Search Console displays it. */
export function bandOf(position: number): Band {
  const p = Math.round(position);
  if (p <= 3) return "1–3";
  if (p <= 10) return "4–10";
  if (p <= 20) return "11–20";
  if (p <= 30) return "21–30";
  return "31+";
}

export type IndexedPage = {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  band: Band;
  /** Query with the most clicks for this page ("" when none was returned). */
  topQuery: string;
  topQueryClicks: number;
  /** Had impressions in the last 7 days. null when the period itself is 7 days. */
  recent: boolean | null;
};

export type IndexedPagesResponse = {
  sources: Sources;
  days: number;
  range: { startDate: string; endDate: string };
  recentRange: { startDate: string; endDate: string } | null;
  dataThrough: string;
  pages: IndexedPage[];
  /** True when the API's 50,000-page limit was reached. */
  capped: boolean;
  topQueryCovered: number;
  topQueryCapped: boolean;
};
