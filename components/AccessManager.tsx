// components/AccessManager.tsx
// The "Manage access" tab, for the two access admins only: who can sign in, what each person can do, which properties
// each person's weekly report covers, and which domains sign in automatically. Every change needs the 6-digit code
// emailed to the admin; one code unlocks changes in this browser for 10 minutes. /api/access checks everything again.
"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { PanelTitle, Section } from "./ui";

type Perm = "viewOnly" | "captures" | "indexChecks" | "audit" | "weekly";
type Perms = Record<Perm, boolean>;
type User = { email: string; perms: Perms; weeklySites: string[]; addedBy: string; addedAt: string; updatedBy: string; updatedAt: string };
type Data = {
  me: string;
  admins: { email: string; weeklySites: string[] }[];
  builtInDomains: string[];
  domains: { domain: string; addedBy: string; addedAt: string }[];
  domainDefaults: Perms;
  users: User[];
  unlockedUntil: number | null;
  storage: boolean;
};
type ApiError = Error & { status?: number };

const PERMS: { id: Perm; label: string; help: string }[] = [
  { id: "viewOnly", label: "Read-only", help: "Sees everything their Google account can open, but can't run URL Inspection, start index checks or change settings." },
  { id: "captures", label: "Weekly captures", help: "Downloads the Chrome extension and sends the weekly Search Console captures." },
  { id: "indexChecks", label: "Index checks", help: "Can start and pause daily index checks." },
  { id: "audit", label: "Site investigation", help: "Can run the Site investigation (its AI step costs money)." },
  { id: "weekly", label: "Weekly report", help: "Sees the Weekly report for the properties chosen for them." },
];
const NONE: Perms = { viewOnly: false, captures: false, indexChecks: false, audit: false, weekly: false };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_MS = 60_000;
const CHIP = { display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, background: "#f1f3f4", fontSize: 13 } as const;

const short = (s: string) => s.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const when = (iso: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString() : "–");
const count = (n: number) => `${n} ${n === 1 ? "property" : "properties"}`;
const sitesLabel = (s: string[]) => (s.length ? count(s.length) : "Default list");
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

/** Ticks the Search Console properties a weekly report covers. Nothing ticked = the default list. */
function SitePicker({
  value, options, saveLabel, disabled, onSave, onCancel,
}: {
  value: string[]; options: string[] | null; saveLabel: string; disabled?: boolean; onSave: (sites: string[]) => void; onCancel: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(value));
  const [filter, setFilter] = useState("");
  const all = useMemo(
    () => Array.from(new Set([...(options || []), ...value])).sort((a, b) => short(a).localeCompare(short(b))),
    [options, value]
  );
  const f = filter.trim().toLowerCase();
  const shown = f ? all.filter((s) => s.toLowerCase().includes(f)) : all;
  const flip = (s: string) =>
    setSel((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  return (
    <div style={{ background: "#f8f9fa", border: "1px solid #e1e6eb", borderRadius: 8, padding: 12, margin: "8px 0" }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Tick the properties this weekly report covers, or untick all for the default list (aitech, martech, readmagazine,
        itdigest). The report only shows properties the person&apos;s own Google account can open; any others are listed as not found.
      </p>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        placeholder="Filter properties"
        aria-label="Filter properties"
        style={{ minWidth: 240 }}
      />
      {!options && !value.length ? (
        <p className="muted">Loading your Search Console properties…</p>
      ) : !all.length ? (
        <p className="muted">No Search Console properties found for your account.</p>
      ) : (
        <div style={{ maxHeight: 260, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "4px 12px", margin: "10px 0" }}>
          {shown.map((s) => (
            <label key={s} title={s} style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
              <input type="checkbox" checked={sel.has(s)} onChange={() => flip(s)} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {short(s)}
                {s.startsWith("sc-domain:") ? " (domain)" : ""}
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="btn primary" disabled={disabled} onClick={() => onSave(all.filter((s) => sel.has(s)))}>
          {saveLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <span className="muted">{sel.size ? `${count(sel.size)} ticked` : "Default list"}</span>
        {disabled && <span className="muted">· unlock above to save</span>}
      </div>
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
  const [sites, setSites] = useState<string[]>([]);
  const [domain, setDomain] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const [props, setProps] = useState<string[] | null>(null);

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

  // Your Search Console properties, for the weekly report pickers (loaded the first time a picker opens).
  useEffect(() => {
    if (!picking || props) return;
    let live = true;
    api<{ gsc: { siteUrl: string }[] }>("/api/properties")
      .then((p) => live && setProps(p.gsc.map((x) => x.siteUrl)))
      .catch(() => live && setProps([]));
    return () => {
      live = false;
    };
  }, [picking, props]);

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
    if (data?.users.some((u) => u.email === target)) {
      return setMsg({ text: `${target} is already in the list. Change their ticks in the table.`, error: true });
    }
    const ok = await change(
      { action: "saveUser", email: target, perms, weeklySites: perms.weekly ? sites : [] },
      `${target} added.${outside(target) ? " They can now sign in." : ""}`
    );
    if (ok) {
      setEmail("");
      setPerms(NONE);
      setSites([]);
      if (picking === "new") setPicking(null);
    }
  };

  const saveUser = (u: User, p: Perms, s: string[]) => change({ action: "saveUser", email: u.email, perms: p, weeklySites: s }, `Saved ${u.email}.`);

  const remove = async (u: User) => {
    const out = outside(u.email);
    const q = out
      ? `Remove ${u.email}? They won't be able to sign in any more.`
      : `Remove ${u.email} from the list? They can still sign in, with the company-domain settings below.`;
    if (!window.confirm(q)) return;
    await change({ action: "removeUser", email: u.email }, `${u.email} removed.`);
  };

  const addDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await change({ action: "addDomain", domain }, `Accounts on ${domain.trim()} can now sign in.`)) setDomain("");
  };

  const removeDomain = async (d: string) => {
    if (!window.confirm(`Remove @${d}? People on it who aren't in the list above can no longer sign in.`)) return;
    await change({ action: "removeDomain", domain: d }, `@${d} removed.`);
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

      {/* Admins */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <PanelTitle>Admins</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Full access to everything, including this tab. Fixed in the code (lib/accessList.ts): nobody can be made an admin from here.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Weekly report properties</th>
              </tr>
            </thead>
            <tbody>
              {data.admins.map((a) => {
                const key = `admin:${a.email}`;
                return (
                  <Fragment key={a.email}>
                    <tr>
                      <td>
                        {a.email}
                        {a.email === data.me && <span className="muted"> (you)</span>}
                      </td>
                      <td>
                        <button className="btn small" onClick={() => setPicking(picking === key ? null : key)}>{sitesLabel(a.weeklySites)} ▾</button>
                      </td>
                    </tr>
                    {picking === key && (
                      <tr>
                        <td colSpan={2}>
                          <SitePicker
                            value={a.weeklySites}
                            options={props}
                            saveLabel="Save"
                            disabled={locked}
                            onCancel={() => setPicking(null)}
                            onSave={async (s) => {
                              if (await change({ action: "saveAdminSites", email: a.email, weeklySites: s }, `Saved ${a.email}'s weekly report properties.`)) setPicking(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* People */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <PanelTitle>People</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Add someone to give them extra tools, or to let a person outside the sign-in domains in. A person here gets exactly the
          ticks shown, instead of the company-domain settings below. Hover a name for what it allows.
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
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {perms.weekly && (
              <button type="button" className="btn" onClick={() => setPicking(picking === "new" ? null : "new")}>
                Weekly report: {sitesLabel(sites)} ▾
              </button>
            )}
            <button className="btn primary" type="submit" disabled={locked || !email.trim()}>Add person</button>
            {!unlocked && <span className="muted">Unlock above to add people.</span>}
          </div>
          {picking === "new" && perms.weekly && (
            <SitePicker
              value={sites}
              options={props}
              saveLabel="Use these"
              onCancel={() => setPicking(null)}
              onSave={(s) => {
                setSites(s);
                setPicking(null);
              }}
            />
          )}
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
                  <th>Weekly report properties</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <Fragment key={u.email}>
                    <tr>
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
                            onChange={(e) => saveUser(u, withRule({ ...u.perms, [p.id]: e.target.checked }), u.weeklySites)}
                          />
                        </td>
                      ))}
                      <td>
                        {u.perms.weekly ? (
                          <button className="btn small" onClick={() => setPicking(picking === u.email ? null : u.email)}>{sitesLabel(u.weeklySites)} ▾</button>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {when(u.addedAt)}
                        <div>{u.addedBy}</div>
                      </td>
                      <td>
                        <button className="btn small" disabled={locked} onClick={() => remove(u)}>Remove</button>
                      </td>
                    </tr>
                    {picking === u.email && (
                      <tr>
                        <td colSpan={PERMS.length + 4}>
                          <SitePicker
                            value={u.weeklySites}
                            options={props}
                            saveLabel="Save"
                            disabled={locked}
                            onCancel={() => setPicking(null)}
                            onSave={async (s) => {
                              if (await saveUser(u, u.perms, s)) setPicking(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Company-domain defaults */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <PanelTitle>Everyone else on the sign-in domains</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>What company-domain accounts that aren&apos;t in the list above get. Changes apply straight away.</p>
        <PermBoxes
          value={data.domainDefaults}
          disabled={locked}
          onChange={(p) => change({ action: "saveDefaults", perms: p }, "Saved the company-domain settings.")}
        />
      </div>

      {/* Domains */}
      <div className="panel">
        <PanelTitle>Sign-in domains</PanelTitle>
        <p className="muted" style={{ marginTop: 0 }}>
          Google accounts on these domains sign in automatically (exact domain only; subdomains don&apos;t count). Built-in domains are set in the code.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {data.builtInDomains.map((d) => (
            <span key={d} style={CHIP} title="Built in (lib/access.ts)">
              @{d} <span className="muted">· built in</span>
            </span>
          ))}
          {data.domains.map((d) => (
            <span key={d.domain} style={{ ...CHIP, background: "#e8f0fe" }} title={`Added by ${d.addedBy} on ${when(d.addedAt)}`}>
              @{d.domain}
              <button
                type="button"
                aria-label={`Remove ${d.domain}`}
                disabled={locked}
                onClick={() => removeDomain(d.domain)}
                style={{ border: "none", background: "none", padding: 0, fontSize: 16, lineHeight: 1, color: "#5f6368", cursor: locked ? "default" : "pointer" }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form className="row" onSubmit={addDomain} style={{ gap: 8 }}>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="company.com" aria-label="Domain to add" style={{ minWidth: 220 }} />
          <button className="btn primary" type="submit" disabled={locked || !domain.trim()}>Add domain</button>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          People on a new domain also need Google&apos;s sign-in screen to accept outside accounts: in Google Cloud → OAuth consent
          screen, the user type must be External and the app published. Otherwise Google shows them an error before they reach the dashboard.
        </p>
      </div>
    </Section>
  );
}
