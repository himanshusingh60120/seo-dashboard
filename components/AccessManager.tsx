// components/AccessManager.tsx
// The "Manage access" tab, for the two access admins only: everyone who can sign in (admins, domains and people) in one
// list, and the extra tools each listed person gets. Accounts on a sign-in domain who aren't listed can sign in and look,
// but get no extra tools. Each person chooses their own weekly report properties in the Weekly report tab.
// Every change needs the 6-digit code emailed to the admin; one code unlocks changes in this browser for 10 minutes.
// /api/access checks everything again.
"use client";
import { useEffect, useMemo, useState } from "react";
import { PanelTitle, Section } from "./ui";

type Perm = "viewOnly" | "captures" | "indexChecks" | "audit" | "weekly";
type Perms = Record<Perm, boolean>;
type User = { email: string; perms: Perms; addedBy: string; addedAt: string; updatedBy: string; updatedAt: string };
type Data = {
  me: string;
  admins: string[];
  builtInDomains: string[];
  domains: { domain: string; addedBy: string; addedAt: string }[];
  users: User[];
  unlockedUntil: number | null;
  storage: boolean;
};
type ApiError = Error & { status?: number };
type ListRow = { key: string; who: string; kind: string; added: string; onDelete?: () => void };

const PERMS: { id: Perm; label: string; help: string }[] = [
  { id: "viewOnly", label: "Read-only", help: "Sees everything their Google account can open, but can't run URL Inspection, start index checks or change settings." },
  { id: "captures", label: "Weekly captures", help: "Downloads the Chrome extension and sends the weekly Search Console captures." },
  { id: "indexChecks", label: "Index checks", help: "Can start and pause daily index checks, and run URL Inspection." },
  { id: "audit", label: "Site investigation", help: "Can run the Site investigation (its AI step costs money)." },
  { id: "weekly", label: "Weekly report", help: "Sees the Weekly report and chooses its properties there (from the ones their Google account can open)." },
];
const NONE: Perms = { viewOnly: false, captures: false, indexChecks: false, audit: false, weekly: false };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_MS = 60_000;

const when = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString() : "");
/** Read-only switches off the tools that change things (the server does the same). */
const withRule = (p: Perms): Perms => (p.viewOnly ? { ...p, captures: false, indexChecks: false } : p);
const blocked = (p: Perms, id: Perm) => p.viewOnly && (id === "captures" || id === "indexChecks");

async function api<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e: ApiError = new Error(j.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return j as T;
}

function PermBoxes({ value, disabled, onChange }: { value: Perms; disabled?: boolean; onChange: (p: Perms) => void }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
      {PERMS.map((p) => (
        <label
          key={p.id}
          title={p.help}
          style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap", opacity: blocked(value, p.id) ? 0.5 : 1 }}
        >
          <input
            type="checkbox"
            checked={value[p.id]}
            disabled={disabled || blocked(value, p.id)}
            onChange={(e) => onChange(withRule({ ...value, [p.id]: e.target.checked }))}
          />
          {p.label}
        </label>
      ))}
    </div>
  );
}

export default function AccessManager() {
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState<Perms>(NONE);
  const [domain, setDomain] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api<Data>("/api/access")
      .then((d) => {
        setData(d);
        setUntil(d.unlockedUntil);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : "Couldn't load Manage access"));
  }, []);

  // Countdown for the unlock and the "send a new code" wait.
  useEffect(() => {
    if (!until && !sentAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until, sentAt]);

  const allDomains = useMemo(() => (data ? [...data.builtInDomains, ...data.domains.map((d) => d.domain)] : []), [data]);
  const outside = (e: string) => !allDomains.includes(e.slice(e.lastIndexOf("@") + 1));

  const unlocked = !!until && until > now;
  const locked = !unlocked || busy;
  const left = unlocked && until ? Math.ceil((until - now) / 1000) : 0;
  const wait = sentAt ? Math.max(0, Math.ceil((sentAt + RESEND_MS - now) / 1000)) : 0;

  const oops = (e: unknown) => {
    const err = e as ApiError;
    if (err?.status === 401) setUntil(null);
    setMsg({ text: err?.message || "Something went wrong", error: true });
  };

  const change = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api<Data>("/api/access", body);
      setData(d);
      setUntil(d.unlockedUntil);
      setMsg({ text: done });
      return true;
    } catch (e) {
      oops(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/access/otp", { action: "send" });
      setSentAt(Date.now());
      setNow(Date.now());
      setCode("");
      setMsg({ text: `Code sent to ${data?.me}. It works for 10 minutes. Check spam if it doesn't arrive within a minute.` });
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ unlockedUntil: number }>("/api/access/otp", { action: "verify", code });
      setUntil(r.unlockedUntil);
      setNow(Date.now());
      setSentAt(null);
      setCode("");
      setMsg({ text: "Unlocked: you can make changes for the next 10 minutes." });
    } catch (err) {
      oops(err);
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    await api("/api/access/otp", { action: "lock" }).catch(() => {});
    setUntil(null);
    setMsg(null);
  };

  const addPerson = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = email.trim().toLowerCase();
    if (!EMAIL.test(target)) return setMsg({ text: "Enter a full email address, e.g. name@company.com", error: true });
    if (data?.admins.includes(target)) return setMsg({ text: `${target} is an admin and already has full access.`, error: true });
    if (data?.users.some((u) => u.email === target)) {
      return setMsg({ text: `${target} is already in the list. Change their ticks in the table.`, error: true });
    }
    const ok = await change({ action: "saveUser", email: target, perms }, `${target} added.${outside(target) ? " They can now sign in." : ""}`);
    if (ok) {
      setEmail("");
      setPerms(NONE);
    }
  };

  const saveUser = (u: User, p: Perms) => change({ action: "saveUser", email: u.email, perms: p }, `Saved ${u.email}.`);

  const remove = async (u: User) => {
    const q = outside(u.email)
      ? `Delete ${u.email}? They won't be able to sign in any more.`
      : `Delete ${u.email}? Their domain is allowed, so they can still sign in, but they lose the tools ticked for them.`;
    if (!window.confirm(q)) return;
    await change({ action: "removeUser", email: u.email }, `${u.email} deleted.`);
  };

  const addDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await change({ action: "addDomain", domain }, `Accounts on ${domain.trim()} can now sign in.`)) setDomain("");
  };

  const removeDomain = async (d: string) => {
    if (!window.confirm(`Delete @${d}? People on it can no longer sign in, unless they're listed by email.`)) return;
    await change({ action: "removeDomain", domain: d }, `@${d} deleted.`);
  };

  const lede = "Who can sign in and what each person can do. Changes need a code emailed to you, and reach everyone within 30 seconds.";
  if (loadErr) {
    return (
      <Section title="Manage access" lede={lede}>
        <div className="notice error">{loadErr}</div>
      </Section>
    );
  }
  if (!data) {
    return (
      <Section title="Manage access" lede={lede}>
        <p className="muted">Loading…</p>
      </Section>
    );
  }

  const addedText = (by: string, at: string) => [when(at), by].filter(Boolean).join(" · ") || "–";
  const rows: ListRow[] = [
    ...data.admins.map((e) => ({ key: `a:${e}`, who: e, kind: "Admin", added: "Fixed in the code" })),
    ...data.builtInDomains.map((d) => ({ key: `b:${d}`, who: `@${d}`, kind: "Built-in domain", added: "Fixed in the code" })),
    ...data.domains.map((d) => ({
      key: `d:${d.domain}`,
      who: `@${d.domain}`,
      kind: "Added domain",
      added: addedText(d.addedBy, d.addedAt),
      onDelete: () => removeDomain(d.domain),
    })),
    ...data.users.map((u) => ({
      key: `u:${u.email}`,
      who: u.email,
      kind: outside(u.email) ? "Person (outside the sign-in domains)" : "Person",
      added: addedText(u.addedBy, u.addedAt),
      onDelete: () => remove(u),
    })),
  ];
  const f = filter.trim().toLowerCase();
  const shown = f ? rows.filter((r) => r.who.toLowerCase().includes(f) || r.kind.toLowerCase().includes(f)) : rows;

  return (
    <Section title="Manage access" lede={lede}>
      {!data.storage && <div className="notice error">Upstash Redis isn&apos;t connected, so changes can&apos;t be saved.</div>}

      {/* Lock */}
      <div className="panel" style={{ marginBottom: 16, borderLeft: `4px solid ${unlocked ? "#1e8e3e" : "#f9ab00"}` }}>
        {unlocked ? (
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <span>
              <b style={{ color: "#137333" }}>Unlocked.</b> You can make changes for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} more.
            </span>
            <button className="btn" onClick={lock}>Lock now</button>
          </div>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              <b>Locked.</b> To change anything, confirm with a 6-digit code emailed to <b>{data.me}</b>. One code unlocks changes in
              this browser for 10 minutes.
            </p>
            <form className="row" onSubmit={verify} style={{ gap: 8, alignItems: "center" }}>
              <button type="button" className={`btn${sentAt ? "" : " primary"}`} onClick={sendCode} disabled={busy || wait > 0 || !data.storage}>
                {!sentAt ? "Email me a code" : wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
              </button>
              {sentAt && (
                <>
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6-digit code"
                    aria-label="Code from the email"
                    autoFocus
                    style={{ width: 140, letterSpacing: 3, fontSize: 16 }}
                  />
                  <button className="btn primary" type="submit" disabled={busy || code.length !== 6}>Confirm</button>
                </>
              )}
            </form>
          </>
        )}
      </div>

      {msg && <div className={`notice${msg.error ? " error" : ""}`} style={{ marginBottom: 16 }}>{msg.text}</div>}

      {/* Everyone who can sign in */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <PanelTitle>{`Who can sign in (${rows.length})`}</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Every admin, domain and person that can sign in. Admins and built-in domains are fixed in the code. Added domains and
          people can be deleted by either admin ({data.admins.join(" or ")}) after unlocking.
        </p>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by email, domain or type"
          aria-label="Filter the list"
          style={{ minWidth: 260, marginBottom: 8 }}
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email or domain</th>
                <th>Type</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.who}
                    {r.who === data.me && <span className="muted"> (you)</span>}
                  </td>
                  <td>{r.kind}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.added}</td>
                  <td style={{ textAlign: "right" }}>
                    {r.onDelete ? (
                      <button className="btn small" disabled={locked} title={locked ? "Unlock above to delete" : undefined} onClick={r.onDelete}>
                        Delete
                      </button>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>Can&apos;t be deleted</span>
                    )}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={4} className="muted">Nothing matches the filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form className="row" onSubmit={addDomain} style={{ gap: 8, marginTop: 12 }}>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="company.com" aria-label="Domain to add" style={{ minWidth: 220 }} />
          <button className="btn primary" type="submit" disabled={locked || !domain.trim()}>Add domain</button>
          {!unlocked && <span className="muted">Unlock above to add or delete.</span>}
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          Google accounts on a sign-in domain get in automatically (exact domain only; subdomains don&apos;t count). People on a new domain
          also need Google&apos;s sign-in screen to accept outside accounts: in Google Cloud → OAuth consent screen, the user type must be
          External and the app published.
        </p>
      </div>

      {/* Extra tools for people */}
      <div className="panel">
        <PanelTitle>Extra tools for people</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Anyone on a sign-in domain can sign in and look at the dashboard, but gets no extra tools unless they&apos;re added here with ticks.
          Add an email to give someone tools, or to let a person outside the sign-in domains in. Hover a tick&apos;s name for what it allows.
          People with the Weekly report choose its properties themselves, in the Weekly report tab.
        </p>
        <form onSubmit={addPerson} style={{ display: "grid", gap: 10, marginBottom: 16 }}>
          <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              aria-label="Email to add"
              style={{ minWidth: 260 }}
            />
            <PermBoxes value={perms} onChange={setPerms} />
            <button className="btn primary" type="submit" disabled={locked || !email.trim()}>Add person</button>
          </div>
        </form>

        {!data.users.length ? (
          <p className="muted" style={{ marginBottom: 0 }}>Nobody has been added yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  {PERMS.map((p) => (
                    <th key={p.id} title={p.help} style={{ textAlign: "center" }}>{p.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.email}>
                    <td>
                      {u.email}
                      {outside(u.email) && <div className="muted" style={{ fontSize: 12 }}>outside the sign-in domains</div>}
                    </td>
                    {PERMS.map((p) => (
                      <td key={p.id} style={{ textAlign: "center" }}>
                        <input
                          type="checkbox"
                          aria-label={`${p.label} for ${u.email}`}
                          checked={u.perms[p.id]}
                          disabled={locked || blocked(u.perms, p.id)}
                          onChange={(e) => saveUser(u, withRule({ ...u.perms, [p.id]: e.target.checked }))}
                        />
                      </td>
                    ))}
                    <td style={{ textAlign: "right" }}>
                      <button className="btn small" disabled={locked} onClick={() => remove(u)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
