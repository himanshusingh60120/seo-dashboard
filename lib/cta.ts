export const CTAS = [
  { key: 'license', label: 'Buy / License',  test: (p: string) => p.startsWith('/license-variant') },
  { key: 'sample',  label: 'Request sample', test: (p: string) => p.startsWith('/request-sample/') },
  { key: 'expert',  label: 'Talk to expert', test: (p: string) => p.startsWith('/talk-to-expert/') },
  { key: 'custom',  label: 'Customization',  test: (p: string) => p.startsWith('/customization/') },
  { key: 'connect', label: 'Connect',        test: (p: string) => /^\/connect\/?$/.test(p) },
];

// GA4 FULL_REGEXP filter on pagePath (must match the whole path)
export const CTA_REGEX =
  '/(license-variant.*|request-sample/.*|talk-to-expert/.*|customization/.*|connect/?)';

export const ctaOf = (path: string) => CTAS.find(c => c.test(path))?.key ?? null;

// "/license-variant?id=3172&cat=2" -> "3172"
// "/request-sample/global-senior-living-market-3172" -> "3172"
export function reportIdOf(pathWithQuery: string): string | null {
  const [path, q] = pathWithQuery.split('?');
  if (q) {
    const id = new URLSearchParams(q).get('id');
    if (id) return id;
  }
  return path.match(/-(\d+)\/?$/)?.[1] ?? null;
}

export const slugOf = (path: string) =>
  /-\d+\/?$/.test(path) ? path.replace(/\/$/, '').split('/').pop()! : null;
