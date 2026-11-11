// lib/ga4-report.ts
// GA4 Data API batchRunReports. GA4 allows only about 10 reports running at once per property (shared by every user
// and tab), so calls here are queued (a few at a time per property on each server) and retried when GA4 says it's busy.
type Row = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reports running at once per property on this server. GA4's limit (about 10) is shared by everyone, so stay well under it. */
const MAX_PARALLEL = 3;
const running = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

async function acquire(property: string) {
  while ((running.get(property) || 0) >= MAX_PARALLEL) {
    await new Promise<void>((resolve) => {
      const q = waiting.get(property) || [];
      q.push(resolve);
      waiting.set(property, q);
    });
  }
  running.set(property, (running.get(property) || 0) + 1);
}

function release(property: string) {
  running.set(property, Math.max(0, (running.get(property) || 1) - 1));
  const next = waiting.get(property)?.shift();
  if (next) next();
}

/** Turns GA4's raw error into a sentence people can act on. */
function friendly(status: number, text: string) {
  let msg = text;
  try {
    msg = JSON.parse(text)?.error?.message || text;
  } catch {
    /* not JSON */
  }
  if (status === 429 && /concurrent/i.test(msg)) {
    return "GA4 is busy: too many reports were requested at the same time. Wait a few seconds and press Refresh.";
  }
  if (status === 429 && /per day|daily/i.test(msg)) {
    return "This GA4 property has used up its reporting quota for today. GA4 numbers will load again after the daily reset (midnight Pacific time).";
  }
  if (status === 429 && /per hour|hourly/i.test(msg)) {
    return "This GA4 property has used up its reporting quota for this hour. Try again later in the hour.";
  }
  if (status === 429) return "GA4 is rate-limiting this property right now. Wait a minute and press Refresh.";
  if (status === 403) return `GA4 refused the request: ${msg.slice(0, 300)}`;
  return `GA4 ${status}: ${msg.slice(0, 300)}`;
}

export async function batchReports(token: string, property: string, requests: object[]): Promise<Row[][]> {
  await acquire(property);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:batchRunReports`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
        cache: "no-store",
      });
      if (res.ok) {
        const json = await res.json();
        return (json.reports ?? []).map((rep: any) => {
          const dims = (rep.dimensionHeaders ?? []).map((h: any) => h.name);
          const mets = (rep.metricHeaders ?? []).map((h: any) => h.name);
          return (rep.rows ?? []).map((r: any) => {
            const o: Row = {};
            dims.forEach((d: string, i: number) => (o[d] = r.dimensionValues[i].value));
            mets.forEach((m: string, i: number) => (o[m] = Number(r.metricValues[i].value)));
            return o;
          });
        });
      }
      const text = await res.text();
      // "Too many at once" and server errors clear up quickly; daily / hourly quota errors don't, so those aren't retried.
      const retryable = res.status >= 500 || (res.status === 429 && /concurrent/i.test(text));
      if (retryable && attempt < 4) {
        await sleep(800 * 2 ** attempt + Math.random() * 400);
        continue;
      }
      throw new Error(friendly(res.status, text));
    }
  } finally {
    release(property);
  }
}
