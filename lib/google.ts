// lib/google.ts
import { HttpError } from "./token";

async function g<T = any>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.error?.message || `Google API error ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return data as T;
}

/* ---------------- Search Console ---------------- */

const GSC = "https://searchconsole.googleapis.com";
const site = (s: string) => encodeURIComponent(s);

export async function listSites(token: string) {
  const data = await g<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(
    token,
    `${GSC}/webmasters/v3/sites`
  );
  return (data.siteEntry || []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

export type SARow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

export type SABody = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dimensionFilterGroups?: unknown[];
};

/** The exact body sent to searchAnalytics.query (defaults included), for the provenance log. */
export const saRequest = (body: SABody) => ({ type: "web", dataState: "final", ...body });
export const saEndpoint = (siteUrl: string) => `POST ${GSC}/webmasters/v3/sites/${site(siteUrl)}/searchAnalytics/query`;

export async function searchAnalytics(
  token: string,
  siteUrl: string,
  body: SABody
): Promise<SARow[]> {
  const data = await g<{ rows?: SARow[] }>(
    token,
    `${GSC}/webmasters/v3/sites/${site(siteUrl)}/searchAnalytics/query`,
    { method: "POST", body: JSON.stringify(saRequest(body)) }
  );
  return data.rows || [];
}

/** Pages through results (25k rows per request) up to maxRows. */
export async function searchAnalyticsAll(
  token: string,
  siteUrl: string,
  body: { startDate: string; endDate: string; dimensions: string[] },
  maxRows = 50000
) {
  const out: SARow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += 25000) {
    const rows = await searchAnalytics(token, siteUrl, { ...body, rowLimit: 25000, startRow });
    out.push(...rows);
    if (rows.length < 25000) break;
  }
  return out;
}

export async function listSitemaps(token: string, siteUrl: string) {
  const data = await g<{ sitemap?: { path: string; isSitemapsIndex?: boolean; contents?: { submitted?: string }[] }[] }>(
    token,
    `${GSC}/webmasters/v3/sites/${site(siteUrl)}/sitemaps`
  );
  return data.sitemap || [];
}

export async function inspectUrl(token: string, siteUrl: string, inspectionUrl: string) {
  const data = await g<any>(token, `${GSC}/v1/urlInspection/index:inspect`, {
    method: "POST",
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: "en-US" }),
  });
  const r = data?.inspectionResult?.indexStatusResult || {};
  return {
    url: inspectionUrl,
    verdict: (r.verdict as string) || "VERDICT_UNSPECIFIED",
    coverageState: (r.coverageState as string) || "Unknown",
    indexingState: (r.indexingState as string) || "",
    lastCrawlTime: (r.lastCrawlTime as string) || "",
    googleCanonical: (r.googleCanonical as string) || "",
    link: (data?.inspectionResult?.inspectionResultLink as string) || "",
    /** Google's full indexStatusResult, kept as evidence. */
    raw: r,
  };
}

/* ---------------- Google Analytics 4 ---------------- */

export const INSPECT_ENDPOINT = `POST ${GSC}/v1/urlInspection/index:inspect`;

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
export const ga4Endpoint = (propertyId: string, realtime = false) =>
  `POST ${DATA}/properties/${propertyId}:${realtime ? "runRealtimeReport" : "runReport"}`;

export async function listGa4Properties(token: string) {
  const out: { id: string; name: string; account: string }[] = [];
  let pageToken = "";
  do {
    const data = await g<any>(
      token,
      `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`
    );
    for (const acc of data.accountSummaries || []) {
      for (const p of acc.propertySummaries || []) {
        out.push({ id: String(p.property).replace("properties/", ""), name: p.displayName, account: acc.displayName });
      }
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

export async function listWebStreamHosts(token: string, propertyId: string): Promise<string[]> {
  try {
    const data = await g<any>(token, `${ADMIN}/properties/${propertyId}/dataStreams?pageSize=50`);
    return (data.dataStreams || [])
      .map((s: any) => s.webStreamData?.defaultUri)
      .filter(Boolean)
      .map((u: string) => normalizeHost(u));
  } catch {
    return [];
  }
}

export function normalizeHost(u: string) {
  const s = u.replace(/^sc-domain:/, "");
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return s.replace(/^www\./, "").toLowerCase();
  }
}

export type GaReport = {
  rows: { dims: string[]; mets: number[] }[];
  totals: number[];
};

export async function runReport(token: string, propertyId: string, body: Record<string, unknown>): Promise<GaReport> {
  const data = await g<any>(token, `${DATA}/properties/${propertyId}:runReport`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseGa(data);
}

export async function runRealtime(token: string, propertyId: string, body: Record<string, unknown>) {
  const data = await g<any>(token, `${DATA}/properties/${propertyId}:runRealtimeReport`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseGa(data);
}

function parseGa(data: any): GaReport {
  return {
    rows: (data.rows || []).map((r: any) => ({
      dims: (r.dimensionValues || []).map((d: any) => d.value),
      mets: (r.metricValues || []).map((m: any) => Number(m.value)),
    })),
    totals: (data.totals?.[0]?.metricValues || []).map((m: any) => Number(m.value)),
  };
}
