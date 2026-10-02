import { NextRequest, NextResponse } from "next/server";
import { datasetCatalog } from "@/lib/espn";
import { json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
// A dataset id never changes content, so browsers and the CDN may keep it for a year.
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ dataset: string }> },
) {
  try {
    const { dataset } = await context.params;
    const id = /^[1-9][0-9]{0,15}$/.test(dataset) ? Number(dataset) : null;
    const catalog = id === null ? null : await datasetCatalog(id);
    if (!catalog) return json({ error: "Player data not found." }, 404);
    return new NextResponse(JSON.stringify(catalog), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return problem(error);
  }
}
