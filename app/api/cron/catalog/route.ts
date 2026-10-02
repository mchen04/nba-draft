import { NextRequest } from "next/server";
import { getCatalog } from "@/lib/espn";
import { cronAuthorized, json, problem } from "@/lib/http";
import { currentSeason } from "@/lib/model";
import { ingestPhotos } from "@/lib/photos";

export const runtime = "nodejs";
export const maxDuration = 60;
// Weekly ESPN check. A failed check keeps the last good dataset and records the error.
export async function GET(request: NextRequest) {
  const denied = cronAuthorized(request);
  if (denied) return denied;
  try {
    const { players, ...catalog } = await getCatalog(currentSeason(), true);
    const photos = await ingestPhotos(
      players.map((player) => player.id),
      30000,
    );
    return json({ ...catalog, players: players.length, photos });
  } catch (error) {
    return problem(error);
  }
}
