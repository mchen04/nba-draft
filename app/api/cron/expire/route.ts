import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { expireRooms } from "@/lib/engine";
import { json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that variable is set.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "Expiry is not configured." }, 503);
  const expected = Buffer.from(`Bearer ${secret}`),
    received = Buffer.from(request.headers.get("authorization") ?? "");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return json({ error: "Not authorized." }, 401);
  try {
    return json(
      await expireRooms(request.nextUrl.searchParams.get("dryRun") === "1"),
    );
  } catch (error) {
    return problem(error);
  }
}
