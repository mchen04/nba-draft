import { NextRequest, NextResponse } from "next/server";
import { datasetCatalog } from "@/lib/espn";
import { json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
// The URL names the pool's digest, so its content never changes. Browsers and the
// Vercel CDN keep it for a year; Vercel caches a function response only with a CDN directive.
const forever = "public, max-age=31536000, immutable";
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ dataset: string; digest: string }> },
) {
  try {
    const { dataset, digest } = await context.params;
    const id = /^[1-9][0-9]{0,15}$/.test(dataset) ? Number(dataset) : null;
    const catalog =
      id === null || !/^[0-9a-f]{64}$/.test(digest)
        ? null
        : await datasetCatalog(id);
    if (catalog?.digest !== digest)
      return json({ error: "Player data not found." }, 404);
    return new NextResponse(JSON.stringify(catalog), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": forever,
        "CDN-Cache-Control": forever,
      },
    });
  } catch (error) {
    return problem(error);
  }
}
