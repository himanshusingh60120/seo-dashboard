type Row = Record<string, any>;

export async function batchReports(token: string, property: string, requests: object[]): Promise<Row[][]> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${property}:batchRunReports`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
      cache: 'no-store',
    }
  );
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${await res.text()}`);
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
