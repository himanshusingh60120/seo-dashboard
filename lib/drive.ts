// lib/drive.ts
// The few Google Drive calls the dashboard needs, as the service account: find the folder the control Sheet is in,
// find a Sheet by name in that folder, and create a new Sheet there. The service account has no Drive storage of its
// own, so it can only create files inside a shared drive where it's a Content manager. Server-only.
import { serviceAccountToken } from "./serviceAccount";

const API = "https://www.googleapis.com/drive/v3/files";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

async function drive<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await serviceAccountToken();
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text.slice(0, 300) } };
  }
  if (res.ok) return data as T;
  const msg = String(data?.error?.message || `error ${res.status}`);
  let hint = "";
  if (/has not been used|is disabled|not enabled/i.test(msg)) {
    hint = " Turn on the Google Drive API for the dd-kr-dash project: Google Cloud console → APIs & Services → Library → Google Drive API → Enable.";
  } else if (/storage quota/i.test(msg)) {
    hint = " The folder must be inside a shared drive, with the service account as a Content manager.";
  } else if (res.status === 403 || res.status === 404) {
    hint = " Check that the service account is a member (Content manager) of the shared drive.";
  }
  throw new Error(`Google Drive: ${msg}${hint}`);
}

let folderCache: string | null = null;

/** Where property Sheets are created: SHEETS_FOLDER_ID if set, otherwise the folder the control Sheet is in. */
export async function sheetsFolder(controlId: string): Promise<string> {
  const fixed = process.env.SHEETS_FOLDER_ID?.trim();
  if (fixed) return fixed;
  if (folderCache) return folderCache;
  const f = await drive<{ parents?: string[] }>(`${API}/${encodeURIComponent(controlId)}?fields=parents&supportsAllDrives=true`);
  const parent = f.parents?.[0];
  if (!parent) throw new Error("Couldn't find the folder the control Sheet is in. Set SHEETS_FOLDER_ID in Vercel.");
  folderCache = parent;
  return parent;
}

const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** A Google Sheet with exactly this name in the folder, if there is one. */
export async function findSheetFile(folder: string, name: string): Promise<string | null> {
  const q = `'${quote(folder)}' in parents and name = '${quote(name)}' and mimeType = '${SHEET_MIME}' and trashed = false`;
  const d = await drive<{ files?: { id: string }[] }>(
    `${API}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`
  );
  return d.files?.[0]?.id ?? null;
}

/** Creates an empty Google Sheet in the folder and returns its ID. */
export async function createSheetFile(folder: string, name: string): Promise<string> {
  const d = await drive<{ id?: string }>(`${API}?supportsAllDrives=true&fields=id`, {
    method: "POST",
    body: JSON.stringify({ name, mimeType: SHEET_MIME, parents: [folder] }),
  });
  if (!d.id) throw new Error("Google Drive didn't return the new Sheet's ID.");
  return d.id;
}
