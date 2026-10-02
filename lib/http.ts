import { NextRequest, NextResponse } from "next/server";
import { DraftError } from "./engine";
import { ZodError } from "zod";
import { timingSafeEqual } from "node:crypto";

export const cookieName = (id: string) => `nba_${id}`;
export function json(
  data: unknown,
  status = 200,
  credential?: { id: string; token: string },
) {
  const response = NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
  if (credential)
    response.cookies.set(cookieName(credential.id), credential.token, {
      httpOnly: true,
      secure:
        process.env.NODE_ENV === "production" && process.env.VERCEL === "1",
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 86400,
    });
  return response;
}
export async function body(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== request.headers.get("host"))
    throw new DraftError("Use the room's own page for this action.", 403);
  const text = await request.text();
  if (text.length > 32000) throw new DraftError("Request is too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new DraftError("Request must contain valid JSON.", 400);
  }
}
export function problem(error: unknown) {
  if (error instanceof DraftError)
    return json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return json(
      { error: error.issues.map((issue) => issue.message).join(" ") },
      400,
    );
  const { name, code, message } = error as {
    name?: string;
    code?: string;
    message?: string;
  };
  console.error("Room request failed", { name, code, message });
  return json(
    {
      error:
        "The server cannot load or save this room. Check the connection and try again; your draft stays in Postgres.",
    },
    503,
  );
}
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when that variable is set.
export function cronAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret)
    return json({ error: "Scheduled jobs are not configured." }, 503);
  const expected = Buffer.from(`Bearer ${secret}`),
    received = Buffer.from(request.headers.get("authorization") ?? "");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return json({ error: "Not authorized." }, 401);
}
