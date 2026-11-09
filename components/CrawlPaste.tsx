// components/CrawlPaste.tsx
"use client";
// The "Copy crawl stats" bookmark and the paste box that reads what it copied.
import { useEffect, useRef, useState } from "react";
import { BOOKMARKLET, parseSnapshot } from "@/lib/crawlSnapshot";
import type { ParsedCrawl } from "@/lib/crawlStats";

export default function CrawlPaste({ site, statsUrl, onParsed }: { site: string; statsUrl: string; onParsed: (p: ParsedCrawl) => void }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  // React warns about javascript: links written in JSX, so the bookmark link is set after render.
  useEffect(() => {
    link.current?.setAttribute("href", BOOKMARKLET);
  }, []);

  const read = (t: string) => {
    setMsg(null);
    try {
      const p = parseSnapshot(t, site);
      onParsed(p);
      setText("");
      setMsg({ text: `Read ${Object.keys(p.days).length} days (${p.label}). Check it below, then click Save import.` });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Couldn't read the pasted data", error: true });
    }
  };

  const fromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) throw new Error("empty");
      read(t);
    } catch {
      setMsg({ text: "The browser didn't allow reading the clipboard. Click in the box below and press Ctrl+V instead.", error: true });
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(BOOKMARKLET);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg({ text: "Couldn't copy. Drag the button to the bookmarks bar instead.", error: true });
    }
  };

  return (
    <div>
      <h4 style={{ margin: "0 0 6px" }}>Option A: copy straight from the Crawl stats page (no export)</h4>
      <ol className="muted" style={{ margin: "0 0 10px", paddingLeft: 18 }}>
        <li>
          One time only: drag this button to your browser's bookmarks bar{" "}
          <a
            ref={link}
            className="btn small"
            style={{ cursor: "grab" }}
            onClick={(e) => {
              e.preventDefault();
              alert("Drag this button onto your bookmarks bar. Then open Crawl stats in Search Console and click the bookmark there.");
            }}
          >
            Copy crawl stats
          </a>{" "}
          (if dragging doesn't work,{" "}
          <button className="btn small" onClick={copyCode}>{copied ? "Copied" : "copy its code"}</button> and create a new bookmark with that
          code as the URL).
        </li>
        <li>
          Open{" "}
          <a href={statsUrl} target="_blank" rel="noreferrer">Crawl stats for this property</a>, reload the page once (F5), wait for the chart,
          then click the bookmark. For Refresh and Discovery, open each under “By purpose” and click the bookmark on each page.
        </li>
        <li>Come back here and click <b>Paste crawl stats</b>. Repeat for each page you copied.</li>
      </ol>
      <div className="row">
        <button className="btn primary" onClick={fromClipboard}>Paste crawl stats</button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const t = e.clipboardData.getData("text");
          if (t.trim()) {
            e.preventDefault();
            read(t);
          }
        }}
        placeholder="…or click here and press Ctrl+V"
        rows={2}
        style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
        aria-label="Paste crawl stats here"
      />
      {text.trim() && (
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn" onClick={() => read(text)}>Read pasted text</button>
        </div>
      )}
      {msg && <p className={msg.error ? "notice error" : "muted"} style={{ marginBottom: 0 }}>{msg.text}</p>}
    </div>
  );
}
