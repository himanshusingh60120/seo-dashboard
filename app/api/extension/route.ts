// app/api/extension/route.ts
// GET → the Chrome extension as a .zip, set up for the signed-in person: this dashboard's address and their own
// extension key are inside (config.json), Chrome is allowed to reach this dashboard (manifest host_permissions), and
// bridge.js runs on this dashboard's pages so the "Capture this property now" button can reach the extension.
// Only capture accounts (lib/captureAccess.ts) can download it.
import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/token";
import { captureKeyFor } from "@/lib/captureKey";
import { assertCaptureEmail } from "@/lib/captureAccess";
import { makeZip } from "@/lib/zip";
import { fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FOLDER = "kr-search-capture";

export async function GET(req: NextRequest) {
  try {
    const email = await requireUser(req);
    assertCaptureEmail(email);
    const origin = req.nextUrl.origin;

    let files: [string, Buffer][];
    try {
      // Written out one by one so Vercel includes each file in the deployment.
      files = await Promise.all([
        fs.readFile(path.join(process.cwd(), "chrome-extension", "manifest.json")).then((b) => ["manifest.json", b] as [string, Buffer]),
        fs.readFile(path.join(process.cwd(), "chrome-extension", "background.js")).then((b) => ["background.js", b] as [string, Buffer]),
        fs.readFile(path.join(process.cwd(), "chrome-extension", "scrapers.js")).then((b) => ["scrapers.js", b] as [string, Buffer]),
        fs.readFile(path.join(process.cwd(), "chrome-extension", "bridge.js")).then((b) => ["bridge.js", b] as [string, Buffer]),
        fs.readFile(path.join(process.cwd(), "chrome-extension", "options.html")).then((b) => ["options.html", b] as [string, Buffer]),
        fs.readFile(path.join(process.cwd(), "chrome-extension", "options.js")).then((b) => ["options.js", b] as [string, Buffer]),
      ]);
    } catch {
      throw new HttpError(500, "The extension files aren't in this deployment. Check that the chrome-extension folder is in the repository and next.config.js includes it, then redeploy.");
    }

    const manifest = JSON.parse(files[0][1].toString("utf8"));
    manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions || []), `${origin}/*`]));
    // The bridge runs only on this dashboard's pages.
    manifest.content_scripts = [{ matches: [`${origin}/*`], js: ["bridge.js"], run_at: "document_idle" }];
    const config = { dashUrl: origin, key: captureKeyFor(email), email, createdAt: new Date().toISOString() };

    const zip = makeZip([
      { name: `${FOLDER}/manifest.json`, data: JSON.stringify(manifest, null, 2) },
      { name: `${FOLDER}/config.json`, data: JSON.stringify(config, null, 2) },
      ...files.slice(1).map(([name, data]) => ({ name: `${FOLDER}/${name}`, data })),
    ]);

    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${FOLDER}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fail(e);
  }
}
