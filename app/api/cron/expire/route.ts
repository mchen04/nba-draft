import { NextRequest } from "next/server";
import { expireRooms } from "@/lib/engine";
import { cronAuthorized, json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
// Expiry deletes rooms, so it runs only when ROOM_EXPIRY=on. Enabling Vercel crons for the
// weekly catalog check therefore cannot delete rooms by itself.
export async function GET(request: NextRequest) {
  const denied = cronAuthorized(request);
  if (denied) return denied;
  if (process.env.ROOM_EXPIRY !== "on")
    return json({ paused: true, expired: 0 });
  try {
    return json(
      await expireRooms(request.nextUrl.searchParams.get("dryRun") === "1"),
    );
  } catch (error) {
    return problem(error);
  }
}
