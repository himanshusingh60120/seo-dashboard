// components/SitemapPicker.tsx
"use client";
// Lets the user choose which sitemap files make up the URL list for the Indexing tab and the Live index monitor.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { discoverSitemaps, loadUrlList, type UrlListResult } from "@/lib/checks";
import type { SitemapFile, SitemapList } from "@/lib/sitemaps";
import { num, shortUrl } from "./ui";

type Pref = { sitemaps: string[]; includeSearch: boolean };
const prefKey = (site: string) => `dash:sitemapPick:${site}`;

function readPref(site: string): Pref | null {
  try {
    const v = JSON.parse(localStorage.getItem(prefKey(site)) || "null");
    if (v && Array.isArray(v.sitemaps)) return { sitemaps: v.sitemaps.filter((s: unknown) => typeof s === "string"), includeSearch: !!v.includeSearch };
  } catch {}
  return null;
}
function writePref(site: string, p: Pref) {
  try {
    localStorage.setItem(prefKey(site), JSON.stringify(p));
  } catch {}
}

const TYPE_LABEL: Record<SitemapFile["type"], string> = {
  index: "Sitemap index",
  urlset: "Sitemap",
  unread: "Not opened",
  error: "Couldn't read",
};

function Check({ checked, mixed, onChange, label }: { checked: boolean; mixed?: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!mixed && !checked;
  }, [mixed, checked]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label} />;
}

export default function SitemapPicker({ site, onLoaded, onCancel }: { site: string; onLoaded: (r: UrlListResult) => void; onCancel: () => void }) {
  const [list, setList] = useState<SitemapList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeSearch, setIncludeSearch] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const initFor = useRef<SitemapList | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    setFilter("");
    discoverSitemaps(site)
      .then((r) => live && setList(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't list the sitemaps"));
    return () => {
      live = false;
    };
  }, [site]);

  // Tree: files by parent, and the choosable files under each index
  const tree = useMemo(() => {
    const files = list?.files || [];
    const kids = new Map<string | null, SitemapFile[]>();
    for (const f of files) {
      const arr = kids.get(f.parent) || [];
      arr.push(f);
      kids.set(f.parent, arr);
    }
    const leaves = new Map<string, string[]>();
    const leavesOf = (f: SitemapFile, path: Set<string>): string[] => {
      const hit = leaves.get(f.url);
      if (hit) return hit;
      if (path.has(f.url)) return [];
      path.add(f.url);
      const c = kids.get(f.url) || [];
      const out = f.type === "index" && c.length ? c.flatMap((k) => leavesOf(k, path)) : [f.url];
      path.delete(f.url);
      leaves.set(f.url, out);
      return out;
    };
    files.forEach((f) => leavesOf(f, new Set()));
    const choosable = files.filter((f) => !(f.type === "index" && (kids.get(f.url) || []).length)).map((f) => f.url);
    const byUrl = new Map(files.map((f) => [f.url, f] as const));
    return { kids, leaves, choosable, byUrl, tops: kids.get(null) || [] };
  }, [list]);

  // Start from the last choice for this property, or everything
  useEffect(() => {
    if (!list || initFor.current === list) return;
    initFor.current = list;
    const pref = readPref(site);
    const ok = new Set(tree.choosable);
    const keep = pref ? pref.sitemaps.filter((u) => ok.has(u)) : [];
    setSelected(new Set(keep.length ? keep : tree.choosable));
    setIncludeSearch(pref?.includeSearch ?? false);
    setExpanded(new Set(tree.tops.filter((f) => (tree.kids.get(f.url) || []).length).map((f) => f.url)));
  }, [list, tree, site]);

  const toggle = (urls: string[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const all = urls.length > 0 && urls.every((u) => next.has(u));
      urls.forEach((u) => (all ? next.delete(u) : next.add(u)));
      return next;
    });

  const countOf = (urls: string[]) => {
    let n = 0;
    let unknown = 0;
    for (const u of urls) {
      const f = tree.byUrl.get(u);
      if (f?.urls != null) n += f.urls;
      else unknown++;
    }
    return { n, unknown };
  };
  const totals = useMemo(() => countOf(Array.from(selected)), [selected, tree]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = filter.trim().toLowerCase();
  const matches = needle ? tree.choosable.filter((u) => u.toLowerCase().includes(needle)) : [];

  const row = (f: SitemapFile, depth: number, flat = false): ReactNode[] => {
    const kids = tree.kids.get(f.url) || [];
    const isIndex = f.type === "index" && kids.length > 0;
    const leaves = tree.leaves.get(f.url) || [f.url];
    const on = leaves.filter((u) => selected.has(u)).length;
    const open = expanded.has(f.url);
    const c = isIndex ? countOf(leaves) : null;
    const out: ReactNode[] = [
      <tr key={f.url}>
        <td style={{ width: 28 }}>
          <Check checked={on > 0 && on === leaves.length} mixed={on > 0} onChange={() => toggle(leaves)} label={`Select ${f.url}`} />
        </td>
        <td className="url" style={{ paddingLeft: 8 + depth * 18 }}>
          {isIndex && !flat && (
            <button
              className="btn small"
              style={{ marginRight: 6 }}
              aria-label={open ? "Collapse" : "Expand"}
              onClick={() =>
                setExpanded((prev) => {
                  const n = new Set(prev);
                  if (n.has(f.url)) n.delete(f.url);
                  else n.add(f.url);
                  return n;
                })
              }
            >
              {open ? "▾" : "▸"}
            </button>
          )}
          <a href={f.url} target="_blank" rel="noreferrer">{shortUrl(f.url)}</a>
          {f.foundIn && <span className="muted"> · {f.foundIn}</span>}
        </td>
        <td>
          {TYPE_LABEL[f.type]}
          {isIndex ? ` (${num(kids.length)} files)` : ""}
          {f.error && <span className="muted"> · {f.error}</span>}
        </td>
        <td className="num">
          {c ? `${num(c.n)}${c.unknown ? "+" : ""}` : f.urls != null ? num(f.urls) : "–"}
        </td>
        <td className="num">{f.submitted != null ? num(f.submitted) : "–"}</td>
        <td>{f.lastmod ? f.lastmod.slice(0, 10) : ""}</td>
      </tr>,
    ];
    if (isIndex && open && !flat) kids.forEach((k) => out.push(...row(k, depth + 1)));
    return out;
  };

  const run = async () => {
    setLoading(true);
    setError(null);
    const sitemaps = Array.from(selected);
    writePref(site, { sitemaps, includeSearch });
    try {
      onLoaded(await loadUrlList(site, { sitemaps, includeSearch }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the URL list");
    }
    setLoading(false);
  };

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3 style={{ margin: "0 0 4px" }}>Choose the sitemaps to test</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Only URLs from the sitemaps you tick go into the URL list, so URL Inspection (in this tab and the Live index monitor) checks only those
        pages. Your choice is remembered for this property in this browser.
      </p>

      {!list && !error && <p className="muted">Finding sitemaps in Search Console, robots.txt and /sitemap.xml…</p>}
      {error && <p className="notice error">{error}</p>}
      {!list && error && (
        <div className="row">
          <button className="btn" onClick={onCancel}>Close</button>
        </div>
      )}

      {list && (
        <>
          <div className="row" style={{ alignItems: "center" }}>
            <button className="btn small" onClick={() => setSelected(new Set(tree.choosable))} disabled={loading}>Select all</button>
            <button className="btn small" onClick={() => setSelected(new Set())} disabled={loading}>Select none</button>
            <input
              placeholder="Filter sitemaps, e.g. post-sitemap"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter sitemaps"
              style={{ minWidth: 240 }}
            />
            {needle && (
              <>
                <button className="btn small" disabled={!matches.length || loading} onClick={() => setSelected((prev) => new Set([...Array.from(prev), ...matches]))}>
                  Select {num(matches.length)} matching
                </button>
                <button
                  className="btn small"
                  disabled={!matches.length || loading}
                  onClick={() =>
                    setSelected((prev) => {
                      const n = new Set(prev);
                      matches.forEach((u) => n.delete(u));
                      return n;
                    })
                  }
                >
                  Unselect matching
                </button>
              </>
            )}
          </div>
          {list.note && <p className="muted" style={{ marginBottom: 0 }}>{list.note}</p>}

          <div className="table-wrap" style={{ maxHeight: 380, overflow: "auto", marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Sitemap</th>
                  <th>Type</th>
                  <th className="num">URLs</th>
                  <th className="num">Submitted (Search Console)</th>
                  <th>Last modified</th>
                </tr>
              </thead>
              <tbody>
                {!list.files.length && (
                  <tr>
                    <td colSpan={6} className="muted">No sitemaps found in Search Console, robots.txt or /sitemap.xml for this property.</td>
                  </tr>
                )}
                {needle
                  ? matches.flatMap((u) => row(tree.byUrl.get(u)!, 0, true))
                  : tree.tops.flatMap((f) => row(f, 0))}
                {needle && !matches.length && (
                  <tr>
                    <td colSpan={6} className="muted">No sitemap matches “{filter}”.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
            <input type="checkbox" checked={includeSearch} onChange={(e) => setIncludeSearch(e.target.checked)} disabled={loading} />
            Also include pages that had search impressions in the last 90 days, even if they aren't in the chosen sitemaps
          </label>

          <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
            <button className="btn primary" onClick={run} disabled={loading || (!selected.size && !includeSearch)}>
              {loading ? "Reading the chosen sitemaps…" : `Load URLs from ${num(selected.size)} sitemap${selected.size === 1 ? "" : "s"}`}
            </button>
            <button className="btn" onClick={onCancel} disabled={loading}>Cancel</button>
            <span className="muted">
              {num(selected.size)} of {num(tree.choosable.length)} selected · about {num(totals.n)} URLs
              {totals.unknown ? ` + ${num(totals.unknown)} file(s) not counted` : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
