// components/CrawlPaste.tsx
"use client";
// The "Copy crawl stats" bookmark, plus a paste box for when the browser blocks the bookmark from opening a tab.
import { useEffect, useRef, useState } from "react";
import { bookmarkletFor } from "@/lib/crawlCapture";

export default function CrawlPaste({ statsUrl, onText }: { statsUrl: string; onText: (text: string) => void }) {
  const link = useRef<HTMLAnchorElement>(null);
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  // The bookmark must know this dashboard's address. React warns about javascript: links in JSX, so it's set after render.
  useEffect(() => {
    const c = bookmarkletFor(window.location.origin);
    setCode(c);
    link.current?.setAttribute("href", c);
  }, []);

  const fromClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) throw new Error("empty");
      onText(t);
    } catch {
      setNote("The browser didn't allow reading the clipboard. Click in the box below and press Ctrl+V instead.");
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNote("Couldn't copy. Drag the button to the bookmarks bar instead.");
    }
  };

  return (
    <div>
      <h4 style={{ margin: "0 0 6px" }}>Update with one click (no export)</h4>
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
          (if dragging doesn't work, <button className="btn small" onClick={copyCode}>{copied ? "Copied" : "copy its code"}</button> and
          create a bookmark with that code as the URL). Replace any older “Copy crawl stats” bookmark.
        </li>
        <li>
          Open <a href={statsUrl} target="_blank" rel="noreferrer">Crawl stats for this property</a> and click the bookmark. The dashboard opens in
          a new tab, checks the numbers and saves them for everyone.
        </li>
      </ol>
      <details>
        <summary className="muted">The browser blocked the new tab? Paste instead</summary>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={fromClipboard}>Paste crawl stats</button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (t.trim()) {
              e.preventDefault();
              setText("");
              onText(t);
            }
          }}
          placeholder="…or click here and press Ctrl+V"
          rows={2}
          style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
          aria-label="Paste crawl stats here"
        />
        {text.trim() && (
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn" onClick={() => { onText(text); setText(""); }}>Read pasted text</button>
          </div>
        )}
        {note && <p className="notice error" style={{ marginBottom: 0 }}>{note}</p>}
      </details>
    </div>
  );
}
