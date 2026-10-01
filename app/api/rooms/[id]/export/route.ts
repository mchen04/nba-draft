import { NextRequest, NextResponse } from "next/server";
import { DraftError, actorFor, transactRoom } from "@/lib/engine";
import { cookieName, problem } from "@/lib/http";
import { exportCsv } from "@/lib/export";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params,
      token = request.cookies.get(cookieName(id))?.value;
    const { room } = await transactRoom(id, token);
    if (!actorFor(room, token))
      throw new DraftError("Claim a team or recover ownership to export.", 403);
    const kind = request.nextUrl.searchParams.get("kind");
    if (kind !== "picks" && kind !== "rosters" && kind !== "order")
      throw new DraftError("Choose picks, rosters, or order.", 400);
    return new NextResponse(exportCsv(room, kind), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="nba-draft-${kind}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return problem(error);
  }
}
