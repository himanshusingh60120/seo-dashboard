// app/api/site-check/route.js
// No API key needed. For each URL it:
//   1) fetches the page itself -> HTTP status, redirect target, noindex, canonical (reliable)
//   2) optionally requests Google "site:<url>" directly -> Google's HTTP status + result
//      (Google often blocks requests from Vercel's servers; the result says so when it does)
//
// POST /api/site-check   body: { "urls": ["https://..."], "google": true }   (max 20 URLs per call)
// GET  /api/site-check?url=https://...&google=1                            (one URL, handy for testing)
//
// Optional env var in Vercel: SITE_CHECK_ALLOWED_HOSTS=martech360.com  (comma-separated; limits which sites can be checked)

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_URLS = 20;
const PAGE_CONCURRENCY = 5;
const TIME_BUDGET_MS = 45000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[') || /^[\d.]+$/.test(h)) return false;
  const list = (process.env.SITE_CHECK_ALLOWED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !list.length || list.some((d) => h === d || h.endsWith('.' + d));
}

// Compare URLs ignoring protocol, www, trailing slash, query string and #fragment.
function normalize(u) {
  try {
    let x = new URL(u);
    if (/(^|\.)google\./.test(x.hostname) && x.pathname === '/url') {
      x = new URL(x.searchParams.get('q') || x.searchParams.get('url'));
    }
    let path = x.pathname;
    try { path = decodeURIComponent(path); } catch {}
    return x.hostname.toLowerCase().replace(/^www\./, '') + (path.replace(/\/+$/, '') || '/');
  } catch {
    return String(u).trim().toLowerCase();
  }
}

async function drain(res) {
  try { await res.body?.cancel(); } catch {}
}

// 1) The page's own response
async function checkPage(url) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(10000),
    });
    const out = { page_status: res.status, redirect_to: res.headers.get('location') || '', canonical: '' };
    let noindex = /noindex/i.test(res.headers.get('x-robots-tag') || '');
    if (res.status === 200 && (res.headers.get('content-type') || '').includes('html')) {
      const html = await res.text();
      for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
        if (/name\s*=\s*["']?(robots|googlebot)\b/i.test(tag) && /noindex/i.test(tag)) noindex = true;
      }
      for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
        if (/rel\s*=\s*["']?canonical\b/i.test(tag)) {
          out.canonical = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
          break;
        }
      }
    } else {
      await drain(res);
    }
    out.noindex = noindex ? 'yes' : 'no';
    return out;
  } catch (e) {
    return { page_status: 'ERR', error: `page: ${e.cause?.code || e.name}` };
  }
}

// 2) Google site: request, no browser, no API key
async function googleCheck(url) {
  const q = 'site:' + url.replace(/^https?:\/\//i, '');
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us&num=10&pws=0`;
  try {
    const res = await fetch(searchUrl, {
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' },
      signal: AbortSignal.timeout(12000),
    });
    const out = { google_http: res.status, google_result: 'unknown' };
    const loc = res.headers.get('location') || '';

    if (res.status === 429 || res.status === 403 || loc.includes('/sorry/')) {
      await drain(res);
      out.google_result = 'blocked';
      return out;
    }
    if (res.status >= 300 && res.status < 400) {
      await drain(res);
      out.google_result = loc.includes('consent.google') ? 'consent_page' : 'redirected';
      return out;
    }
    if (res.status !== 200) {
      await drain(res);
      return out;
    }

    const html = await res.text();
    const target = normalize(url);
    const found = [...html.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1].replace(/&amp;/g, '&'))
      .map((h) => (h.startsWith('/url?') ? 'https://www.google.com' + h : h))
      .some((h) => /^https?:\/\//i.test(h) && normalize(h) === target);

    if (found) out.google_result = 'found';
    else if (/did not match any documents/i.test(html)) out.google_result = 'not_found';
    else if (/enablejs|turn on javascript|not redirected within a few seconds/i.test(html)) out.google_result = 'js_required';
    else if (/unusual traffic|captcha/i.test(html)) out.google_result = 'blocked';
    return out;
  } catch (e) {
    return { google_http: 'ERR', google_result: 'error', error: `google: ${e.cause?.code || e.name}` };
  }
}

async function runChecks(urls, doGoogle) {
  const started = Date.now();
  const results = urls.map((url) => ({ url }));
  const valid = results.filter((r) => {
    if (isAllowed(r.url)) return true;
    r.page_status = 'invalid';
    r.error = 'URL not allowed (check SITE_CHECK_ALLOWED_HOSTS)';
    return false;
  });

  // Page checks in parallel
  const queue = [...valid];
  await Promise.all(
    Array.from({ length: PAGE_CONCURRENCY }, async () => {
      while (queue.length) {
        const r = queue.shift();
        Object.assign(r, await checkPage(r.url));
      }
    }),
  );

  // Google checks one at a time; stop hammering once Google blocks us
  let googleBlocked = false;
  if (doGoogle) {
    for (const r of valid) {
      if (googleBlocked || Date.now() - started > TIME_BUDGET_MS) {
        r.google_result = 'skipped';
        continue;
      }
      const g = await googleCheck(r.url);
      if (r.error && g.error) g.error = `${r.error}; ${g.error}`;
      Object.assign(r, g);
      if (['blocked', 'js_required', 'consent_page'].includes(g.google_result)) googleBlocked = true;
      else await sleep(800 + Math.random() * 1200);
    }
  }
  return { results, google_blocked: googleBlocked };
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'Send JSON: { "urls": [...] }' }, { status: 400 }); }
  const urls = Array.isArray(body?.urls)
    ? [...new Set(body.urls.map((s) => String(s).trim()).filter(Boolean))]
    : [];
  if (!urls.length) return Response.json({ error: 'No URLs given' }, { status: 400 });
  if (urls.length > MAX_URLS) return Response.json({ error: `Max ${MAX_URLS} URLs per request` }, { status: 400 });
  return Response.json(await runChecks(urls, body.google !== false));
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  if (!url) return Response.json({ error: 'Add ?url=https://...' }, { status: 400 });
  const doGoogle = searchParams.get('google') !== '0';
  return Response.json(await runChecks([url], doGoogle));
}
