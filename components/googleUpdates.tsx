// components/googleUpdates.tsx
"use client";
// Google's ranking updates on the charts: loading them once per page, naming and colouring them, and the small list
// shown under the charts. The data comes from /api/google-updates (Google's Search Status Dashboard).
import { useEffect, useState } from "react";
import type { GoogleUpdate } from "@/lib/googleUpdates";
import { PanelTitle } from "./ui";

export type { GoogleUpdate };

export const UPDATE_COLOR: Record<GoogleUpdate["kind"], string> = { core: "#8e24aa", spam: "#c62828", other: "#5f6368" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const fmtDay = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const monthEnd = (m: string) =>
  `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;

/** "November 2026 core update" → "Nov '26 core". */
export function shortUpdateName(u: GoogleUpdate) {
  const m = u.name.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\s+(.*?)\s*update$/i);
  return m ? `${m[1].slice(0, 3)} '${m[2].slice(2)} ${m[3].toLowerCase()}` : u.name.replace(/\s*update$/i, "");
}

/** Updates that overlap the dates from–to (inclusive). One still rolling out counts up to today. */
export function updatesBetween(list: GoogleUpdate[], from: string, to: string) {
  const t = todayStr();
  return list.filter((u) => u.start <= to && (u.end || t) >= from);
}

/** Updates that overlap any of these months (YYYY-MM). */
export function updatesInMonths(list: GoogleUpdate[], months: string[]) {
  return list.filter((u) => months.some((m) => updatesBetween([u], `${m}-01`, monthEnd(m)).length > 0));
}

let loaded: Promise<GoogleUpdate[]> | null = null;

/** Google's updates, loaded once per page and shared by every chart. */
export function useGoogleUpdates(): GoogleUpdate[] {
  const [list, setList] = useState<GoogleUpdate[]>([]);
  useEffect(() => {
    let live = true;
    if (!loaded) {
      loaded = fetch("/api/google-updates", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { updates: [] }))
        .then((j) => (Array.isArray(j?.updates) ? (j.updates as GoogleUpdate[]) : []))
        .catch(() => {
          loaded = null;
          return [] as GoogleUpdate[];
        });
    }
    loaded.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** The list under the charts: each update, its dates, and (optionally) which period it fell in. */
export function UpdatesList({ rows, title = "Google updates in this period" }: { rows: { u: GoogleUpdate; note?: string }[]; title?: string }) {
  if (!rows.length) return null;
  return (
    <div className="panel" style={{ breakInside: "avoid" }}>
      <PanelTitle>{title}</PanelTitle>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
        {rows.map(({ u, note }) => (
          <li key={u.id} style={{ display: "flex", gap: 8, alignItems: "baseline", lineHeight: 1.8, fontSize: 14, flexWrap: "wrap" }}>
            <span style={{ color: UPDATE_COLOR[u.kind], fontWeight: 700 }}>◆</span>
            <b>{u.name}</b>
            <span className="muted">
              {fmtDay(u.start)} – {u.end ? fmtDay(u.end) : "still rolling out"}
              {note ? ` · ${note}` : ""}
            </span>
            <a href={u.url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
              Google&apos;s notice
            </a>
          </li>
        ))}
      </ul>
      <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
        From Google&apos;s Search Status Dashboard, and shaded on the charts (purple = core update, red = spam update). Core updates can
        move rankings for several weeks, so a rise or fall during one may partly come from it.
      </p>
    </div>
  );
}
