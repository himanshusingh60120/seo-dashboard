// lib/cron.ts
// Vercel's scheduler sends "Authorization: Bearer <CRON_SECRET>" with every scheduled call; nothing else gets in.
import type { NextRequest } from "next/server";
import { HttpError } from "./token";

export function assertCron(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new HttpError(500, "CRON_SECRET isn't set.");
  if (req.headers.get("authorization") !== `Bearer ${secret}`) throw new HttpError(401, "Not allowed.");
}
