// components/UpdatedBy.tsx
"use client";
// Who updated a saved Search Console report (Page indexing, Crawl stats, AI impressions), and when.
// These reports are updated by the team's Chrome extension once a week; this panel only shows the history.
import { PanelTitle } from "./ui";

export type UpdateEntry = { at: string; by?: string; via?: string; note?: string };

export const BOOKMARKS_RETIRED =
  "The bookmarks are no longer used, so nothing was saved from that click. The Chrome extension updates this report every week (see the Index checks tab).";

const DAY = 864e5;
const STALE_DAYS = 8;

/** Where an update came from, read from the source saved with it. */
export function viaOf(source?: string) {
  const s = String(source || "");
  if (/^chrome extension/i.test(s)) return "Chrome extension";
  if (/upstash/i.test(s)) return "Copied from earlier storage";
  if (/^dashboard/i.test(s) || /bookmark/i.test(s)) return "Bookmark";
  return s ? "Bookmark or export" : "";
}

const ago = (iso: string) => {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = (Date.now() - t) / DAY;
  if (d < 1 / 24) return "just now";
  return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"} ago`;
};

export default function UpdatedBy({ title, updates, shared }: { title: string; updates: UpdateEntry[]; shared: boolean }) {
  const list = updates
    .filter((u) => u.at && !isNaN(Date.parse(u.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const last = list[0];
  const stale = !!last && (Date.now() - Date.parse(last.at)) / DAY > STALE_DAYS;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <PanelTitle>{title}</PanelTitle>
      {last ? (
        <p style={{ marginTop: 0 }}>
          Last updated <strong>{new Date(last.at).toLocaleString()}</strong> ({ago(last.at)})
          {last.by ? (
            <>
              {" "}
              by <strong>{last.by}</strong>
            </>
          ) : null}
          {last.via ? <span className="muted"> · {last.via}</span> : null}
          <span className="muted">{shared ? " · saved for everyone" : " · saved in this browser"}</span>
          {last.note ? <span className="muted"> · {last.note}</span> : null}
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>Not updated yet.</p>
      )}

      {stale && (
        <div className="notice">
          The last update is more than a week old. Check the Chrome extension&apos;s status in the Index checks tab.
        </div>
      )}

      {list.length > 1 && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Earlier updates ({list.length - 1})
          </summary>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  <th>How</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(1, 51).map((u, i) => (
                  <tr key={`${u.at}-${i}`}>
                    <td>{new Date(u.at).toLocaleString()}</td>
                    <td>{u.by || "–"}</td>
                    <td>{u.via || "–"}</td>
                    <td>{u.note || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <p className="muted" style={{ marginBottom: 0 }}>
        Updated automatically once a week by the team&apos;s Chrome extension. To set it up, open the Index checks tab.
      </p>
    </div>
  );
}
