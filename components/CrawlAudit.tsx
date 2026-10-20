// components/CrawlAudit.tsx
"use client";
import { useState } from "react";
import { Section, SubTabs } from "./ui";
import AuditImport from "./audit/AuditImport";
import SiteCrawl from "./audit/SiteCrawl";
import LogAnalyzer from "./audit/LogAnalyzer";
import FixPlan from "./audit/FixPlan";

type View = "check" | "crawl" | "logs" | "plan";

export default function CrawlAudit({ site }: { site: string }) {
  const [view, setView] = useState<View>("check");
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  return (
    <Section
      title="Crawl & indexing audit"
      lede={
        <>
          Search Console’s API has no Crawl stats or Page indexing lists, so this tab rebuilds them from evidence you can check.{" "}
          <strong>URL check</strong> re-inspects the URLs Search Console lists with the URL Inspection API (last crawl, canonicals, sitemaps,
          referring pages) and fetches each one live, hop by hop. <strong>Site crawl</strong> follows every internal link, so each 404 and
          redirect comes with the page that links to it. <strong>Googlebot logs</strong> reads your access logs, the only source that counts
          Googlebot’s real visits per URL. <strong>Fix plan</strong> turns everything into a task list.
        </>
      }
    >
      <SubTabs
        value={view}
        onChange={setView}
        options={[
          { id: "check", label: "URL check" },
          { id: "crawl", label: "Site crawl" },
          { id: "logs", label: "Googlebot logs" },
          { id: "plan", label: "Fix plan" },
        ]}
      />
      <div style={{ marginTop: 12 }}>
        {view === "check" && <AuditImport site={site} onChange={changed} />}
        {view === "crawl" && <SiteCrawl site={site} onChange={changed} />}
        {view === "logs" && <LogAnalyzer site={site} />}
        {view === "plan" && <FixPlan site={site} version={version} />}
      </div>
    </Section>
  );
}
