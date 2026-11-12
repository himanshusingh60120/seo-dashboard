// chrome-extension/options.js
const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;
const KINDS = [["indexing", "Page indexing"], ["crawl", "Crawl stats"], ["ai", "AI impressions"]];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Same as background.js: take the address and key from config.json (in the downloaded zip) when it's new. */
async function seed() {
  try {
    const res = await fetch(chrome.runtime.getURL("config.json"), { cache: "no-store" });
    if (!res.ok) return;
    const c = await res.json();
    const { configAt } = await store.get("configAt");
    if (c.dashUrl && c.key && c.createdAt !== configAt) {
      await store.set({ dashUrl: c.dashUrl, key: c.key, configAt: c.createdAt, email: c.email || "" });
    }
  } catch (e) {
    /* set up by hand */
  }
}

async function load() {
  await seed();
  const c = await store.get(["dashUrl", "key", "extra", "email"]);
  $("dash").value = c.dashUrl || "";
  $("key").value = c.key || "";
  $("extra").value = c.extra || "";
  $("who").textContent = c.email ? `Set up for ${c.email}. Captures are saved under this name.` : "";
  render();
}

async function render() {
  const all = await store.get(null);
  const sites = Array.from(new Set([...(all.sites || []), ...String(all.extra || "").split(/\s+/).filter(Boolean)]));
  let h = "<tr><th>Property</th>" + KINDS.map((k) => `<th>${k[1]}</th>`).join("") + "</tr>";
  for (const s of sites) {
    h += `<tr><td>${esc(s)}</td>`;
    for (const [k] of KINDS) {
      const st = all[`status:${s}:${k}`] || {};
      const cls = st.ok === false ? "bad" : st.ok ? "ok" : "";
      const text = st.ok === false ? "Failed" : st.okAt ? `Saved ${new Date(st.okAt).toLocaleDateString()}` : "Not yet";
      h += `<td class="${cls}" title="${esc(st.message || "")}">${text}${st.ok === false ? `<div class="muted">${esc(st.message || "")}</div>` : ""}</td>`;
    }
    h += "</tr>";
  }
  $("status").innerHTML = sites.length ? h : "";
  $("msg").textContent = all.running
    ? `Working: ${all.now || "…"}`
    : all.lastError || (all.lastCheck ? `Last checked ${new Date(all.lastCheck).toLocaleString()}` : "Connected. The first capture starts within a few minutes.");
}

$("save").onclick = async () => {
  let origin;
  try {
    origin = new URL($("dash").value.trim()).origin;
  } catch {
    $("msg").textContent = "Enter the dashboard address, for example https://your-dashboard.vercel.app";
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) {
    $("msg").textContent = "Chrome needs permission to reach the dashboard.";
    return;
  }
  const key = $("key").value.trim();
  await store.set({ dashUrl: origin, key, extra: $("extra").value.trim() });
  try {
    const res = await fetch(origin + "/api/capture/targets", { headers: { "x-capture-key": key }, cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `error ${res.status}`);
    await store.set({ sites: j.sites || [] });
    $("msg").textContent = `Connected. ${(j.sites || []).length} propert${(j.sites || []).length === 1 ? "y" : "ies"} enabled in the dashboard.`;
  } catch (e) {
    $("msg").textContent = `Saved, but the dashboard said: ${e.message}`;
  }
  render();
};

$("run").onclick = () => {
  $("msg").textContent = "Capturing… a small Chrome window opens and closes when it's done.";
  chrome.runtime.sendMessage({ type: "run" });
};

setInterval(render, 3000);
load();
