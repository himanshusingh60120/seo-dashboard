// components/AccessManager.tsx
// "Manage access" tab, shown only to access admins. /api/access checks the account again.
"use client";
import { useEffect, useState } from "react";

type Grant = { email: string; addedBy: string; addedAt: string };
type Data = { grants: Grant[]; domains: string[] };

export default function AccessManager() {
  const [data, setData] = useState<Data | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  async function call(method: "GET" | "POST" | "DELETE", target = "") {
    setBusy(true);
    try {
      const url = method === "DELETE" ? `/api/access?email=${encodeURIComponent(target)}` : "/api/access";
      const res = await fetch(url, {
        method,
        cache: "no-store",
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify({ email: target }) : undefined,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
      setData(j);
      return true;
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    call("GET");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = email.trim().toLowerCase();
    if (!target) return;
    setMsg(null);
    if (await call("POST", target)) {
      setEmail("");
      setMsg({ text: `${target} can now sign in.` });
    }
  };

  const remove = async (target: string) => {
    if (!confirm(`Remove sign-in access for ${target}?`)) return;
    setMsg(null);
    if (await call("DELETE", target)) setMsg({ text: `${target} can no longer sign in.` });
  };

  return (
    <section className="section">
      <h2>Manage access</h2>
      <p className="lede">
        Google accounts on {data ? data.domains.map((d) => `@${d}`).join(", ") : "the company domains"} can sign in automatically.
        Add anyone else here. They&apos;ll only see the Search Console and GA4 properties their own Google account can open.
      </p>
      <form onSubmit={add} style={{ display: "flex", gap: 8, maxWidth: 520, margin: "12px 0" }}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@example.com"
          aria-label="Email to give access"
          required
          style={{ flex: "1 1 auto" }}
        />
        <button className="btn primary" type="submit" disabled={busy}>Add</button>
      </form>
      {msg && <div className={`notice${msg.error ? " error" : ""}`}>{msg.text}</div>}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : data.grants.length === 0 ? (
        <p className="muted">Nobody has been added yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Email</th><th>Added by</th><th>Added on</th><th /></tr>
          </thead>
          <tbody>
            {data.grants.map((g) => (
              <tr key={g.email}>
                <td>{g.email}</td>
                <td>{g.addedBy}</td>
                <td>{new Date(g.addedAt).toLocaleDateString()}</td>
                <td><button className="btn" onClick={() => remove(g.email)} disabled={busy}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
