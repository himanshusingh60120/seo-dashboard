// lib/url.ts
/** Same page → same key: lower-case scheme and host, no default port, no #fragment. Path and query kept as-is. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function propertyHost(siteUrl: string) {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice(10).toLowerCase();
  try {
    return new URL(siteUrl).hostname.toLowerCase();
  } catch {
    return siteUrl.toLowerCase();
  }
}

/** Domain properties cover every subdomain and protocol; URL-prefix properties cover URLs under the prefix. */
export function urlInProperty(siteUrl: string, raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (siteUrl.startsWith("sc-domain:")) {
    const d = propertyHost(siteUrl);
    return host === d || host.endsWith(`.${d}`);
  }
  try {
    const p = new URL(siteUrl);
    return u.protocol === p.protocol && host === p.hostname.toLowerCase() && u.port === p.port && u.pathname.startsWith(p.pathname);
  } catch {
    return false;
  }
}

const MULTI = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "com.br", "com.cn", "com.sg", "com.my", "com.mx", "co.za", "com.tr", "com.hk", "co.id", "com.ph", "com.vn", "com.pk", "com.sa",
]);
export function registrableDomain(host: string) {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return MULTI.has(parts.slice(-2).join(".")) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** "shop.acme-tools.co.uk" → "acmetools" (matches "acme tools" once spaces are removed from a query). */
export function brandFromSite(siteUrl: string) {
  return registrableDomain(propertyHost(siteUrl)).split(".")[0].replace(/-/g, "").toLowerCase();
}
