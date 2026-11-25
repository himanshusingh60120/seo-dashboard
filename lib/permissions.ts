// lib/permissions.ts
// Server checks for each permission set in Manage access (lib/accessList.ts). Server-only.
import { HttpError } from "./token";
import { hasPerm, type Perm } from "./accessList";

type Tool = Exclude<Perm, "viewOnly">;
const DENIED: Record<Tool, string> = {
  captures: "Only the team members who run the weekly Search Console captures can do this. Ask an admin to tick “Weekly captures” for you in Manage access.",
  indexChecks: "Your account can't start or pause index checks. Ask an admin to tick “Index checks” for you in Manage access.",
  audit: "Site investigation isn't turned on for your account. Ask an admin to tick it for you in Manage access.",
  weekly: "The weekly report isn't turned on for your account. Ask an admin to tick it for you in Manage access.",
};

export async function requirePerm(email: string, perm: Tool) {
  if (!(await hasPerm(email, perm))) throw new HttpError(403, DENIED[perm]);
}

export const canCapture = (email?: string | null) => hasPerm(email, "captures");
export const requireCapture = (email: string) => requirePerm(email, "captures");
export const requireIndexChecks = (email: string) => requirePerm(email, "indexChecks");
export const isViewOnly = (email?: string | null) => hasPerm(email, "viewOnly");

export async function requireNotViewOnly(email: string) {
  if (await isViewOnly(email)) {
    throw new HttpError(403, "This is a view-only account: it can see the dashboard but can't run URL Inspection or change settings.");
  }
}
