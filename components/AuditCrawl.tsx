// components/AuditCrawl.tsx
"use client";
// Deep-crawl results and Googlebot crawl activity inside the GSC audit tab (audit account only, like the tab).
import { useState } from "react";
import { Bars, DataTable, Kpis, PanelTitle, SubTabs, num } from "./ui";
import type { Activity, CrawlReport } from "@/lib/audit/crawl";

type View = "broken" | "sources" | "redirects" | "activity";

const link = (u: string) => (/^https?:\/\//i.test(u) ? <a href={u} target="_blank" rel="noreferrer">{u}</a> : u);

export default function AuditCrawl({ report, activity }: { report: CrawlReport | null; activity: Activity | null }) {
  const [view, setView] = useState<View>("broken");
  if (!report && !activity) return null;

  const tabs: { id: View; label: string }[] = [];
  if (report) {
    tabs.push({ id: "broken", label: `Broken internal links (${num(report.brokenRows.length)})` });
    tabs.push({ id: "sources", label: `Where Google’s 404s are linked from (${num(report.sourceRows.length)})` });
    tabs.push({ id: "redirects", label: `Links to redirects (${num(report.redirectRows.length)})` });
  }
  if (activity) tabs.push({ id: "activity", label: `Googlebot crawl activity (${num(activity.inspected)})` });
  const current = tabs.some((t) => t.id === view) ? view : tabs[0].id;
  const span = activity && activity.inspectedFrom
    ? activity.inspectedFrom === activity.inspectedTo ? activity.inspectedFrom : `${activity.inspectedFrom} to ${activity.inspectedTo}`
    : "";

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <PanelTitle>Deep crawl and Googlebot crawl activity</PanelTitle>
      {report && (
        <Kpis
          items={[
            { label: "Pages fetched", value: num(report.fetched), sub: report.queuedLeft ? `${num(report.queuedLeft)} more found: raise the crawl limit to reach them` : `limit ${num(report.limit)}` },
            { label: "200 OK", value: num(report.ok) },
            { label: "Redirecting", value: num(report.redirecting) },
            { label: "Broken (4xx / 5xx / loop)", value: num(report.broken) },
            { label: "Blocked by robots.txt", value: num(report.blocked), sub: "not fetched, like Googlebot" },
            { label: "Couldn’t verify", value: num(report.inconclusive), sub: "timeouts, 403 / 429 / 503" },
          ]}
        />
      )}
      <div style={{ marginTop: 12 }}>
        <SubTabs value={current} onChange={setView} options={tabs} />

        {current === "broken" && report && (
          <DataTable
            rows={report.brokenRows}
            cols={[
              { key: "url", label: "Broken URL", url: true },
              { key: "status", label: "Status now" },
              { key: "linked_from", label: "Linked from (edit this page)", render: (r) => link(r.linked_from) },
              { key: "links_to_it", label: "Internal links to it", num: true },
              { key: "in_sitemap", label: "In sitemap" },
              { key: "note", label: "Note" },
            ]}
            initialSort="links_to_it"
            csvName="broken-internal-links.csv"
            empty="The crawl found no internal links to broken pages."
          />
        )}

        {current === "sources" && report && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              For every URL that Google’s URL Inspection reports as 404 or soft 404, these are the pages and sitemaps Google says point to it.
              The crawl re-fetched those pages to check whether the link is still there today.
            </p>
            <DataTable
              rows={report.sourceRows}
              cols={[
                { key: "url", label: "404 URL", url: true },
                { key: "source_type", label: "Source type" },
                { key: "source", label: "Source", render: (r) => link(r.source) },
                { key: "still_linked", label: "Still linked today?" },
                { key: "google_last_crawl", label: "Google last crawled" },
                { key: "inspected", label: "Inspected" },
              ]}
              initialSort="still_linked"
              initialDesc={false}
              csvName="404-sources.csv"
              empty="No 404 URLs among the inspected pages yet. Inspect more URLs (old URLs are checked first); broken internal links are in the first table."
            />
          </>
        )}

        {current === "redirects" && report && (
          <DataTable
            rows={report.redirectRows}
            cols={[
              { key: "url", label: "Linked URL", url: true },
              { key: "chain", label: "Redirect" },
              { key: "final_url", label: "Link here instead", url: true },
              { key: "linked_from", label: "Linked from (edit this page)", render: (r) => link(r.linked_from) },
              { key: "links_to_it", label: "Internal links to it", num: true },
            ]}
            initialSort="links_to_it"
            csvName="links-to-redirects.csv"
            empty="No internal links to redirecting URLs found."
          />
        )}

        {current === "activity" && activity && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              From Google’s URL Inspection API. Google only returns the latest crawl as of each check, so ages are measured on the day each URL
              was inspected{span ? ` (${span})` : ""}; inspect again to refresh them. Google doesn’t offer the Crawl stats report (total requests,
              response and purpose breakdown) through any API. “Crawls seen” counts the different last-crawl dates recorded
              {activity.since ? ` since ${activity.since}` : ""}, so it grows with every run.
            </p>
            <Kpis
              items={[
                { label: "URLs with Google data", value: num(activity.inspected), sub: span ? `inspected ${span}` : undefined },
                { label: "Never crawled", value: num(activity.never), sub: "Google knows the URL, no successful crawl" },
                { label: "Recrawled", value: num(activity.recrawled), sub: "2+ different crawl dates seen" },
                { label: "First crawl seen", value: num(activity.firstCrawl), sub: "were never crawled, now crawled" },
                { label: "Smartphone / desktop", value: `${num(activity.mobile)} / ${num(activity.desktop)}`, sub: "crawler used" },
              ]}
            />
            <div style={{ marginTop: 12 }}>
              <Bars
                items={[
                  { label: "Crawled under 1 day before the check", value: activity.d1 },
                  { label: "1–7 days before", value: activity.d7 },
                  { label: "7–30 days before", value: activity.d30 },
                  { label: "30–90 days before", value: activity.d90 },
                  { label: "90+ days before", value: activity.older },
                  { label: "Never crawled", value: activity.never },
                ]}
              />
            </div>
            <DataTable
              rows={activity.rows}
              cols={[
                { key: "url", label: "URL", url: true },
                { key: "last_crawl", label: "Google last crawled (UTC)" },
                { key: "inspected", label: "Inspected" },
                { key: "days_old_when_inspected", label: "Days old at check", num: true },
                { key: "crawls_seen", label: "Crawls seen", num: true },
                { key: "crawled_as", label: "Crawler" },
                { key: "coverage", label: "Google status" },
              ]}
              initialSort="days_old_when_inspected"
              initialDesc={false}
              csvName="googlebot-crawl-activity.csv"
            />
          </>
        )}
      </div>
    </div>
  );
}
