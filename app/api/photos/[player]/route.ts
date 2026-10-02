import { NextRequest, NextResponse } from "next/server";
import { photoFallback, readPhoto } from "@/lib/photos";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ player: string }> },
) {
  const { player } = await context.params;
  if (!/^[1-9][0-9]{0,9}$/.test(player))
    return new NextResponse(null, { status: 404 });
  try {
    const photo = await readPhoto(Number(player));
    const headers = {
      "Content-Type": photo?.content_type ?? "image/svg+xml",
      "Cache-Control": photo
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "CDN-Cache-Control": photo
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "X-Photo-Cache": photo?.status ?? "pending",
      ...(photo?.digest ? { ETag: `"${photo.digest}"` } : {}),
    };
    if (photo?.digest && request.headers.get("if-none-match") === headers.ETag)
      return new NextResponse(null, { status: 304, headers });
    return new NextResponse(
      photo?.image ? new Uint8Array(photo.image) : photoFallback,
      { headers },
    );
  } catch {
    return new NextResponse(photoFallback, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
    });
  }
}
