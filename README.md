# Search & traffic dashboard (Search Console + GA4)

A live, read-only dashboard for every Search Console and GA4 property your Google account can access.
Built with Next.js 14, deployed on Vercel, no database needed.

## What it shows

| Tab | Data |
| --- | --- |
| **Overview** | Clicks, impressions, CTR, average position (with change vs previous period), pages in the top 10, indexed / not-indexed count, users, sessions, organic sessions, users active right now, daily trend charts |
| **Rankings** | Pages ranking in positions 1–10, 11–20, 21–30 and beyond (clickable, with full page lists), pages that dropped 5+ positions, pages that stopped showing entirely |
| **Indexing** | Indexed and not-indexed URLs with links, the reason each page isn't indexed, last crawl date and a link to the URL in Search Console |
| **Queries** | A written summary of the queries you show up for, position and length distribution, branded share, top queries by clicks and impressions, queries close to page one, rising / falling / new queries, question queries |
| **Traffic & geography** | Unique users, new users, sessions, page views, engagement, channels, realtime users, users by country and city, top landing pages |

Every table can be filtered, sorted and exported to CSV. Data refreshes automatically every 5 minutes (toggle in the top bar).

## Setup

### 1. Google Cloud project

1. Go to <https://console.cloud.google.com/> and create a project (or use an existing one).
2. **APIs & Services → Library**, enable:
   - Google Search Console API
   - Google Analytics Admin API
   - Google Analytics Data API
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External** (or **Internal** if you're on Google Workspace and only colleagues will sign in).
   - Add the scopes `.../auth/webmasters.readonly` and `.../auth/analytics.readonly`.
   - Under **Test users**, add every Google account that will sign in.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorised redirect URIs:
     - `http://localhost:3000/api/auth/callback/google`
     - `https://YOUR-APP.vercel.app/api/auth/callback/google` (add after your first Vercel deploy)
   - Copy the **Client ID** and **Client secret**.

> **Refresh tokens in "Testing" mode expire after 7 days.** If the app stays in Testing, you'll need to sign in again weekly.
> To avoid that, publish the app (Internal apps don't need verification; External apps using these read-only scopes may ask for verification).

### 2. Run locally

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```

Generate `NEXTAUTH_SECRET` with `openssl rand -base64 32`.
Set `ALLOWED_EMAILS` to the accounts allowed to use the dashboard, otherwise anyone who can complete Google sign-in could open it.

### 3. Push to GitHub

```bash
git init
git add .
git commit -m "Search & traffic dashboard"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
```

`.env.local` is git-ignored — never commit secrets.

### 4. Deploy on Vercel

1. <https://vercel.com/new> → import the GitHub repo (framework is detected as Next.js).
2. Add environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL` (= `https://YOUR-APP.vercel.app`), `ALLOWED_EMAILS`.
3. Deploy, then add the production redirect URI from step 1.4 to your OAuth client.

Every push to `main` redeploys automatically.

## How the numbers are calculated

- **Periods.** Search Console data lags about 3 days, so search ranges end 3 days ago. GA4 ranges end today. "Previous" is the same number of days immediately before.
- **Ranking bands.** Each page is placed by its average position across all queries in the period (the same number Search Console shows in the Pages tab).
- **Lost rankings.** Pages whose average position worsened by 5+ places and that had at least 20 impressions in the previous period. "No longer showing" = pages with 20+ impressions last period and none now. Thresholds can be changed with the `dropBy` and `minImpr` query parameters in `app/api/gsc/performance/route.ts`.
- **Indexing.** Google doesn't offer the Page indexing report through its API. The Indexing tab builds it:
  1. It collects URLs from your submitted sitemaps (including sitemap indexes and `.gz` files) plus every page with search impressions in the last 90 days.
  2. Pages with impressions are counted as indexed without spending quota.
  3. The remaining URLs are checked with the **URL Inspection API**, which allows about **2,000 checks per property per day**. Scans resume where they left off, and results are saved in your browser (localStorage).
- **Unique users** is GA4's `totalUsers` metric.
- **Branded queries** are queries containing the first part of the domain (e.g. `acme` for `acme.com`). Pass `&brand=yourbrand` to the performance API to override.
- **Query totals** are lower than site totals because Google hides rare (anonymised) queries.

## GA4 ↔ Search Console pairing

The app matches each Search Console property to a GA4 property by comparing the site's domain with each GA4 web stream's URL.
If it guesses wrong, pick the right GA4 property in the top bar — the choice is remembered per site.

## Project structure

```
app/
  api/auth/[...nextauth]/   Google sign-in (NextAuth)
  api/properties/           Lists GSC sites + GA4 properties, auto-pairs them
  api/gsc/performance/      Totals, trend, ranking bands, lost pages, query summary
  api/gsc/sitemap-urls/     Collects URLs from sitemaps + search results
  api/gsc/inspect/          URL Inspection (20 URLs per call)
  api/ga4/overview/         Users, sessions, geography, channels, realtime
  login/                    Sign-in page
components/                 Dashboard UI (tabs, tables, charts)
lib/                        Google API client, auth, date ranges, index cache
middleware.ts               Protects all pages behind sign-in
```

Access tokens stay in the encrypted session cookie and are only used server-side; the browser never sees them.
