export type Totals = { clicks: number; impressions: number; ctr: number; position: number };
export type PageRow = Totals & { key: string; prevPosition: number | null; prevClicks: number; bucket: string; change?: number };
export type QueryRow = Totals & { key: string; prevPosition: number | null; prevImpressions: number; change?: number };

export type GscData = {
  range: { startDate: string; endDate: string };
  previousRange: { startDate: string; endDate: string };
  totals: { current: Totals; previous: Totals };
  trend: (Totals & { date: string })[];
  pageCount: number;
  buckets: { top10: number; top20: number; top30: number; beyond: number };
  bucketPages: { top10: PageRow[]; top20: PageRow[]; top30: PageRow[] };
  losers: (PageRow & { change: number })[];
  vanished: { key: string; prevPosition: number; prevImpressions: number; prevClicks: number }[];
  queries: {
    brand: string;
    count: number;
    clicks: number;
    impressions: number;
    buckets: { top3: number; top10: number; top20: number; top30: number; beyond: number };
    lengths: { short: number; medium: number; long: number };
    branded: { queries: number; clicks: number; impressions: number };
    narrative: string[];
    byClicks: QueryRow[];
    byImpressions: QueryRow[];
    opportunities: QueryRow[];
    rising: QueryRow[];
    falling: QueryRow[];
    questions: QueryRow[];
    questionCount: number;
    newCount: number;
    newTop: QueryRow[];
    lostCount: number;
  };
};

export type Ga4Totals = {
  totalUsers: number; activeUsers: number; newUsers: number; sessions: number;
  screenPageViews: number; engagementRate: number; averageSessionDuration: number;
};

export type Ga4Data = {
  range: { startDate: string; endDate: string };
  totals: { current: Ga4Totals; previous: Ga4Totals };
  organicTotals: { sessions: number; users: number };
  trend: { date: string; users: number; sessions: number; views: number; organicSessions: number }[];
  countries: { country: string; code: string; users: number; sessions: number; engagementRate: number }[];
  cities: { city: string; country: string; users: number; sessions: number }[];
  channels: { channel: string; sessions: number; users: number }[];
  landingPages: { page: string; sessions: number; users: number; engagementRate: number }[];
  realtime: { activeUsers: number; countries: { country: string; users: number }[] } | null;
};

export type Properties = {
  gsc: { siteUrl: string; host: string; permission: string; ga4Id: string | null }[];
  ga4: { id: string; name: string; account: string; hosts: string[] }[];
};

export type Inspection = {
  url: string; verdict: string; coverageState: string; indexingState: string;
  lastCrawlTime: string; googleCanonical: string; link: string;
};
