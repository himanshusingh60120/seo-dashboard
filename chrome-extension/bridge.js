// Runs on the dashboard's own pages only (added by the dashboard's download). Lets the "Capture this property now"
// button reach this extension: the page posts a message, this script passes it on and posts the answer back.
const REPLY = "kr-capture-reply";
const KINDS = ["indexing", "crawl", "ai"];
const BUSY_MS = 45 * 60e3;

const answer = (data) => window.postMessage({ kind: REPLY, ...data }, location.origin);

async function statusOf(site) {
  const keys = ["running", "now", "lastError", ...KINDS.map((k) => `status:${site}:${k}`)];
  const st = await chrome.storage.local.get(keys);
  const reports = {};
  for (const k of KINDS) reports[k] = st[`status:${site}:${k}`] || null;
  return {
    running: !!st.running && Date.now() - st.running < BUSY_MS,
    now: st.now || "",
    error: st.lastError || "",
    reports,
  };
}

window.addEventListener("message", async (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.kind !== "kr-capture") return;
  const id = d.id;
  try {
    if (d.type === "ping") {
      answer({ id, type: "pong", version: chrome.runtime.getManifest().version });
    } else if (d.type === "status") {
      answer({ id, type: "status", ...(await statusOf(String(d.site || ""))) });
    } else if (d.type === "run") {
      const r = await chrome.runtime.sendMessage({ type: "run", site: String(d.site || "") });
      answer({ id, type: "run", ...(r || { ok: false, error: "No answer from the extension." }) });
    }
  } catch (err) {
    answer({ id, type: d.type, ok: false, error: String((err && err.message) || err) });
  }
});
