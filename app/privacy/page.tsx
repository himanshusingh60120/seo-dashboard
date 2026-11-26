// app/privacy/page.tsx
// Privacy policy for Google's sign-in screen (Google Cloud → Google Auth Platform → Branding → privacy policy link).
// It must open without signing in. Change the three values below if the operator, contact or date changes.
import type { Metadata } from "next";
import Link from "next/link";

const OPERATOR = "Kings Research";
const CONTACT = "hsingh@kingsresearch.com";
const UPDATED = "26 November 2026";

export const metadata: Metadata = { title: "Privacy policy · Search & traffic dashboard" };

const H2 = { fontSize: 18, margin: "28px 0 8px" } as const;
const MUTED = { color: "#5f6368" } as const;

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 48px", lineHeight: 1.6, color: "#202124" }}>
      <p style={{ margin: 0 }}>
        <Link href="/">← Search &amp; traffic dashboard</Link>
      </p>
      <h1 style={{ fontSize: 26, margin: "16px 0 4px" }}>Privacy policy</h1>
      <p style={{ ...MUTED, marginTop: 0 }}>Last updated {UPDATED}</p>

      <h2 style={H2}>Who runs this dashboard</h2>
      <p>
        The Search &amp; traffic dashboard is an internal tool run by {OPERATOR} to report on the search performance and website traffic
        of its own websites. Only people approved by the dashboard&apos;s administrators can sign in.
      </p>

      <h2 style={H2}>What the dashboard reads with your Google sign-in</h2>
      <ul>
        <li>Your name and email address, to identify you and check that you are approved to use the dashboard.</li>
        <li>
          Google Search Console data for the properties your Google account can already open: search performance, sitemaps and
          URL Inspection results.
        </li>
        <li>Google Analytics 4 data for the properties your Google account can already open.</li>
      </ul>
      <p>The dashboard never sees properties your own Google account has no access to.</p>

      <h2 style={H2}>What is stored</h2>
      <ul>
        <li>
          <b>Saved history and check results.</b> Search Console and Google Analytics figures for the properties opened in the dashboard,
          and the results of the daily index checks, are saved in Google Sheets in the company&apos;s Google Drive, so that older months
          can still be compared after Google stops showing them.
        </li>
        <li>
          <b>A saved sign-in, only if you start index checks.</b> When you start or take over the daily index checks for a site, your
          Google sign-in is saved on the server so the checks can run while you are not using the dashboard. It is used only for those
          checks, on the sites where they were started.
        </li>
        <li>
          <b>Sign-in records.</b> Your email address and the time you signed in, to keep a record of who uses the dashboard.
        </li>
        <li>
          <b>In your browser.</b> Your choices (website, dates) and copies of recent results so pages open faster. The copies are kept for
          up to 3 days and removed when you sign out.
        </li>
        <li>
          <b>Technical logs.</b> The hosting service keeps short-lived request logs for troubleshooting.
        </li>
      </ul>

      <h2 style={H2}>How the data is used and shared</h2>
      <p>
        The data is used only to show reports in this dashboard and to run the checks set up in it. It is not sold, not used for
        advertising and not shared outside {OPERATOR}, except with the services that run the dashboard: Vercel (hosting), Upstash
        (server storage for settings and counters) and Google (Sheets, Drive, Search Console and Analytics). Saved figures for a site can
        be seen by the colleagues who use the dashboard for that site.
      </p>
      <p>
        The dashboard&apos;s use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2 style={H2}>Removing access or data</h2>
      <p>
        You can remove the dashboard&apos;s access to your Google account at any time on{" "}
        <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">
          myaccount.google.com/connections
        </a>
        . Any index checks running on your saved sign-in then pause until a colleague takes them over. To have your saved sign-in or
        sign-in records deleted, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2 style={H2}>Changes</h2>
      <p>If this policy changes, the new version is published on this page with a new date.</p>

      <h2 style={H2}>Contact</h2>
      <p>
        Questions about this policy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </main>
  );
}
