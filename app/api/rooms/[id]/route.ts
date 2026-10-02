import { NextRequest } from "next/server";
import { actionSchema, pollRoom, transactRoom } from "@/lib/engine";
import { body, cookieName, json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params;
    const token = request.cookies.get(cookieName(id))?.value;
    // Tabs loaded before shared datasets still ask for players here.
    if (request.nextUrl.searchParams.get("catalog") === "1")
      return json((await transactRoom(id, token)).room.catalog);
    const since = request.nextUrl.searchParams.get("since");
    return json(
      await pollRoom(
        id,
        token,
        since && /^[0-9]{1,9}$/.test(since) ? Number(since) : undefined,
      ),
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
