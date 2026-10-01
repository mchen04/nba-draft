import { NextRequest } from "next/server";
import { actionSchema, transactRoom } from "@/lib/engine";
import { body, cookieName, json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const result = await transactRoom(
      id,
      request.cookies.get(cookieName(id))?.value,
    );
    return json(
      request.nextUrl.searchParams.get("catalog") === "1"
        ? result.room.catalog
        : result.view,
    );
  } catch (error) {
    return problem(error);
  }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const action = actionSchema.parse(await body(request));
    const result = await transactRoom(
      id,
      request.cookies.get(cookieName(id))?.value,
      action,
    );
    return json(
      { ...result.view, recoveryCode: result.recoveryCode },
      200,
      result.token ? { id, token: result.token } : undefined,
    );
  } catch (error) {
    return problem(error);
  }
}
