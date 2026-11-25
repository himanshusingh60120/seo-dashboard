// app/api/access/route.ts
// Manage access (the two access admins only). GET → everything the tab shows. POST { action, … } → one change. Every
// change needs the emailed code first (lib/otp.ts), which unlocks changes in that browser for 10 minutes.
//   saveUser { email, perms, weeklySites }   add a person or change their permissions
//   removeUser { email }
//   addDomain { domain } / removeDomain { domain }
//   saveDefaults { perms }                     what unlisted company-domain accounts get
//   saveAdminSites { email, weeklySites }      an admin's own weekly report properties
import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/token";
import { fail } from "@/lib/api";
import {
  ADMIN_EMAILS, builtInDomains, cleanPerms, cleanSites, isAccessAdmin, loadAccess, norm, saveAccess, type AccessConfig,
} from "@/lib/accessList";
import { requireUnlocked, unlockedUntil } from "@/lib/otp";
import { sharedStorageReady } from "@/lib/kvStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function requireAdmin(req: NextRequest) {
  const email = await requireUser(req);
  if (!isAccessAdmin(email)) throw new HttpError(403, "Only the access admins can manage access.");
  return norm(email);
}

function view(c: AccessConfig, me: string, req: NextRequest) {
  return NextResponse.json({
    me,
    admins: ADMIN_EMAILS.map((email) => ({ email, weeklySites: c.adminSites[email] || [] })),
    builtInDomains: builtInDomains(),
    domains: c.domains,
    domainDefaults: c.domainDefaults,
    users: [...c.users].sort((a, b) => a.email.localeCompare(b.email)),
    unlockedUntil: unlockedUntil(req, me),
    storage: sharedStorageReady(),
  });
}

export async function GET(req: NextRequest) {
  try {
    const me = await requireAdmin(req);
    return view(await loadAccess(true), me, req);
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const me = await requireAdmin(req);
    if (!sharedStorageReady()) throw new HttpError(503, "Upstash Redis isn't connected, so changes can't be saved.");
    requireUnlocked(req, me);
    const b = await req.json().catch(() => ({}));
    const c = await loadAccess(true);
    const at = new Date().toISOString();

    switch (String(b?.action || "")) {
      case "saveUser": {
        const email = norm(b.email);
        if (!EMAIL.test(email)) throw new HttpError(400, "Enter a full email address, e.g. name@company.com");
        if (isAccessAdmin(email)) throw new HttpError(400, `${email} is an admin and always has full access.`);
        const perms = cleanPerms(b.perms);
        const weeklySites = cleanSites(b.weeklySites);
        const old = c.users.find((u) => u.email === email);
        if (old) Object.assign(old, { perms, weeklySites, updatedBy: me, updatedAt: at });
        else c.users.push({ email, perms, weeklySites, addedBy: me, addedAt: at, updatedBy: me, updatedAt: at });
        break;
      }
      case "removeUser": {
        const email = norm(b.email);
        c.users = c.users.filter((u) => u.email !== email);
        break;
      }
      case "addDomain": {
        const d = norm(b.domain).replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
        if (!DOMAIN.test(d)) throw new HttpError(400, "Enter a domain like company.com");
        if (builtInDomains().includes(d) || c.domains.some((x) => x.domain === d)) throw new HttpError(400, `${d} can already sign in.`);
        c.domains.push({ domain: d, addedBy: me, addedAt: at });
        break;
      }
      case "removeDomain": {
        const d = norm(b.domain);
        if (builtInDomains().includes(d)) throw new HttpError(400, `${d} is built in. It can only be removed in lib/access.ts.`);
        c.domains = c.domains.filter((x) => x.domain !== d);
        break;
      }
      case "saveDefaults":
        c.domainDefaults = cleanPerms(b.perms);
        break;
      case "saveAdminSites": {
        const email = norm(b.email);
        if (!isAccessAdmin(email)) throw new HttpError(400, "That isn't an admin.");
        c.adminSites = { ...c.adminSites, [email]: cleanSites(b.weeklySites) };
        break;
      }
      default:
        throw new HttpError(400, "Unknown change.");
    }
    return view(await saveAccess(c, me), me, req);
  } catch (e) {
    return fail(e);
  }
}
