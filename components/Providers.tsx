"use client";
import { useEffect } from "react";
import { SessionProvider } from "next-auth/react";

/**
 * After a new Vercel deployment, a tab that was opened earlier still asks for the old JavaScript files,
 * which no longer exist (ChunkLoadError → "Application error"). Reload once to pick up the new version.
 * The sessionStorage flag stops a reload loop if the files are genuinely missing.
 */
function useReloadOnStaleDeploy() {
  useEffect(() => {
    const KEY = "dash:chunk-reload";
    const isChunkError = (v: unknown) => {
      const s = v instanceof Error ? `${v.name} ${v.message}` : String(v ?? "");
      return /ChunkLoadError|Loading chunk [\w-]+ failed|Loading CSS chunk|Failed to fetch dynamically imported module/i.test(s);
    };
    const reload = () => {
      try {
        const last = Number(sessionStorage.getItem(KEY) || 0);
        if (Date.now() - last < 30_000) return; // already reloaded in the last 30 s: don't loop
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {}
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => {
      if (isChunkError(e.error) || isChunkError(e.message)) reload();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkError(e.reason)) reload();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

export default function Providers({ children }: { children: React.ReactNode }) {
  useReloadOnStaleDeploy();
  return <SessionProvider>{children}</SessionProvider>;
}
