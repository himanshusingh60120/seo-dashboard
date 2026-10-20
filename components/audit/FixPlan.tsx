// components/audit/FixPlan.tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import { DataTable, Bars, PanelTitle, num } from "../ui";
import { loadPart } from "@/lib/auditStore";
import { diagnose, crawlActions, ACTION_LABEL, ACTION_PRIORITY, REASONS, type Action, type AuditCheck, type CrawlState, type ReasonKey } from "@/lib/auditRules";
import type { ImportedList } from "@/lib/auditClient";

type Row = { priority: number; task: string; where: string; url: string; detail: string; from: string };
const KIND_TEXT = { fix: "Fix", review: "Decide", expected: "Usually fine", ok: "Fine" };

export default function FixPlan({ site, version }: { site: string; version: number }) {
  const [checks, setChecks] = useState<Record<string, AuditCheck>>({});
  const [lists, setLists] = useState<Record<string, ImportedList>>({});
  const [crawl, setCrawl] = useState<CrawlState | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      loadPart<Record<string, AuditCheck>>(site, "checks"),
      loadPart<Record<string, ImportedList>>(site, "imports"),
      loadPart<CrawlState>(site, "crawl"),
    ]).then(([c, l, k]) => {
      if (!alive) return;
      setChecks(c || {});
      setLists(l || {});
      setCrawl(k);
    });
    return () => { alive = false; };
  }, [site, version]);

  const rows = useMemo<Row[]>(() => {
    const listed = new Map<string, string>();
    Object.keys(lists).forEach((id) => lists[id].urls.forEach((u) => { if (!listed.has(u.url)) listed.set(u.url, id); }));
    const seen = new Set<string>();
    const out: Row[] = [];
    const push = (a: Action, from: string) => {
      if (a.kind === "info") return;
      const k = `${a.kind}|${a.page || ""}|${a.url}|${a.text}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ priority: ACTION_PRIORITY[a.kind], task: ACTION_LABEL[a.kind], where: a.page || "", url: a.url, detail: a.text, from });
    };
    Object.keys(checks).forEach((u) => diagnose({ ...checks[u], listedAs: listed.get(u) || checks[u].listedAs }).actions.forEach((a) => push(a, "URL check")));
    if (crawl) crawlActions(crawl).forEach((a) => push(a, "Site crawl"));
    return out.sort((a, b) => a.priority - b.priority);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checks, lists, crawl, version]);

  const byTask = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(r.task, (m.get(r.task) || 0) + 1));
    return Array.from(m.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [rows]);

  const guide = (Object.keys(REASONS) as ReasonKey[]).map((k) => ({
    reason: REASONS[k].label,
    source: REASONS[k].source,
    kind: KIND_TEXT[REASONS[k].kind],
    meaning: REASONS[k].meaning,
    fix: REASONS[k].fixes.join(" "),
  }));

  return (
    <>
      <div className="panel">
        <PanelTitle>Tasks, most urgent first ({num(rows.length)})</PanelTitle>
        {byTask.length > 0 ? <Bars items={byTask} color="var(--down)" /> : <p className="muted">Run URL check or Site crawl to build the plan.</p>}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <DataTable
          rows={rows}
          cols={[
            { key: "priority", label: "Priority", num: true },
            { key: "task", label: "Task" },
            { key: "where", label: "Where to make the change", render: (r) => (/^https?:/.test(r.where) ? <a href={r.where} target="_blank" rel="noreferrer">{r.where}</a> : r.where) },
            { key: "url", label: "Affected URL", url: true },
            { key: "detail", label: "Evidence and fix" },
            { key: "from", label: "Found by" },
          ]}
          initialSort="priority"
          initialDesc={false}
          csvName="fix-plan.csv"
          empty="No tasks yet."
        />
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <PanelTitle>What each Search Console reason means</PanelTitle>
        <DataTable
          rows={guide}
          cols={[
            { key: "reason", label: "Reason" },
            { key: "source", label: "Source" },
            { key: "kind", label: "Usually" },
            { key: "meaning", label: "Meaning" },
            { key: "fix", label: "What to do" },
          ]}
          pageSize={20}
        />
      </div>
    </>
  );
}
